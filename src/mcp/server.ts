import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";
import type { ProcoreClient, ProcoreWebhookTrigger } from "../clients/procore.js";
import type { SalesforceClient } from "../clients/salesforce.js";
import { HttpError } from "../clients/http.js";
import type { SyncEngine } from "../sync/engine.js";
import { MAPPINGS, mappingByKey } from "../mapping/mappings.js";
import { findDuplicates, normalizeEmail, type ContactLike } from "../sync/contacts.js";

/**
 * Wires the broker into the MCP feature model:
 *   • Tools — actions with side effects (sync, create, dedupe), with annotations + structured output
 *   • Resources — read-only context, incl. a cross-system search resource TEMPLATE with completion
 *   • Prompts — templated workflows with argument autocompletion
 *   • Sampling — summarize_project asks the CLIENT's LLM (no server API keys)
 *   • Elicitation — resolve_sync_conflict / dedupe_contacts ask a human mid-tool
 *
 * Sampling and elicitation require client support; handlers degrade gracefully (isError) when a
 * client lacks the capability.
 */
export interface Deps {
  procore: ProcoreClient;
  salesforce: SalesforceClient;
  sync: SyncEngine;
}

/** Build a text+structured tool result. */
function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    ...(typeof data === "object" && data !== null ? { structuredContent: data as Record<string, unknown> } : {}),
  };
}
function errResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/** Resolve a resource-template variable to a single string (templates may yield string[]). */
function templateVar(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
 * Max base64 payload for a document upload. The hard ceiling is the Cloudflare Worker request body
 * (~100 MB) and its 128 MB memory limit; we decode the whole string in memory, so we cap well below
 * that. ~28 MB base64 ≈ ~20 MB binary. (Salesforce ContentVersion itself allows 2 GB, but base64
 * over MCP's JSON transport into a Worker is the binding constraint — large files need a streaming
 * or upload-from-URL path, see SPEC §4.)
 */
const MAX_UPLOAD_B64_LEN = 28_000_000;

/** Decode base64 (how binary file content arrives over MCP's JSON transport) to raw bytes. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); // throws on malformed input — callers must guard
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** Least-privilege allowlist of Salesforce OAuth scopes the authorize tool may request. */
const ALLOWED_SF_SCOPES = new Set(["api", "refresh_token", "offline_access", "openid", "profile", "email"]);

/**
 * Escape a single-quoted SOQL literal to prevent SOQL injection: strip control characters
 * (which Salesforce rejects anyway), then escape backslashes before single quotes.
 */
function soqlLiteral(value: string): string {
  return value.replace(/[\u0000-\u001f]/g, "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function buildMcpServer(deps: Deps): McpServer {
  const server = new McpServer(
    { name: "procore-salesforce-mcp", version: "0.5.0" },
    { capabilities: { logging: {}, resources: { subscribe: true, listChanged: true } } },
  );

  // Real-time: when a record syncs, push resources/updated; a brand-new record also changes the
  // resource *set*, so emit resources/list_changed on create.
  deps.sync.setNotifier((info) => {
    server.server
      .sendResourceUpdated({ uri: `conduit://${info.system}/${info.object}/${info.externalId}` })
      .catch(() => {});
    if (info.action === "create") server.server.sendResourceListChanged().catch(() => {});
  });

  // Logging: forward the engine's structured logs as MCP logging/message notifications.
  deps.sync.setLogger((level, message, data) => {
    server.server.sendLoggingMessage({ level, logger: "sync", data: { message, ...(data ?? {}) } }).catch(() => {});
  });

  // ── Tools ───────────────────────────────────────────────────────────────────

  // ★ FEATURED — Legal documents. The headline capability: mirror a project's contracts,
  // insurance certificates, lien waivers and compliance records into Salesforce by External Id.
  server.registerTool(
    "sync_project_legal_documents",
    {
      title: "Sync legal documents → Salesforce",
      description:
        "Upsert a project's legal documents — contracts, insurance certificates, lien waivers and compliance records — into Salesforce custom objects by external id. Gives legal/CRM teams a live, queryable mirror of every executed agreement and its status.",
      inputSchema: { projectId: z.union([z.string(), z.number()]) },
      outputSchema: { synced: z.number(), byObject: z.record(z.string(), z.number()) },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId }, extra) => ok(await deps.sync.syncLegalDocuments(projectId, extra.signal)),
  );

  // ★ FEATURED — Salesforce-native legal-document operations (Tier 1; `api` scope only).
  // Grounded in deep research against primary Salesforce docs: ContentVersion multipart upload,
  // standard Contract SOQL, the Process Approvals REST resource, and DocuSign Status SOQL.

  server.registerTool(
    "upload_contract_file",
    {
      title: "Upload a document file to Salesforce & attach it",
      description:
        "Upload a binary legal document (base64) into Salesforce as a ContentVersion and link it to a record (a Contract, or a synced Procore_Contract_Document__c) via FirstPublishLocationId. REST multipart upload; practical limit ~20 MB (the document is buffered in the Worker — larger files need a streaming/upload-from-URL path).",
      inputSchema: {
        recordId: z.string().describe("Salesforce record id to attach the file to (e.g. a Contract)"),
        fileName: z.string().describe("File name incl. extension, e.g. master-agreement.pdf"),
        contentBase64: z.string().describe("Base64-encoded file bytes (~20 MB max)"),
        title: z.string().optional(),
      },
      outputSchema: { contentVersionId: z.string(), linkedTo: z.string() },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ recordId, fileName, contentBase64, title }) => {
      if (contentBase64.length > MAX_UPLOAD_B64_LEN) {
        return errResult(`File too large: ~${Math.round((contentBase64.length * 3) / 4 / 1e6)} MB exceeds the ~20 MB upload limit. Use a streaming/upload-from-URL path for larger files.`);
      }
      let data: Uint8Array;
      try {
        data = base64ToBytes(contentBase64);
      } catch {
        return errResult("Invalid base64 in contentBase64.");
      }
      const res = await deps.salesforce.uploadContentVersion({ title: title ?? fileName, fileName, data, linkedRecordId: recordId });
      return ok({ contentVersionId: res.id, linkedTo: recordId });
    },
  );

  server.registerTool(
    "get_contract",
    {
      title: "Get a Salesforce Contract",
      description: "Read a Salesforce Contract record by id.",
      inputSchema: { contractId: z.string() },
      outputSchema: { contract: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ contractId }) => ok({ contract: await deps.salesforce.getRecord("Contract", contractId) }),
  );

  server.registerTool(
    "list_contracts_by_status",
    {
      title: "List Salesforce Contracts by status",
      description: "Query Salesforce Contracts filtered by Status (e.g. Draft, Activated, InApproval) via SOQL.",
      inputSchema: { status: z.string(), limit: z.number().int().min(1).max(200).default(50) },
      outputSchema: { records: z.array(z.record(z.string(), z.unknown())), count: z.number() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ status, limit }) => {
      const soql = `SELECT Id, ContractNumber, Status, AccountId, StartDate, ContractTerm FROM Contract WHERE Status = '${soqlLiteral(status)}' LIMIT ${limit}`;
      const res = await deps.salesforce.query<Record<string, unknown>>(soql);
      return ok({ records: res.records, count: res.records.length });
    },
  );

  server.registerTool(
    "submit_for_approval",
    {
      title: "Submit a record for approval",
      description: "Submit a Salesforce record (e.g. a Contract) into its approval process via the Process Approvals REST resource.",
      inputSchema: {
        recordId: z.string(),
        comments: z.string().optional(),
        nextApproverIds: z.array(z.string()).optional(),
        processDefinitionNameOrId: z.string().optional(),
      },
      outputSchema: { result: z.unknown() },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ recordId, comments, nextApproverIds, processDefinitionNameOrId }) =>
      ok({
        result: await deps.salesforce.processApproval({
          actionType: "Submit",
          contextId: recordId,
          ...(comments ? { comments } : {}),
          ...(nextApproverIds ? { nextApproverIds } : {}),
          ...(processDefinitionNameOrId ? { processDefinitionNameOrId } : {}),
        }),
      }),
  );

  server.registerTool(
    "list_approval_processes",
    {
      title: "List approval processes",
      description: "List the org's approval processes (keyed by SObject type) via GET /process/approvals/.",
      inputSchema: {},
      outputSchema: { approvals: z.unknown() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => ok({ approvals: await deps.salesforce.listApprovalProcesses() }),
  );

  server.registerTool(
    "check_signature_status",
    {
      title: "Check e-signature status (DocuSign)",
      description:
        "Query the DocuSign 'eSignature for Salesforce' managed-package object (dsfs__DocuSign_Status__c) for an envelope's status. Returns available:false with a clear message if that package isn't installed in the org.",
      inputSchema: { envelopeId: z.string() },
      outputSchema: {
        available: z.boolean(),
        records: z.array(z.record(z.string(), z.unknown())),
        detail: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ envelopeId }) => {
      const soql = `SELECT Id, dsfs__Envelope_Status__c, dsfs__Subject__c, dsfs__DocuSign_Envelope_ID__c FROM dsfs__DocuSign_Status__c WHERE dsfs__DocuSign_Envelope_ID__c = '${soqlLiteral(envelopeId)}' LIMIT 50`;
      try {
        const res = await deps.salesforce.query<Record<string, unknown>>(soql);
        return ok({ available: true, records: res.records });
      } catch (e) {
        // Only treat a missing/unknown sObject as "not installed". Real auth/session/network
        // failures must surface as errors, not be masked as "DocuSign absent".
        const body = e instanceof HttpError ? e.body : "";
        const missingObject =
          e instanceof HttpError && (e.status === 400 || e.status === 404) && /INVALID_TYPE|dsfs__DocuSign_Status__c|sObject type/i.test(body);
        if (missingObject) {
          return ok({
            available: false,
            records: [],
            detail:
              "DocuSign 'eSignature for Salesforce' managed package not installed (dsfs__DocuSign_Status__c not present). Newer installs use the dfsle__ namespace.",
          });
        }
        return errResult(`Could not query DocuSign status: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "sync_procore_project_to_salesforce",
    {
      title: "Sync Procore project → Salesforce",
      description: "Fetch a Procore project and upsert it into Salesforce by external id.",
      inputSchema: { projectId: z.union([z.string(), z.number()]) },
      outputSchema: { status: z.string(), detail: z.string().optional() },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId }) =>
      ok(
        await deps.sync.handleProcoreWebhook({
          id: `manual-${projectId}-${crypto.randomUUID()}`, // unique per call — manual syncs must not dedupe
          resource_name: "Projects",
          event_type: "update",
          resource_id: Number(projectId),
        }),
      ),
  );

  server.registerTool(
    "run_reconciliation",
    {
      title: "Run reconciliation sweep",
      description: "Delta-sweep Procore projects into Salesforce to catch missed webhooks. Reports progress.",
      inputSchema: { scope: z.enum(["projects"]).default("projects") },
      outputSchema: { scanned: z.number(), upserted: z.number(), cancelled: z.boolean().optional() },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (_args, extra) => {
      const progressId = (extra?._meta as { progressToken?: string | number } | undefined)?.progressToken;
      const sendProgress = async (progress: number, total: number) => {
        if (progressId === undefined) return;
        try {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: progressId, progress, total },
          });
        } catch {
          /* progress is best-effort */
        }
      };
      await sendProgress(0, 100);
      const result = await deps.sync.reconcileProjects(extra.signal); // honors client cancellation
      await sendProgress(100, 100);
      return ok(result);
    },
  );

  server.registerTool(
    "sync_procore_financials",
    {
      title: "Sync Procore financials → Salesforce",
      description: "Upsert a project's prime contracts, commitments, change orders and invoices into Salesforce custom objects.",
      inputSchema: { projectId: z.union([z.string(), z.number()]) },
      outputSchema: { synced: z.number(), byObject: z.record(z.string(), z.number()) },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId }, extra) => ok(await deps.sync.syncFinancials(projectId, extra.signal)),
  );

  server.registerTool(
    "create_salesforce_case_from_rfi",
    {
      title: "Create Salesforce Case from RFI",
      description: "Create a Salesforce Case from a Procore RFI and link them.",
      inputSchema: { projectId: z.union([z.string(), z.number()]), rfiId: z.union([z.string(), z.number()]) },
      outputSchema: { caseId: z.string(), rfiId: z.string() },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId, rfiId }) => ok(await deps.sync.createCaseFromRfi(projectId, rfiId)),
  );

  server.registerTool(
    "sync_salesforce_to_procore",
    {
      title: "Sync Salesforce change → Procore",
      description: "Apply a Salesforce Change Data Capture event to Procore (reverse direction).",
      inputSchema: {
        sobject: z.string(),
        changeType: z.enum(["CREATE", "UPDATE", "DELETE"]).default("UPDATE"),
        recordId: z.string(),
        fields: z.record(z.string(), z.unknown()).default({}),
      },
      outputSchema: { status: z.string(), detail: z.string().optional() },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ sobject, changeType, recordId, fields }) =>
      ok(
        await deps.sync.handleSalesforceChange({
          id: `manual-sf-${recordId}-${crypto.randomUUID()}`, // unique per call
          sobject,
          changeType,
          fields: fields as Record<string, unknown>,
        }),
      ),
  );

  server.registerTool(
    "create_procore_webhook",
    {
      title: "Provision Procore webhook (hook + triggers)",
      description: "Create a Procore webhook hook and attach triggers (two-tier model).",
      inputSchema: {
        deliveryUrl: z.string().url(),
        companyId: z.union([z.string(), z.number()]).optional(),
        projectId: z.union([z.string(), z.number()]).optional(),
        triggers: z
          .array(z.object({ resource_name: z.string(), event_type: z.enum(["create", "update", "delete"]) }))
          .min(1),
      },
      outputSchema: { hookId: z.number(), triggers: z.number() },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ deliveryUrl, companyId, projectId, triggers }) => {
      const hook = await deps.procore.createWebhookHook({
        deliveryUrl,
        ...(companyId !== undefined ? { companyId } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      });
      for (const t of triggers as ProcoreWebhookTrigger[]) await deps.procore.addWebhookTrigger(hook.id, t);
      return ok({ hookId: hook.id, triggers: triggers.length });
    },
  );

  // ── Tool using ELICITATION (human-in-the-loop conflict resolution) ────────────
  server.registerTool(
    "resolve_sync_conflict",
    {
      title: "Resolve a sync conflict (asks a human)",
      description: "When a field differs between systems, ask the user which value wins via MCP elicitation.",
      inputSchema: {
        objectKey: z.string(),
        field: z.string(),
        procoreValue: z.string(),
        salesforceValue: z.string(),
      },
      outputSchema: {
        resolved: z.boolean(),
        action: z.string().optional(),
        decision: z.string().optional(),
        winner: z.string().optional(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ objectKey, field, procoreValue, salesforceValue }) => {
      try {
        const res = await server.server.elicitInput({
          message: `Conflict on ${objectKey}.${field}. Which value should win?`,
          requestedSchema: {
            type: "object",
            properties: {
              decision: {
                type: "string",
                title: "Which value wins?",
                enum: ["procore", "salesforce", "merge"],
                enumNames: [`Keep Procore (${procoreValue})`, `Keep Salesforce (${salesforceValue})`, "Merge"],
                default: "procore",
              },
            },
            required: ["decision"],
          },
        });
        if (res.action !== "accept") return ok({ resolved: false, action: res.action });
        const decision = (res.content as { decision?: string } | undefined)?.decision ?? "procore";
        const winner = decision === "salesforce" ? salesforceValue : decision === "merge" ? `${procoreValue} | ${salesforceValue}` : procoreValue;
        return ok({ resolved: true, decision, winner });
      } catch {
        return errResult("This client does not support elicitation; cannot ask for a conflict decision.");
      }
    },
  );

  // ── Tool using ELICITATION (contact dedup with canonical-email confirmation) ──
  server.registerTool(
    "dedupe_contacts",
    {
      title: "Deduplicate contacts",
      description: "Find duplicate contacts by email; when emails differ, elicit the canonical address.",
      inputSchema: {
        contacts: z
          .array(
            z.object({
              id: z.string(),
              name: z.string().optional(),
              email: z.string().optional(),
              source: z.enum(["procore", "salesforce"]),
            }),
          )
          .min(2),
      },
      outputSchema: {
        duplicateGroups: z.number(),
        merges: z.array(z.object({ canonicalEmail: z.string(), mergedIds: z.array(z.string()) })),
      },
    },
    async ({ contacts }) => {
      const groups = findDuplicates(contacts as ContactLike[]);
      const merges: Array<{ canonicalEmail: string; mergedIds: string[] }> = [];
      for (const g of groups) {
        let canonical = g.normalizedEmail;
        if (g.emailsDiffer) {
          try {
            const res = await server.server.elicitInput({
              message: `These look like the same person with different emails: ${g.contacts.map((c) => c.email).join(", ")}. Confirm the canonical email.`,
              requestedSchema: {
                type: "object",
                properties: { email: { type: "string", format: "email", title: "Canonical email", default: g.normalizedEmail } },
                required: ["email"],
              },
            });
            if (res.action === "accept") {
              const picked = (res.content as { email?: string } | undefined)?.email;
              canonical = normalizeEmail(picked) || canonical;
            }
          } catch {
            /* no elicitation support → fall back to normalized email */
          }
        }
        merges.push({ canonicalEmail: canonical, mergedIds: g.contacts.map((c) => c.id) });
      }
      return ok({ duplicateGroups: groups.length, merges });
    },
  );

  // ── Tool using SAMPLING (server asks the CLIENT's LLM — no server API keys) ───
  server.registerTool(
    "summarize_project",
    {
      title: "Summarize a Procore project (AI)",
      description: "Use MCP sampling to ask the client's model for a health summary of a project.",
      inputSchema: { projectId: z.union([z.string(), z.number()]) },
      outputSchema: { projectId: z.string(), summary: z.string(), model: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId }) => {
      const project = (await deps.procore.getProject(projectId)) as Record<string, unknown>;
      try {
        const res = await server.server.createMessage({
          maxTokens: 400,
          systemPrompt: "You are a construction project analyst. Summarize project health in 2-3 sentences.",
          messages: [
            { role: "user", content: { type: "text", text: `Summarize this Procore project:\n${JSON.stringify(project)}` } },
          ],
        });
        const text = res.content.type === "text" ? res.content.text : "(non-text completion)";
        return ok({ projectId: String(projectId), summary: text, model: res.model });
      } catch {
        return errResult("This client does not support sampling; cannot generate an AI summary.");
      }
    },
  );

  // ── Tool with cursor PAGINATION ───────────────────────────────────────────────
  server.registerTool(
    "list_procore_projects",
    {
      title: "List Procore projects (paginated)",
      description: "List the company's Procore projects with opaque cursor pagination.",
      inputSchema: { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) },
      outputSchema: { items: z.array(z.record(z.string(), z.unknown())), nextCursor: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ cursor, limit }) => {
      const all = (await deps.procore.listProjects()) as Array<Record<string, unknown>>;
      const start = cursor ? Number(atob(cursor)) || 0 : 0;
      const items = all.slice(start, start + limit);
      const next = start + limit < all.length ? btoa(String(start + limit)) : undefined;
      return ok({ items, ...(next ? { nextCursor: next } : {}) });
    },
  );

  // ── Tool using URL-mode ELICITATION (out-of-band OAuth consent, SEP-1036) ──────
  server.registerTool(
    "authorize_salesforce",
    {
      title: "Authorize Salesforce (OAuth consent)",
      description: "Ask the user to complete a Salesforce OAuth consent via URL-mode elicitation. Builds a real authorize URL (client_id + redirect_uri from config); scope is restricted to a least-privilege allowlist.",
      inputSchema: { scope: z.string().default("api refresh_token") },
      outputSchema: { action: z.string() },
      annotations: { openWorldHint: true },
    },
    async ({ scope }) => {
      // Least-privilege: only allow known, narrow scopes — reject escalations like "full"/"web".
      const requested = scope.split(/\s+/).filter(Boolean);
      const disallowed = requested.filter((s) => !ALLOWED_SF_SCOPES.has(s));
      if (requested.length === 0 || disallowed.length > 0) {
        return errResult(`Disallowed Salesforce scope(s): ${disallowed.join(", ") || "(empty)"}. Allowed: ${[...ALLOWED_SF_SCOPES].join(", ")}.`);
      }
      let url: string;
      try {
        url = deps.salesforce.authorizeUrl(requested.join(" "));
      } catch (e) {
        return errResult(e instanceof Error ? e.message : "Salesforce OAuth is not configured.");
      }
      try {
        const res = await server.server.elicitInput({
          mode: "url",
          elicitationId: crypto.randomUUID(),
          message: "Approve Salesforce access so Conduit can sync on your behalf.",
          url,
        });
        return ok({ action: res.action });
      } catch {
        return errResult("This client does not support URL-mode elicitation.");
      }
    },
  );

  // ── Resources ─────────────────────────────────────────────────────────────────
  server.registerResource(
    "mappings",
    "config://mappings",
    { title: "Object mappings", description: "The configured Procore↔Salesforce object mappings." },
    async () => ({ contents: [{ uri: "config://mappings", text: JSON.stringify(MAPPINGS, null, 2) }] }),
  );

  // Cross-system search as a resource TEMPLATE with argument COMPLETION.
  server.registerResource(
    "search",
    new ResourceTemplate("conduit://search/{query}", {
      list: undefined,
      complete: {
        query: (value: string) =>
          ["Riverside Tower", "Harbor Point", "Midtown Deck", "River Oaks Plaza"].filter((s) =>
            s.toLowerCase().includes((value ?? "").toLowerCase()),
          ),
      },
    }),
    { title: "Cross-system search", description: "Search projects/companies/contacts across Procore and Salesforce." },
    async (uri, variables) => {
      const query = templateVar(variables.query);
      const [procore, salesforce] = await Promise.all([
        deps.procore.search(query).catch(() => []),
        deps.salesforce.search(query).catch(() => ({ searchRecords: [] })),
      ]);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify({ query, procore, salesforce }, null, 2) },
        ],
      };
    },
  );

  // Rich, readable object resources (templates with id parameters).
  server.registerResource(
    "procore-project",
    new ResourceTemplate("procore://project/{id}", { list: undefined }),
    { title: "Procore project", description: "Read a Procore project record by id." },
    async (uri, variables) => {
      const id = templateVar(variables.id);
      const record = await deps.procore.getProject(id);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(record, null, 2) }] };
    },
  );

  server.registerResource(
    "salesforce-account",
    new ResourceTemplate("salesforce://account/{id}", { list: undefined }),
    { title: "Salesforce account", description: "Read a Salesforce Account record by id." },
    async (uri, variables) => {
      const id = templateVar(variables.id);
      const record = await deps.salesforce.getRecord("Account", id);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(record, null, 2) }] };
    },
  );

  // ── Prompts (with argument autocompletion) ─────────────────────────────────────
  server.registerPrompt(
    "audit_unmapped_records",
    {
      title: "Audit unmapped records",
      description: "Find records present in one system but missing in the other.",
      argsSchema: {
        objectKey: completable(z.string(), (value) =>
          MAPPINGS.map((m) => m.key).filter((k) => k.startsWith(value ?? "")),
        ),
      },
    },
    ({ objectKey }) => {
      const m = mappingByKey(objectKey);
      const label = m ? `${m.procoreResource} ↔ ${m.salesforceObject}` : objectKey;
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Audit the "${label}" mapping. 1) List recent Procore records. 2) Query Salesforce for matching external ids. 3) Report records missing on either side and propose sync actions.`,
            },
          },
        ],
      };
    },
  );

  return server;
}
