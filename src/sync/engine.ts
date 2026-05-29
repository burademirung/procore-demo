import type { ProcoreClient } from "../clients/procore.js";
import type { SalesforceClient } from "../clients/salesforce.js";
import type { DedupStore } from "./dedup.js";
import {
  mappingForProcoreResource,
  mappingForSalesforceObject,
  mappingByKey,
  procoreToSalesforce,
  salesforceToProcore,
  MAPPINGS,
  LEGAL_MAPPING_KEYS,
  FINANCIAL_MAPPING_KEYS,
} from "../mapping/mappings.js";
import type { AuditLog } from "./audit.js";
import { hashFields, type LinkStore } from "./linkStore.js";

export type SyncAction = "upsert" | "create" | "soft_delete";
export type LogLevel = "debug" | "info" | "warning" | "error";

/** Optional dependencies for richer behavior (audit trail, real-time notifications, logging, link/hash store). */
export interface SyncEngineOptions {
  audit?: AuditLog;
  links?: LinkStore;
  /** Called after a successful write so the host can emit MCP resources/updated + list_changed. */
  onSynced?: (info: { system: "procore" | "salesforce"; object: string; externalId: string; action: SyncAction }) => void;
  /** Structured logger so the host can forward MCP logging/message notifications. */
  log?: (level: LogLevel, message: string, data?: Record<string, unknown>) => void;
}

/** Salesforce Change Data Capture event (inbound SF → Procore). */
export interface SalesforceChangeEvent {
  id: string;
  sobject: string;
  changeType: "CREATE" | "UPDATE" | "DELETE";
  fields: Record<string, unknown>;
}

/** Procore webhook resource_name → REST path segment. */
const RESOURCE_SEGMENT: Record<string, string> = {
  Projects: "projects",
  Companies: "companies",
  Users: "users",
  // Legal documents (featured vertical)
  ContractDocuments: "contract_documents",
  InsuranceCertificates: "insurance_certificates",
  LienWaivers: "lien_waivers",
  ComplianceDocuments: "compliance_documents",
  // Financial documents
  PrimeContracts: "prime_contracts",
  Commitments: "commitments",
  ChangeOrders: "change_orders",
  Invoices: "invoices",
  RfiS: "rfis",
  Submittals: "submittals",
};

/** Resources fetched under a project (`/projects/{pid}/{segment}/{id}`) vs. top-level (`/{segment}/{id}`). */
const PROJECT_SCOPED = new Set([
  "ContractDocuments",
  "InsuranceCertificates",
  "LienWaivers",
  "ComplianceDocuments",
  "PrimeContracts",
  "Commitments",
  "ChangeOrders",
  "Invoices",
  "RfiS",
  "Submittals",
]);

/** REST path segment for a mapping's Procore resource. */
function segmentFor(resourceName: string): string {
  return RESOURCE_SEGMENT[resourceName] ?? resourceName.toLowerCase();
}

// Fail fast on drift between the mapping registry and these engine-local tables. Without this, a new
// mapping silently falls back to `.toLowerCase()` for its URL segment or is wrongly treated as
// top-level (missing from PROJECT_SCOPED), producing wrong endpoints at runtime instead of at boot.
for (const m of MAPPINGS) {
  if (!(m.procoreResource in RESOURCE_SEGMENT)) {
    throw new Error(`Mapping "${m.key}": procoreResource "${m.procoreResource}" has no RESOURCE_SEGMENT entry`);
  }
  if (m.projectIdField && !PROJECT_SCOPED.has(m.procoreResource)) {
    throw new Error(`Mapping "${m.key}": has projectIdField but "${m.procoreResource}" is not in PROJECT_SCOPED`);
  }
}

/**
 * Read an own property from a (possibly attacker-controlled) CDC field bag, never traversing the
 * prototype chain — so a `__proto__`/`constructor` key in the payload can't leak inherited values.
 */
function readField(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? Reflect.get(obj, key) : undefined;
}

/** A value safe to interpolate into a Procore URL path (a record/project id). */
function isIdLike(v: unknown): v is string | number {
  return (typeof v === "string" && v.length > 0) || (typeof v === "number" && Number.isFinite(v));
}

/**
 * Sync engine — the bridge between the two providers.
 *
 * Design (spec §1): MCP tool calls are agent-driven and synchronous, but durable sync
 * must be async. The verified Procore webhook contract (at-least-once, 5s timeout) forces
 * the inbound path to: return 2xx fast → enqueue → dedup → reconcile out of band.
 *
 * This Phase-0 engine implements the reconcile step directly (no external queue yet) so
 * the logic is unit-testable; Phase 4 swaps `handleWebhook` to enqueue and runs `reconcile`
 * from a queue consumer / cron.
 */

/** Shape of a Procore webhook delivery. [NEEDS LIVE VERIFICATION] exact payload fields. */
export interface ProcoreWebhookEvent {
  id: string; // event id / ULID — dedup anchor [VERIFIED requirement]
  resource_name: string; // e.g. "Projects"
  event_type: "create" | "update" | "delete";
  resource_id: number;
  company_id?: number;
  project_id?: number;
  timestamp?: string;
}

export interface SyncResult {
  status: "synced" | "skipped_duplicate" | "skipped_unchanged" | "deleted" | "no_mapping" | "ignored";
  detail?: string;
}

export class SyncEngine {
  private notifier?: SyncEngineOptions["onSynced"];
  private logger?: SyncEngineOptions["log"];

  constructor(
    private readonly procore: ProcoreClient,
    private readonly salesforce: SalesforceClient,
    private readonly dedup: DedupStore,
    private readonly opts: SyncEngineOptions = {},
  ) {
    this.notifier = opts.onSynced;
    this.logger = opts.log;
  }

  /** Register/replace the real-time notifier after construction (used to wire MCP resources/updated). */
  setNotifier(fn: SyncEngineOptions["onSynced"]): void {
    this.notifier = fn;
  }

  /** Register/replace the structured logger after construction (used to wire MCP logging/message). */
  setLogger(fn: SyncEngineOptions["log"]): void {
    this.logger = fn;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    this.logger?.(level, message, data);
  }

  private notify(system: "procore" | "salesforce", object: string, externalId: string, action: SyncAction): void {
    this.opts.audit?.record({ action, system, object, externalId, status: "ok", at: Date.now() });
    this.log("info", `${action} ${system}:${object}#${externalId}`, { externalId });
    this.notifier?.({ system, object, externalId, action });
  }

  /** Fetch the canonical Procore record for an event, using the right endpoint for its resource. */
  private fetchProcoreRecord(event: ProcoreWebhookEvent, mapping: { procoreResource: string }): Promise<unknown> {
    const segment = segmentFor(mapping.procoreResource);
    if (PROJECT_SCOPED.has(mapping.procoreResource)) {
      if (event.project_id === undefined) {
        // Project-scoped resources can't be fetched without a project id — fail loudly rather
        // than hit a non-existent top-level endpoint.
        throw new Error(`Webhook for ${mapping.procoreResource}#${event.resource_id} is missing project_id`);
      }
      return this.procore.getProjectResource(segment, event.project_id, event.resource_id);
    }
    return this.procore.getById(segment, event.resource_id);
  }

  /**
   * Inbound Procore → Salesforce.
   * Returns quickly; the caller (HTTP handler) must respond 2xx within 5s regardless of
   * downstream success — actual reconciliation should move to a queue in Phase 4.
   */
  async handleProcoreWebhook(event: ProcoreWebhookEvent): Promise<SyncResult> {
    // 1. Dedup — at-least-once delivery means replays are expected. [VERIFIED]
    const isNew = await this.dedup.markIfNew(event.id);
    if (!isNew) return { status: "skipped_duplicate" };

    // 2. Resolve mapping for this resource.
    const mapping = mappingForProcoreResource(event.resource_name);
    if (!mapping) return { status: "no_mapping", detail: event.resource_name };
    if (mapping.direction === "sf_to_procore") return { status: "ignored", detail: "wrong direction" };

    const externalId = String(event.resource_id);

    // 3. Deletes → soft-delete in Salesforce (spec §5: preserve CRM history).
    if (event.event_type === "delete") {
      await this.salesforce.upsertByExternalId(mapping.salesforceObject, mapping.sfExternalIdField, externalId, {
        Procore_Deleted__c: true,
      });
      this.notify("salesforce", mapping.salesforceObject, externalId, "soft_delete");
      return { status: "deleted" };
    }

    // 4. Fetch the full record from Procore (correct endpoint per resource type), map.
    const procoreRecord = (await this.fetchProcoreRecord(event, mapping)) as Record<string, unknown>;
    const sfFields = procoreToSalesforce(mapping, procoreRecord);
    const digest = hashFields(sfFields);

    // 5. Skip no-op writes (nothing changed since the last sync).
    if (this.opts.links) {
      const link = await this.opts.links.get(mapping.key, externalId);
      if (link?.lastHash === digest) return { status: "skipped_unchanged", detail: externalId };
    }

    // 6. Upsert into Salesforce; record the link/hash + emit audit/notification.
    const res = await this.salesforce.upsertByExternalId(mapping.salesforceObject, mapping.sfExternalIdField, externalId, sfFields);
    if (this.opts.links) {
      await this.opts.links.set(mapping.key, { procoreId: externalId, salesforceId: (res as { id?: string }).id, lastHash: digest });
    }
    this.notify("salesforce", mapping.salesforceObject, externalId, "upsert");
    return { status: "synced", detail: `${mapping.procoreResource}#${externalId}` };
  }

  /**
   * Inbound Salesforce → Procore via Change Data Capture. dedup → map → CREATE/UPDATE in Procore.
   * Only mappings with direction bidirectional/sf_to_procore participate.
   *
   * Reverse identity: the Procore record id is carried on the SF record's External Id field
   * (`sfExternalIdField`); project-scoped resources also carry the Procore project id in
   * `projectIdField`. A CREATE event without a Procore id creates; any event that already carries a
   * Procore id is an idempotent UPDATE-by-id (so a replayed/duplicate CREATE can't double-insert).
   *
   * **DELETE is intentionally NOT propagated.** Procore is the document system of record; a CRM-side
   * delete must never destroy it (this mirrors the forward path's soft-delete intent — neither side
   * hard-destroys the other's source data). Field-level conflict resolution (`src/sync/conflict.ts`)
   * is a deliberate per-org policy and is NOT yet enforced on this path — reverse writes are
   * last-writer-wins; the forward hash-skip reconciles the resulting echo in one pass.
   * [NEEDS LIVE VERIFICATION] the Procore write endpoints/verbs (see ProcoreClient write methods).
   */
  async handleSalesforceChange(event: SalesforceChangeEvent): Promise<SyncResult> {
    const isNew = await this.dedup.markIfNew(event.id);
    if (!isNew) return { status: "skipped_duplicate" };

    const mapping = mappingForSalesforceObject(event.sobject);
    if (!mapping) return { status: "no_mapping", detail: event.sobject };
    if (mapping.direction === "procore_to_sf") return { status: "ignored", detail: "wrong direction" };

    const segment = segmentFor(mapping.procoreResource);
    const projectScoped = PROJECT_SCOPED.has(mapping.procoreResource);

    // DELETE never flows SF → Procore: protect the system of record (see method docs).
    if (event.changeType === "DELETE") {
      this.log("warning", `reverse DELETE ignored for ${mapping.salesforceObject} — Procore is the system of record`);
      return { status: "ignored", detail: "reverse delete not propagated (Procore is the system of record)" };
    }

    // Project-scoped reverse writes need the Procore project id, carried on the SF record. Validate
    // it's a real id (string/number) — never interpolate an object/array/bool into a URL path.
    const projectId = projectScoped && mapping.projectIdField ? readField(event.fields, mapping.projectIdField) : undefined;
    if (projectScoped && !isIdLike(projectId)) {
      this.log("warning", `reverse sync ignored: ${mapping.salesforceObject} has no valid ${mapping.projectIdField}`);
      return { status: "ignored", detail: `reverse sync needs a valid ${mapping.projectIdField} (Procore project id)` };
    }
    const pid = projectId as string | number;

    // Build the Procore field bag; never send the project id in the body — it lives in the URL path.
    const procoreFields = salesforceToProcore(mapping, event.fields);
    if (mapping.projectIdField) {
      const pf = mapping.fields.find((f) => f.salesforce === mapping.projectIdField);
      if (pf) delete procoreFields[pf.procore];
    }

    const procoreId = readField(event.fields, mapping.sfExternalIdField);
    const hasId = isIdLike(procoreId);

    // CREATE only when there is no existing Procore id; otherwise upsert-by-id (idempotent).
    if (event.changeType === "CREATE" && !hasId) {
      const created = projectScoped
        ? await this.procore.createProjectResource(segment, pid, procoreFields)
        : await this.procore.create(segment, procoreFields);
      this.notify("procore", mapping.procoreResource, String(created.id), "create");
      return { status: "synced", detail: `${mapping.salesforceObject}→${segment}#${created.id}` };
    }

    // UPDATE (or a CREATE that already carries a Procore id → idempotent update, never a duplicate).
    if (!hasId) {
      return { status: "ignored", detail: `reverse update requires ${mapping.sfExternalIdField}` };
    }
    const rid = procoreId as string | number;

    // Skip a no-op reverse write (e.g. the CDC echo of our own forward sync) and keep the link hash
    // current, so the forward webhook that follows this write doesn't bounce the same value back.
    // NOTE: this hash covers only the fields present on the event; Salesforce CDC sends PARTIAL
    // update payloads, so this is a best-effort echo suppressor, not a guarantee — production should
    // use CDC `changeOrigin` for authoritative loop suppression (see SPEC §8a).
    const sfBag: Record<string, unknown> = {};
    for (const f of mapping.fields) {
      if (Object.prototype.hasOwnProperty.call(event.fields, f.salesforce)) sfBag[f.salesforce] = readField(event.fields, f.salesforce);
    }
    const digest = hashFields(sfBag);
    const link = this.opts.links ? await this.opts.links.get(mapping.key, String(rid)) : undefined;
    if (link?.lastHash === digest) return { status: "skipped_unchanged", detail: String(rid) };

    if (projectScoped) await this.procore.updateProjectResource(segment, pid, rid, procoreFields);
    else await this.procore.update(segment, rid, procoreFields);
    if (this.opts.links) {
      await this.opts.links.set(mapping.key, {
        procoreId: String(rid),
        ...(link?.salesforceId ? { salesforceId: link.salesforceId } : {}),
        lastHash: digest,
      });
    }
    this.notify("procore", mapping.procoreResource, String(rid), "upsert");
    return { status: "synced", detail: `${mapping.salesforceObject}→${segment}#${rid}` };
  }

  /**
   * Reconciliation backstop (spec §5): periodic delta sweep that catches webhook drops
   * (at-least-once ≠ exactly-once). Phase 5 wires this to a cron trigger.
   */
  async reconcileProjects(signal?: AbortSignal): Promise<{ scanned: number; upserted: number; failed: number; cancelled?: boolean }> {
    const mapping = mappingForProcoreResource("Projects");
    if (!mapping) return { scanned: 0, upserted: 0, failed: 0 };
    const projects = (await this.procore.listProjects()) as Array<Record<string, unknown>>;
    this.log("info", `reconcile: scanning ${projects.length} projects`);
    let upserted = 0;
    let failed = 0;
    for (const project of projects) {
      if (signal?.aborted) {
        this.log("warning", `reconcile cancelled after ${upserted}/${projects.length}`);
        return { scanned: projects.length, upserted, failed, cancelled: true };
      }
      const id = project.id;
      if (id === undefined) continue;
      // Best-effort: one bad record must not abort the whole sweep (the sweep IS the recovery path).
      try {
        await this.salesforce.upsertByExternalId(
          mapping.salesforceObject,
          mapping.sfExternalIdField,
          String(id),
          procoreToSalesforce(mapping, project),
        );
        upserted += 1;
      } catch (e) {
        failed += 1;
        this.log("error", `reconcile: failed project ${String(id)}`, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.log("info", `reconcile: upserted ${upserted}/${projects.length} (failed ${failed})`);
    return { scanned: projects.length, upserted, failed };
  }

  /**
   * Sync a project's legal documents (contracts, insurance certificates, lien waivers and
   * compliance records) into their Salesforce custom objects via External-Id upsert. This is
   * the featured vertical: it gives the legal/CRM side a live, queryable mirror of every
   * executed agreement and its status. Returns per-object counts. Same machinery as financials.
   */
  async syncLegalDocuments(projectId: string | number, signal?: AbortSignal): Promise<{ synced: number; byObject: Record<string, number>; errors?: string[] }> {
    return this.syncProjectVertical(LEGAL_MAPPING_KEYS, projectId, signal);
  }

  /**
   * Sync a project's financial objects (prime contracts, commitments, change orders, invoices)
   * into their Salesforce custom objects via per-record REST upsert. For high-volume line items,
   * SalesforceClient.bulkUpsertJob (Bulk API 2.0) is the better tool. Returns per-object counts.
   */
  async syncFinancials(projectId: string | number, signal?: AbortSignal): Promise<{ synced: number; byObject: Record<string, number>; errors?: string[] }> {
    return this.syncProjectVertical(FINANCIAL_MAPPING_KEYS, projectId, signal);
  }

  /**
   * Shared driver for a project-scoped document vertical: for each mapping key, list the Procore
   * collection under the project, map each record to Salesforce fields, and bulk-upsert by
   * External Id. Records without an id are skipped (no stable upsert key); an empty collection
   * skips the Salesforce write entirely. Honors AbortSignal between collections.
   */
  private async syncProjectVertical(
    keys: readonly string[],
    projectId: string | number,
    signal?: AbortSignal,
  ): Promise<{ synced: number; byObject: Record<string, number>; errors?: string[] }> {
    const byObject: Record<string, number> = {};
    const errors: string[] = [];
    let synced = 0;
    for (const key of keys) {
      if (signal?.aborted) break;
      const m = mappingByKey(key);
      if (!m) continue;
      // One failing object type must not abandon the rest of the vertical; record the error and
      // report a per-object count of what ACTUALLY synced (not what was attempted).
      try {
        const records = (await this.procore.listProjectResource(segmentFor(m.procoreResource), projectId)) as Array<Record<string, unknown>>;
        const rows = records
          .filter((r) => r.id !== undefined)
          .map((r) => {
            const sf = procoreToSalesforce(m, r);
            // Stamp the project id so the SF record round-trips for bidirectional reverse sync.
            if (m.projectIdField) sf[m.projectIdField] = String(projectId);
            return { __externalId: String(r.id), ...sf };
          });
        const { processed, failed } = rows.length
          ? await this.salesforce.bulkUpsert(m.salesforceObject, m.sfExternalIdField, rows)
          : { processed: 0, failed: 0 };
        byObject[m.salesforceObject] = processed;
        synced += processed;
        if (failed > 0) errors.push(`${m.salesforceObject}: ${failed} record(s) failed`);
      } catch (e) {
        byObject[m.salesforceObject] = 0;
        errors.push(`${m.salesforceObject}: ${e instanceof Error ? e.message : String(e)}`);
        this.log("error", `vertical sync failed for ${m.salesforceObject}`, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { synced, byObject, ...(errors.length ? { errors } : {}) };
  }

  /** Create a Salesforce Case from a Procore RFI (project-scoped). */
  async createCaseFromRfi(
    projectId: string | number,
    rfiId: string | number,
  ): Promise<{ caseId: string; rfiId: string }> {
    const rfi = (await this.procore.getProjectResource("rfis", projectId, rfiId)) as Record<string, unknown>;
    const res = await this.salesforce.createRecord("Case", {
      Subject: rfi.subject ?? `RFI ${rfiId}`,
      Status: "New",
      Priority: "High",
      Procore_RFI_Id__c: String(rfi.id ?? rfiId),
      Description: rfi.body ?? "",
    });
    return { caseId: res.id, rfiId: String(rfiId) };
  }
}
