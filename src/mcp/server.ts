import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";
import type { ProcoreClient, ProcoreWebhookTrigger } from "../clients/procore.js";
import type { SalesforceClient } from "../clients/salesforce.js";
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

export function buildMcpServer(deps: Deps): McpServer {
  const server = new McpServer(
    { name: "procore-salesforce-mcp", version: "0.2.0" },
    { capabilities: { logging: {}, resources: { subscribe: true, listChanged: true } } },
  );

  // Real-time: when a record syncs, push an MCP resources/updated notification to subscribers.
  deps.sync.setNotifier((info) => {
    server.server
      .sendResourceUpdated({ uri: `conduit://${info.system}/${info.object}/${info.externalId}` })
      .catch(() => {
        /* best-effort; client may not be subscribed */
      });
  });

  // ── Tools ───────────────────────────────────────────────────────────────────
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
      outputSchema: { scanned: z.number(), upserted: z.number() },
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
      const result = await deps.sync.reconcileProjects();
      await sendProgress(100, 100);
      return ok(result);
    },
  );

  server.registerTool(
    "sync_procore_financials",
    {
      title: "Sync Procore financials → Salesforce",
      description: "Bulk-upsert a project's prime contracts, commitments, change orders and invoices into Salesforce.",
      inputSchema: { projectId: z.union([z.string(), z.number()]) },
      outputSchema: { synced: z.number(), byObject: z.record(z.string(), z.number()) },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ projectId }) => ok(await deps.sync.syncFinancials(projectId)),
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
