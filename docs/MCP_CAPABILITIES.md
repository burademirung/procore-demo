# MCP Capabilities — the full protocol surface

Conduit exercises the breadth of the Model Context Protocol, not just basic tools. This document
maps each **demo-console scenario** to the **MCP feature** it demonstrates, the **real server
artifact** that backs it, and the **spec reference**. Grounded in a verified research pass over the
MCP 2025-06-18 and 2025-11-25 specifications.

> Legend — **Implemented**: real, tested server code. **Protocol-demonstrated**: spec-correct and
> exercised in integration tests via an in-memory client (live behavior depends on the connected
> client's capability support — see Caveats).

## Capability → scenario → artifact

| MCP feature | Demo scenario | Backed by (real artifact) | Spec | Status |
|---|---|---|---|---|
| **Tools** ★ (model-controlled, structured output + annotations) | **Sync legal documents** / project / financials / RFI→Case | **`sync_project_legal_documents`** (featured), `sync_procore_project_to_salesforce`, `sync_procore_financials`, `create_salesforce_case_from_rfi` (all with `outputSchema` + `annotations`) | [server/2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server) | **Implemented** ✓ tested |
| **Resources** (read-only context) | Object mappings | `config://mappings` | server spec | **Implemented** ✓ |
| **Resource templates** (URI params) + **Completion** | Cross-system search | `conduit://search/{query}` with `complete.query` | [completion](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/completion) | **Implemented** ✓ tested |
| **Prompts** + **argument completion** | `/sync-project` autocomplete, audit workflow | `audit_unmapped_records` prompt with `completable()` argument | [prompts](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts) | **Implemented** ✓ tested |
| **Elicitation** (`elicitation/create`, human-in-the-loop) | Conflict resolution; contact dedup | `resolve_sync_conflict` (single-select enum + default), `dedupe_contacts` (email format) | [schema](https://modelcontextprotocol.io/specification/2025-06-18/schema) · [2025-11-25 elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) | **Implemented** ✓ tested (in-memory client) |
| **Sampling** (`sampling/createMessage`, no server API keys) | AI project summary | `summarize_project` → `server.createMessage(...)` | [sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling) | **Implemented** ✓ tested (in-memory client) |
| **Progress notifications** | Bulk reconcile progress | `run_reconciliation` emits `notifications/progress` when a `progressToken` is supplied | [transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) | **Implemented** ✓ |
| **Streamable HTTP / SSE** (server-initiated) | Real-time webhook push | Remote transport on `/mcp`; webhook receiver at `/webhooks/procore` | [transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) | **Implemented** (transport) / push wiring is roadmap |
| **Idempotency / dedup** | Webhook replay storm | event-id dedup + upsert-by-External-ID | — | **Implemented** ✓ tested |
| **Logging** (`notifications/message`, `logging/setLevel`) | Live reconciliation diagnostics | engine `setLogger` → `server.sendLoggingMessage` | [logging](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging) | **Implemented** ✓ tested |
| **`resources/list_changed`** | New record → new resource announced | fired on reverse `create` | server spec | **Implemented** ✓ tested |
| **Cancellation** (`AbortSignal`) | Cancel a long reconciliation | `reconcileProjects(signal)` / `syncLegalDocuments(signal)` / `syncFinancials(signal)` via `extra.signal` | [cancellation](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation) | **Implemented** ✓ tested |
| **Pagination** (opaque cursor) | Page through projects | `list_procore_projects` → `{ items, nextCursor }` | server spec | **Implemented** ✓ tested |
| **URL-mode Elicitation** (SEP-1036) | Salesforce OAuth consent | `authorize_salesforce` → `elicitInput({ mode:"url" })` | [elicitation 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) | **Implemented** (degrades w/o client support) ✓ tested |
| **Tasks** (experimental, durable long-running) | Bulk reconcile as a task | — | [tasks (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) | **Roadmap** (experimental; nascent client support) |

## Featured tool — legal documents (0.4.0)
- **`sync_project_legal_documents`** ★ — the headline capability. Upserts a project's **contracts,
  insurance certificates, lien waivers and compliance records** into Salesforce custom objects
  (`Procore_Contract_Document__c`, `Procore_Insurance_Certificate__c`, `Procore_Lien_Waiver__c`,
  `Procore_Compliance_Document__c`) by External ID; typed `{ synced, byObject }` output; honors
  `AbortSignal`. Same machinery as the financial vertical, applied to legal documents.

## The new tools (0.2.0)
- **`sync_procore_financials`** — bulk-upserts prime contracts, commitments, change orders & invoices
  into Salesforce custom objects; typed `{ synced, byObject }` output.
- **`create_salesforce_case_from_rfi`** — turns a Procore RFI into a Salesforce Case and links them.
- **`dedupe_contacts`** — groups contacts by normalized email (Gmail dot/+tag aware) and **elicits**
  a canonical address when raw emails differ before merging.
- **`summarize_project`** — uses **sampling** to ask the client's model for a project health summary
  (no server-side API keys).
- **`resolve_sync_conflict`** — **elicits** which side wins (Procore / Salesforce / Merge) with a
  default, so conflicts never resolve silently.

## Caveats (verified during research)
- **Client support varies.** Sampling, elicitation, and tasks are spec features whose live behavior
  depends on the connected client. Conduit's tools **degrade gracefully** (return an `isError`
  result) when a client lacks the capability — covered by a test.
- **Tasks** (2025-11-25, SEP-1686) are explicitly experimental; not yet wired server-side.
- **Procore/Salesforce contracts** used by the financial/RFI/search methods are tagged
  `[NEEDS LIVE VERIFICATION]` — confirm against live docs before production.

See [API.md](API.md) for exact schemas and [../SPEC.md](../SPEC.md) for the roadmap.
