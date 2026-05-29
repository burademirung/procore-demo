import type { ProcoreClient } from "../clients/procore.js";
import type { SalesforceClient } from "../clients/salesforce.js";
import type { DedupStore } from "./dedup.js";
import {
  mappingForProcoreResource,
  mappingForSalesforceObject,
  mappingByKey,
  procoreToSalesforce,
  salesforceToProcore,
  FINANCIAL_MAPPING_KEYS,
} from "../mapping/mappings.js";
import type { AuditLog } from "./audit.js";
import { hashFields, type LinkStore } from "./linkStore.js";

/** Optional dependencies for richer behavior (audit trail, real-time notifications, link/hash store). */
export interface SyncEngineOptions {
  audit?: AuditLog;
  links?: LinkStore;
  /** Called after a successful write so the host can emit an MCP resources/updated notification. */
  onSynced?: (info: { system: "procore" | "salesforce"; object: string; externalId: string }) => void;
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
  PrimeContracts: "prime_contracts",
  Commitments: "commitments",
  ChangeOrders: "change_orders",
  Invoices: "invoices",
  RfiS: "rfis",
  Submittals: "submittals",
};

/** Resources fetched under a project (`/projects/{pid}/{segment}/{id}`) vs. top-level (`/{segment}/{id}`). */
const PROJECT_SCOPED = new Set(["PrimeContracts", "Commitments", "ChangeOrders", "Invoices", "RfiS", "Submittals"]);

/** REST path segment for a mapping's Procore resource. */
function segmentFor(resourceName: string): string {
  return RESOURCE_SEGMENT[resourceName] ?? resourceName.toLowerCase();
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

  constructor(
    private readonly procore: ProcoreClient,
    private readonly salesforce: SalesforceClient,
    private readonly dedup: DedupStore,
    private readonly opts: SyncEngineOptions = {},
  ) {
    this.notifier = opts.onSynced;
  }

  /** Register/replace the real-time notifier after construction (used to wire MCP resources/updated). */
  setNotifier(fn: SyncEngineOptions["onSynced"]): void {
    this.notifier = fn;
  }

  private notify(system: "procore" | "salesforce", object: string, externalId: string, action: "upsert" | "create" | "soft_delete"): void {
    this.opts.audit?.record({ action, system, object, externalId, status: "ok" });
    this.notifier?.({ system, object, externalId });
  }

  /** Fetch the canonical Procore record for an event, using the right endpoint for its resource. */
  private fetchProcoreRecord(event: ProcoreWebhookEvent, mapping: { procoreResource: string }): Promise<unknown> {
    const segment = segmentFor(mapping.procoreResource);
    if (PROJECT_SCOPED.has(mapping.procoreResource) && event.project_id !== undefined) {
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
   * Inbound Salesforce → Procore via Change Data Capture. Mirrors the Procore path: dedup → map →
   * create/update in Procore. Only mappings with direction bidirectional/sf_to_procore participate.
   */
  async handleSalesforceChange(event: SalesforceChangeEvent): Promise<SyncResult> {
    const isNew = await this.dedup.markIfNew(event.id);
    if (!isNew) return { status: "skipped_duplicate" };

    const mapping = mappingForSalesforceObject(event.sobject);
    if (!mapping) return { status: "no_mapping", detail: event.sobject };
    if (mapping.direction === "procore_to_sf") return { status: "ignored", detail: "wrong direction" };
    // Reverse UPDATE/DELETE need a Procore-side record lookup (link index) — Phase 4. CREATE only,
    // so we never duplicate a Procore record on an UPDATE event.
    if (event.changeType !== "CREATE") {
      return { status: "ignored", detail: `reverse ${event.changeType.toLowerCase()} not yet implemented (Phase 4)` };
    }

    const procoreFields = salesforceToProcore(mapping, event.fields);
    const segment = segmentFor(mapping.procoreResource);
    const created = await this.procore.create(segment, procoreFields);
    this.notify("procore", mapping.procoreResource, String(created.id), "create");
    return { status: "synced", detail: `${mapping.salesforceObject}→${segment}#${created.id}` };
  }

  /**
   * Reconciliation backstop (spec §5): periodic delta sweep that catches webhook drops
   * (at-least-once ≠ exactly-once). Phase 5 wires this to a cron trigger.
   */
  async reconcileProjects(): Promise<{ scanned: number; upserted: number }> {
    const mapping = mappingForProcoreResource("Projects");
    if (!mapping) return { scanned: 0, upserted: 0 };
    const projects = (await this.procore.listProjects()) as Array<Record<string, unknown>>;
    let upserted = 0;
    for (const project of projects) {
      const id = project.id;
      if (id === undefined) continue;
      await this.salesforce.upsertByExternalId(
        mapping.salesforceObject,
        mapping.sfExternalIdField,
        String(id),
        procoreToSalesforce(mapping, project),
      );
      upserted += 1;
    }
    return { scanned: projects.length, upserted };
  }

  /**
   * Sync a project's financial objects (prime contracts, commitments, change orders, invoices)
   * into their Salesforce custom objects via Bulk upsert. Returns per-object counts.
   */
  async syncFinancials(projectId: string | number): Promise<{ synced: number; byObject: Record<string, number> }> {
    const byObject: Record<string, number> = {};
    let synced = 0;
    for (const key of FINANCIAL_MAPPING_KEYS) {
      const m = mappingByKey(key);
      if (!m) continue;
      const records = (await this.procore.listProjectResource(segmentFor(m.procoreResource), projectId)) as Array<Record<string, unknown>>;
      const rows = records
        .filter((r) => r.id !== undefined)
        .map((r) => ({ __externalId: String(r.id), ...procoreToSalesforce(m, r) }));
      if (rows.length) await this.salesforce.bulkUpsert(m.salesforceObject, m.sfExternalIdField, rows);
      byObject[m.salesforceObject] = rows.length;
      synced += rows.length;
    }
    return { synced, byObject };
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
