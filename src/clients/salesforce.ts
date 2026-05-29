import type { Config } from "../config.js";
import type { TokenStore } from "../auth/tokenStore.js";
import { fetchJson, fetchWithRetry, HttpError } from "./http.js";

/**
 * Salesforce API client.
 *
 * [NEEDS LIVE VERIFICATION] All endpoint shapes, auth flows, and limits are from model
 * knowledge — confirm against https://developer.salesforce.com before production:
 *   - REST: `/services/data/{version}/sobjects/{Object}`
 *   - Upsert by External ID: PATCH `/sobjects/{Object}/{ExtIdField}/{value}` (idempotent)
 *   - Bulk API 2.0 for high-volume line items
 *   - SOQL query: `/services/data/{version}/query?q=...`
 *   - JWT Bearer flow for server-to-server auth
 *
 * Idempotency strategy [VERIFIED requirement → SF mechanism NEEDS VERIFICATION]:
 * we use upsert-by-External-ID so re-delivered Procore events are safe to replay.
 */

const TENANT = "default";

export class SalesforceClient {
  constructor(
    private readonly cfg: Config,
    private readonly tokens: TokenStore,
    /** Delay between Bulk-job status polls (ms). Lowered in tests for speed. */
    private readonly pollDelayMs = 2000,
  ) {}

  private async session(): Promise<{ accessToken: string; instanceUrl: string }> {
    const tok = await this.tokens.get(TENANT, "salesforce");
    if (!tok?.instanceUrl) {
      throw new Error("No Salesforce session for tenant; complete OAuth/JWT auth first (Phase 1).");
    }
    // TODO Phase 1: JWT-bearer re-auth when expired (SF access tokens have no refresh in JWT flow;
    // you re-mint a fresh assertion). For web-server flow, use refresh_token grant.
    return { accessToken: tok.accessToken, instanceUrl: tok.instanceUrl };
  }

  private async headers(): Promise<Record<string, string>> {
    const { accessToken } = await this.session();
    return { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" };
  }

  private base(instanceUrl: string): string {
    return `${instanceUrl}/services/data/${this.cfg.salesforce.apiVersion}`;
  }

  /** SOQL query. */
  async query<T = unknown>(soql: string): Promise<{ records: T[]; done: boolean; nextRecordsUrl?: string }> {
    const { instanceUrl } = await this.session();
    const url = `${this.base(instanceUrl)}/query?q=${encodeURIComponent(soql)}`;
    return fetchJson(url, { headers: await this.headers() });
  }

  /**
   * Upsert a record by External ID field — the idempotency keystone.
   * PATCH is create-or-update: safe to call repeatedly with the same external id.
   */
  async upsertByExternalId(
    sobject: string,
    externalIdField: string,
    externalId: string,
    fields: Record<string, unknown>,
  ): Promise<{ id: string; created: boolean; success: boolean }> {
    const { instanceUrl } = await this.session();
    const url = `${this.base(instanceUrl)}/sobjects/${enc(sobject)}/${enc(externalIdField)}/${enc(externalId)}`;
    return fetchJson(url, {
      method: "PATCH",
      headers: await this.headers(),
      body: JSON.stringify(fields),
    });
  }

  /** SOSL search across Accounts & Contacts. [NEEDS LIVE VERIFICATION] SOSL shape. */
  async search<T = unknown>(query: string): Promise<{ searchRecords: T[] }> {
    const { instanceUrl } = await this.session();
    // Escape SOSL reserved characters to prevent search-string injection.
    const escaped = query.replace(/[?&|!{}()^~*:\\"'+[\]-]/g, "\\$&");
    const sosl = `FIND {${escaped}} IN ALL FIELDS RETURNING Account(Id,Name), Contact(Id,Name,Email)`;
    const url = `${this.base(instanceUrl)}/search?q=${encodeURIComponent(sosl)}`;
    return fetchJson(url, { headers: await this.headers() });
  }

  async getRecord<T = unknown>(sobject: string, id: string, fields?: string[]): Promise<T> {
    const { instanceUrl } = await this.session();
    const qs = fields?.length ? `?fields=${fields.map(encodeURIComponent).join(",")}` : "";
    return fetchJson(`${this.base(instanceUrl)}/sobjects/${enc(sobject)}/${enc(id)}${qs}`, { headers: await this.headers() });
  }

  async createRecord(sobject: string, fields: Record<string, unknown>): Promise<{ id: string; success: boolean }> {
    const { instanceUrl } = await this.session();
    return fetchJson(`${this.base(instanceUrl)}/sobjects/${enc(sobject)}`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(fields),
    });
  }

  /**
   * Simple bulk upsert: one REST upsert per record. Fine for small batches; for large volumes use
   * `bulkUpsertJob` (Bulk API 2.0). Kept for convenience and low-latency small writes.
   */
  async bulkUpsert(
    sobject: string,
    externalIdField: string,
    records: Array<Record<string, unknown> & { __externalId: string }>,
  ): Promise<{ processed: number }> {
    let processed = 0;
    for (const rec of records) {
      const { __externalId, ...fields } = rec;
      await this.upsertByExternalId(sobject, externalIdField, __externalId, fields);
      processed += 1;
    }
    return { processed };
  }

  /**
   * Real Bulk API 2.0 upsert job: create job → upload CSV → mark UploadComplete → poll once.
   * The right tool for high-volume objects (budget/contract line items).
   * [NEEDS LIVE VERIFICATION] endpoint paths & state names against live Salesforce docs.
   */
  async bulkUpsertJob(
    sobject: string,
    externalIdField: string,
    records: Array<Record<string, unknown> & { __externalId: string }>,
  ): Promise<{ jobId: string; state: string; processed: number }> {
    const { instanceUrl } = await this.session();
    const base = `${this.base(instanceUrl)}/jobs/ingest`;
    const headers = await this.headers();

    const job = await fetchJson<{ id: string }>(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        object: sobject,
        operation: "upsert",
        externalIdFieldName: externalIdField,
        contentType: "CSV",
        lineEnding: "LF",
      }),
    });

    const csv = recordsToCsv(records, externalIdField);
    const put = await fetchWithRetry(`${base}/${job.id}/batches`, {
      method: "PUT",
      headers: { ...headers, "content-type": "text/csv" },
      body: csv,
    });
    if (!put.ok) throw new HttpError(put.status, await put.text(), `${base}/${job.id}/batches`);

    await fetchJson(`${base}/${job.id}`, { method: "PATCH", headers, body: JSON.stringify({ state: "UploadComplete" }) });

    // Poll until the job reaches a terminal state (Salesforce processes asynchronously).
    const terminal = new Set(["JobComplete", "Failed", "Aborted"]);
    let status: { state: string; numberRecordsProcessed?: number } = { state: "UploadComplete" };
    for (let attempt = 0; attempt < 20; attempt++) {
      status = await fetchJson(`${base}/${job.id}`, { headers });
      if (terminal.has(status.state)) break;
      await sleep(this.pollDelayMs);
    }
    if (status.state !== "JobComplete") {
      throw new HttpError(502, `Bulk job ${job.id} ended in state ${status.state}`, `${base}/${job.id}`);
    }
    return { jobId: job.id, state: status.state, processed: status.numberRecordsProcessed ?? records.length };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Encode a URL path component to prevent traversal/injection. */
const enc = (v: string | number): string => encodeURIComponent(String(v));

/** Serialize records to CSV for Bulk API 2.0. The external id column is named `externalIdField`. */
function recordsToCsv(
  records: Array<Record<string, unknown> & { __externalId: string }>,
  externalIdField: string,
): string {
  const fieldKeys = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) if (k !== "__externalId") fieldKeys.add(k);
  const cols = [externalIdField, ...fieldKeys];
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of records) {
    lines.push(cols.map((c) => esc(c === externalIdField ? r.__externalId : Reflect.get(r, c))).join(","));
  }
  return lines.join("\n");
}
