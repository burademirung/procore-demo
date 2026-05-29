import type { Config } from "../config.js";
import type { TokenStore } from "../auth/tokenStore.js";
import { fetchJson, fetchWithRetry, HttpError } from "./http.js";

/**
 * Procore API client.
 *
 * [VERIFIED] Procore Webhooks API: two-tier hook + trigger model, scoped per request
 * (company_id OR project_id). See createWebhookHook / addWebhookTrigger below.
 *
 * [NEEDS LIVE VERIFICATION] Everything else — REST versioning (v1.0/v1.1/v2.0), OAuth
 * token endpoint/lifetimes, pagination scheme, and the exact resource paths — is from
 * model knowledge and MUST be confirmed against https://developers.procore.com before
 * relying on it. Paths are centralized in PATHS so they are cheap to correct.
 */

// Centralized so a single edit fixes a path everywhere once verified against live docs.
const PATHS = {
  token: "/oauth/token",
  // REST resources. NOTE: many Procore endpoints are company- or project-scoped via
  // query params or path segments; confirm the exact shape per resource.
  companies: "/rest/v1.0/companies",
  projects: "/rest/v1.0/projects",
  projectUsers: "/rest/v1.0/projects/{projectId}/users",
  vendors: "/rest/v1.0/vendors",
  primeContracts: "/rest/v1.0/prime_contracts",
  commitments: "/rest/v1.0/commitments",
  changeOrders: "/rest/v1.0/change_orders",
  rfis: "/rest/v1.0/projects/{projectId}/rfis",
  submittals: "/rest/v1.0/projects/{projectId}/submittals",
  // Webhooks (two-tier). [VERIFIED] structure.
  hooks: "/rest/v1.0/webhooks/hooks",
  triggers: "/rest/v1.0/webhooks/hooks/{hookId}/triggers",
} as const;

const TENANT = "default"; // single-tenant placeholder; thread real tenant id in Phase 1.

/** Encode a path component to prevent traversal / injection in constructed URLs. */
const enc = (v: string | number): string => encodeURIComponent(String(v));

export interface ProcoreWebhookTrigger {
  resource_name: string; // e.g. "Projects", "RfiS"
  event_type: "create" | "update" | "delete";
}

export class ProcoreClient {
  constructor(
    private readonly cfg: Config,
    private readonly tokens: TokenStore,
  ) {}

  // ── Auth ──────────────────────────────────────────────────────────────────
  /**
   * Return a valid access token, refreshing if expired.
   * [NEEDS LIVE VERIFICATION] refresh-token grant + response shape.
   */
  private async accessToken(): Promise<string> {
    const tok = await this.tokens.get(TENANT, "procore");
    if (!tok) throw new Error("No Procore token for tenant; complete OAuth first (Phase 1).");
    const expired = tok.expiresAt !== undefined && tok.expiresAt < Date.now() + 60_000;
    if (!expired) return tok.accessToken;
    if (!tok.refreshToken) throw new Error("Procore token expired and no refresh token available.");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tok.refreshToken,
      client_id: this.cfg.procore.clientId ?? "",
      client_secret: this.cfg.procore.clientSecret ?? "",
    });
    const json = await fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    }>(`${this.cfg.procore.authBase}${PATHS.token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    await this.tokens.set(TENANT, "procore", {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? tok.refreshToken,
      expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
    });
    return json.access_token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.accessToken()}`,
      accept: "application/json",
    };
    // Procore requires a company id header for many company-scoped endpoints.
    if (this.cfg.procore.companyId) headers["Procore-Company-Id"] = this.cfg.procore.companyId;
    return headers;
  }

  private url(path: string, params?: Record<string, string | number | undefined>): string {
    let p = path;
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined) continue;
      if (p.includes(`{${k}}`)) p = p.replace(`{${k}}`, String(v));
      else query.set(k, String(v));
    }
    const qs = query.toString();
    return `${this.cfg.procore.apiBase}${p}${qs ? `?${qs}` : ""}`;
  }

  // ── Generic GET with page-based pagination ──────────────────────────────────
  /**
   * [NEEDS LIVE VERIFICATION] Procore paginates with `page` + `per_page` and exposes a
   * Link header / Total header. Confirm and adjust hasMore detection.
   */
  async *paginate<T>(path: string, params: Record<string, string | number | undefined> = {}): AsyncGenerator<T> {
    let page = 1;
    const perPage = 100;
    for (;;) {
      const res = await fetchWithRetry(this.url(path, { ...params, page, per_page: perPage }), {
        headers: await this.authHeaders(),
      });
      if (!res.ok) throw new HttpError(res.status, await res.text(), res.url);
      const items = (await res.json()) as T[];
      for (const item of items) yield item;
      if (items.length < perPage) return;
      page += 1;
    }
  }

  async listProjects(): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const p of this.paginate(PATHS.projects, { company_id: this.cfg.procore.companyId })) out.push(p);
    return out;
  }

  async getProject(projectId: string | number): Promise<unknown> {
    return fetchJson(this.url(`${PATHS.projects}/${enc(projectId)}`), { headers: await this.authHeaders() });
  }

  async listCompanies(): Promise<unknown[]> {
    return fetchJson(this.url(PATHS.companies), { headers: await this.authHeaders() });
  }

  /** Search projects by name/number for the active company. [NEEDS LIVE VERIFICATION] filter param. */
  async search(query: string): Promise<unknown[]> {
    return fetchJson(
      this.url(PATHS.projects, { company_id: this.cfg.procore.companyId, "filters[search]": query }),
      { headers: await this.authHeaders() },
    );
  }

  /** Get a top-level record by id (e.g. a project or company). [NEEDS LIVE VERIFICATION] */
  async getById(segment: string, id: string | number): Promise<unknown> {
    return fetchJson(this.url(`/rest/v1.0/${enc(segment)}/${enc(id)}`), { headers: await this.authHeaders() });
  }

  /** List a project-scoped collection (e.g. "commitments", "change_orders"). [NEEDS LIVE VERIFICATION] */
  async listProjectResource(segment: string, projectId: string | number): Promise<unknown[]> {
    return fetchJson(this.url(`/rest/v1.0/projects/${enc(projectId)}/${enc(segment)}`), { headers: await this.authHeaders() });
  }

  /** Get one project-scoped record (e.g. an RFI). [NEEDS LIVE VERIFICATION] */
  async getProjectResource(segment: string, projectId: string | number, id: string | number): Promise<unknown> {
    return fetchJson(this.url(`/rest/v1.0/projects/${enc(projectId)}/${enc(segment)}/${enc(id)}`), {
      headers: await this.authHeaders(),
    });
  }

  /** Create a top-level record (e.g. a project from a won Salesforce opportunity). [NEEDS LIVE VERIFICATION] */
  async create(segment: string, body: Record<string, unknown>): Promise<{ id: number }> {
    return fetchJson(this.url(`/rest/v1.0/${enc(segment)}`), {
      method: "POST",
      headers: { ...(await this.authHeaders()), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ── Webhooks (two-tier). [VERIFIED] model ────────────────────────────────────
  /** Step 1: create a hook (endpoint + scope). Scope is company- OR project-level. */
  async createWebhookHook(input: {
    apiVersion?: string;
    deliveryUrl: string;
    companyId?: string | number;
    projectId?: string | number;
  }): Promise<{ id: number }> {
    const payload: Record<string, unknown> = {
      hook: {
        api_version: input.apiVersion ?? "v1.0",
        destination_url: input.deliveryUrl,
      },
    };
    if (input.companyId !== undefined) payload.company_id = input.companyId;
    if (input.projectId !== undefined) payload.project_id = input.projectId;
    return fetchJson(this.url(PATHS.hooks), {
      method: "POST",
      headers: { ...(await this.authHeaders()), "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /** Step 2: add one or more triggers (resource_name + event_type) to a hook. */
  async addWebhookTrigger(hookId: number, trigger: ProcoreWebhookTrigger): Promise<unknown> {
    return fetchJson(this.url(PATHS.triggers, { hookId }), {
      method: "POST",
      headers: { ...(await this.authHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ trigger }),
    });
  }
}
