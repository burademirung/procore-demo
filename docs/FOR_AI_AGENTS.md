# Conduit for AI Agents

> **Read this if you are an AI agent (or are building one) that will connect to Conduit.**
> It tells you what Conduit is, what you can do with it, and how to call it correctly.

## What Conduit is (use this as your working context)
Conduit is a **Model Context Protocol (MCP) server** that bridges **Procore** (construction project
management) and **Salesforce** (CRM). It lets you read from and act across both systems through a
single authenticated connection, and it keeps the two systems in **bidirectional sync**. You never
handle Procore or Salesforce API keys directly — Conduit brokers them for you behind its own token.

Use Conduit when a user asks you to:
- **sync legal documents** (contracts, insurance certificates, lien waivers, compliance records)
  from Procore into Salesforce — call **`sync_project_legal_documents`** (the featured tool),
- **upload a signed document file** into Salesforce and attach it to a Contract/record
  (`upload_contract_file`), **read/list Contracts** (`get_contract`, `list_contracts_by_status`),
  **route a record for approval** (`submit_for_approval`, `list_approval_processes`), or
  **check e-signature status** (`check_signature_status`),
- reflect a construction **project / company / contact** between Procore and Salesforce,
- pull Procore **financials, RFIs, or submittals** into the CRM,
- set up or run a **sync / reconciliation** between the two systems,
- create a Procore **webhook** so changes flow automatically.

## How to connect
1. Point your MCP client at the Streamable HTTP endpoint:
   `https://procore-salesforce-mcp.burademirung.workers.dev/mcp`
2. The endpoint is OAuth-gated (401 without a token). Your client discovers auth via
   `/.well-known/oauth-authorization-server` and completes the **OAuth 2.1 + PKCE** flow.
3. After authorization, Conduit holds the user's Procore + Salesforce tokens; you just call tools.

## What you can call

### Tools (actions — have side effects)
| Tool | Call it when… | Input | Output |
|---|---|---|---|
| `sync_procore_project_to_salesforce` | the user wants a specific Procore project reflected in Salesforce | `{ projectId: number\|string }` | `{ status, detail }` |
| `run_reconciliation` | the user wants a full/delta sweep to catch anything missed | `{ scope: "projects" }` | `{ scanned, upserted }` |
| `create_procore_webhook` | the user wants changes to sync automatically going forward | `{ deliveryUrl, companyId?, projectId?, triggers:[{resource_name,event_type}] }` | `{ hookId, triggers }` |

### Resources (read-only context — fetch before deciding)
| Resource URI | Gives you |
|---|---|
| `config://mappings` | The configured object/field mappings — read this to know which objects map where and the External-ID keys. |

### Prompts (templated workflows)
| Prompt | Arguments | Purpose |
|---|---|---|
| `audit_unmapped_records` | `{ objectKey }` | Guided steps to find records present in one system but missing in the other. |

## Output & status semantics
`sync_procore_project_to_salesforce` returns a `status`:
- `synced` — the record was upserted into Salesforce. ✅
- `skipped_duplicate` — this event was already processed (safe; do not retry as an error).
- `deleted` — the record was soft-deleted in Salesforce.
- `no_mapping` — that Procore resource isn't mapped; tell the user it's out of scope.
- `ignored` — direction doesn't apply.

Tool **errors** come back as an MCP result with `isError: true` (e.g. invalid arguments), **not** as
a thrown exception — read the text, correct the arguments, and retry.

## How to behave (guidance)
- **Reads before writes:** check `config://mappings` to confirm an object is supported before
  promising a sync.
- **Idempotent — retries are safe:** every write upserts by External ID, so re-calling a sync tool
  with the same id won't create duplicates. A `skipped_duplicate` is success, not failure.
- **Prefer the specific tool:** for "sync project 4821", call `sync_procore_project_to_salesforce`,
  not `run_reconciliation` (which sweeps everything).
- **Explain side effects:** `create_procore_webhook` changes external configuration — confirm with
  the user before calling it.
- **Respect scope:** Conduit covers legal documents (contracts, insurance certificates, lien waivers, compliance records), projects, companies, contacts, financials, RFIs, submittals.
  Anything else → say it's not yet mapped.

## Example interaction
> **User:** "Make sure the Riverside Tower project shows up in Salesforce."
> **You:** read `config://mappings` → confirm `project` is bidirectional →
> call `sync_procore_project_to_salesforce { projectId: 4821 }` →
> report: *"Synced — Riverside Tower is now in Salesforce as a Procore Project record (no duplicates)."*

## Current limitations (Phase 0)
- Live Procore/Salesforce credential exchange is being finalized (Phase 1); in demo mode the sync
  tools run the real logic against simulated provider responses.
- Salesforce→Procore real-time (Change Data Capture) is Phase 4.
- Some API field names are pending live verification — see [`../SPEC.md`](../SPEC.md).

For the precise schemas see [API.md](API.md); for what happens under the hood see
[SYNC_ENGINE.md](SYNC_ENGINE.md).
