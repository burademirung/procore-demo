# Procore ↔ Salesforce MCP Server — Build Spec

**Status:** Draft v1 · 2026-05-28
**Goal:** A remote Model Context Protocol (MCP) server that brokers **bidirectional** sync between
Procore (construction PM) and Salesforce (CRM), exposing agent-callable tools/resources/prompts AND
running a durable background reconciliation engine.

> **Provenance legend**
> `[VERIFIED]` — confirmed by deep-research (primary source, 2/3+ adversarial vote).
> `[NEEDS LIVE VERIFICATION]` — from model knowledge (cutoff 2026-01); **re-check against live docs before relying on the exact contract**. Research could not verify these because Procore/Salesforce doc pages are JS-rendered or were flagged unreliable.

---

## 1. Architecture

```
                          ┌─────────────────────────────────────────────┐
   MCP client (Claude /   │            MCP SERVER (this repo)             │
   agent / IDE) ──────────▶  Streamable HTTP endpoint  (POST + GET)      │
        ▲   issues own     │  • Origin validation (403)        [VERIFIED]│
        │   bound token     │  • OAuth 2.1 + PKCE (own AS)      [VERIFIED]│
        │                   │                                            │
        │                   │  ┌──────────────┐   ┌──────────────────┐   │
        └───────────────────┼─▶│  MCP layer   │   │  Sync engine     │   │
                            │  │ tools/res/   │   │  (queue + dedup  │   │
                            │  │ prompts      │   │   + reconcile)   │   │
                            │  └──────┬───────┘   └────────┬─────────┘   │
                            │         │                    │             │
                            │  ┌──────▼────────────────────▼─────────┐   │
                            │  │   Mapping layer (bidirectional)      │   │
                            │  └──────┬───────────────────┬──────────┘   │
                            │  ┌──────▼──────┐     ┌───────▼─────────┐    │
                            │  │ Procore     │     │ Salesforce      │    │
                            │  │ client      │     │ client          │    │
                            │  └──────┬──────┘     └───────┬─────────┘    │
                            │  ┌──────▼───────────────────▼──────────┐    │
                            │  │ Token store (multi-tenant, encrypted)│    │
                            │  │  per-tenant: Procore + SF tokens     │    │
                            │  │  via tokenExchangeCallback [VERIFIED]│    │
                            │  └──────────────────────────────────────┘   │
                            └──────────▲───────────────────▲──────────────┘
                                       │ webhooks          │ CDC / Platform Events
                                  Procore (at-least-once,   Salesforce
                                   5s timeout) [VERIFIED]
```

**Key principle (from research):** MCP tool calls are request/response and agent-driven; durable
bidirectional sync needs a queue + dedup + scheduler. We therefore split into **two planes**:
- **Agent plane** — thin MCP tools for on-demand reads/writes/queries.
- **Sync plane** — background reconciliation triggered by Procore webhooks `[VERIFIED]` and Salesforce
  Change Data Capture, with idempotent dedup-by-event-id `[VERIFIED]`.

---

## 2. Tech stack & deployment

| Concern | Choice | Why |
|---|---|---|
| Language | **TypeScript** | Richest MCP SDK + Cloudflare ecosystem `[VERIFIED]` |
| MCP SDK | `@modelcontextprotocol/sdk` | Ships `StreamableHTTPServerTransport` + auth helpers `[VERIFIED]` |
| HTTP framework | **Hono** | Runs on both Node (`@hono/node-server`) and Workers `[VERIFIED]` |
| Transport | **Streamable HTTP** | Only supported remote transport; SSE deprecated `[VERIFIED]` |
| Hosting (recommended) | **Cloudflare Workers + `McpAgent`** (Durable Object per session/tenant) | Built-in per-tenant state, both transports `[VERIFIED]` |
| Auth provider lib | **`workers-oauth-provider`** | OAuth 2.1+PKCE + `tokenExchangeCallback` for dual downstream tokens `[VERIFIED]` |
| Token store | KV (Workers) / encrypted file or Postgres (Node), AES-256-GCM | Multi-tenant, pluggable `[VERIFIED]` (per template) |
| Queue | Cloudflare Queues (Workers) / BullMQ+Redis (Node) | Async webhook ingestion (5s timeout forces async) `[VERIFIED]` |
| Scheduler | Cloudflare Cron Triggers / node-cron | Periodic reconciliation backstop |

**Two deploy targets, one codebase** (per verified `iceener/streamable-mcp-server-template` pattern):
`src/shared/` holds transport-agnostic logic; `src/node/` and `src/worker/` are thin entrypoints.

> ⚠️ Refuted claim `[1-2]`: `McpAgent` does **not** auto-handle downstream provider auth. Brokering
> and refreshing Procore + Salesforce tokens is **our** application code. Budget for it.

---

## 3. Authentication design (the hard part)

Three OAuth relationships per tenant:

1. **MCP client → MCP server.** Server is its own OAuth 2.1 Authorization Server, issues a **bound
   token** distinct from provider tokens. PKCE required. `[VERIFIED]`
2. **MCP server → Procore.** `[NEEDS LIVE VERIFICATION]`
   - Procore OAuth 2.0. Two app types: **user-based** (authorization-code, acts as a user) and
     **Data Connection / service-account** (client-credentials, acts as the app/company).
   - Token endpoint `https://login.procore.com/oauth/token`; access tokens short-lived (~2h),
     refresh tokens rotate. Sandbox host differs (`https://sandbox.procore.com`).
3. **MCP server → Salesforce.** `[NEEDS LIVE VERIFICATION]`
   - **JWT Bearer flow** for server-to-server (Connected App + cert, no interactive refresh) — best
     for the background sync plane.
   - **Web-server (auth-code) flow** for per-user agent actions that must respect user permissions.

**Mechanism:** `workers-oauth-provider`'s `tokenExchangeCallback` performs each upstream exchange and
stores the result in the grant `props` — one grant carries **both** Procore and SF tokens per tenant. `[VERIFIED]`

---

## 4. Data mapping table (bidirectional) `[NEEDS LIVE VERIFICATION]`

| Procore object | ⇄ | Salesforce object | Match key (idempotency) | Notes |
|---|---|---|---|---|
| Company (Vendor/Directory) | ⇄ | Account | SF External ID `Procore_Company_Id__c` | Vendors & owners → Accounts |
| Project | ⇄ | Opportunity *(or custom `Procore_Project__c`)* | `Procore_Project_Id__c` | Won Opp → new Procore project (SF→PC) |
| Directory Contact / User | ⇄ | Contact | `Procore_Contact_Id__c` + email | Dedup by email to avoid SF duplicates |
| **★ Contract Document** | ⇄ | custom `Procore_Contract_Document__c` | `Procore_Id__c` | **Featured legal vertical (bidirectional)** — status/type/executed date |
| **★ Insurance Certificate** | ⇄ | custom `Procore_Insurance_Certificate__c` | `Procore_Id__c` | COI number, status, expiration date |
| **★ Lien Waiver** | ⇄ | custom `Procore_Lien_Waiver__c` | `Procore_Id__c` | Title, status, amount |
| **★ Compliance Document** | ⇄ | custom `Procore_Compliance_Document__c` | `Procore_Id__c` | Title, status, due date |
| Prime Contract | → | custom `Procore_Prime_Contract__c` | `Procore_Id__c` | Financials usually PC→SF (reporting) |
| Commitment / Sub Contract | → | custom `Procore_Commitment__c` | `Procore_Id__c` | |
| Change Order | → | custom `Procore_Change_Order__c` | `Procore_Id__c` | Line-item granularity = child records |
| Invoice / Payment | → | custom `Procore_Invoice__c` | `Procore_Id__c` | |
| Budget line item | → | custom `Procore_Budget_Line__c` | composite key | High volume → Bulk API 2.0 |
| RFI | → | custom `Procore_RFI__c` (or Case) | `Procore_Id__c` | |
| Submittal | → | custom `Procore_Submittal__c` | `Procore_Id__c` | |
| Document | → | Salesforce Files / ContentDocument | `Procore_Id__c` | Store link, not blob, by default |

**Direction rationale:** master data (companies/projects/contacts) is **bidirectional**; the
**featured legal-documents vertical** (contracts, insurance certificates, lien waivers, compliance
records) and financials & PM objects are **Procore → Salesforce** (CRM reporting), since Salesforce
is rarely the source of truth for construction documents/financials.

> **★ Legal documents (featured).** `sync_project_legal_documents` upserts the four legal-document
> object types above by External ID — the headline capability. It syncs the **structured
> record + metadata** (status, type, dates, amount), at the level of the financial vertical.
>
> **Binary file layer (implemented, 0.5.0 · Tier 1):** `upload_contract_file` uploads the actual
> document (PDF/DOCX) into Salesforce Files via the REST **multipart** blob-insert to `ContentVersion`
> (ceiling 2 GB — *not* the ~37.5 MB base64 `VersionData` path) and links it to the record in one
> transaction via `FirstPublishLocationId`. Verified (3-0) against the Salesforce REST blob-insert
> and ContentVersion object-reference docs. Companion Tier-1 tools (`get_contract`,
> `list_contracts_by_status`, `submit_for_approval`, `list_approval_processes`,
> `check_signature_status`) all run on the existing **`api`** scope.
>
> **Bidirectional (0.6.0).** Legal mappings are now `bidirectional`. The reverse path
> (`sync_salesforce_to_procore` → `handleSalesforceChange`) writes Salesforce edits back to Procore:
> CREATE/UPDATE/DELETE on the project-scoped Procore resource, recovering the Procore record id from
> `Procore_Id__c` and the project from `Procore_Project_Id__c` (both carried on the SF record). Conflicts
> resolve last-write-wins by event order; dedup drops replays. `[NEEDS LIVE VERIFICATION]` the Procore
> **write** endpoints/verbs (POST/PATCH/DELETE under `/projects/{id}/{resource}`), and a production
> deployment should wire `src/sync/conflict.ts` to the org's real ownership policy.
>
> **Tier 2 (roadmap, requires licensing):** the first-party **Salesforce Contracts** (Revenue Cloud)
> CLM product — clause libraries, `ContractDocumentVersion`, native e-sign send/void — usable only if
> the target org is provisioned with that license; detect at runtime, don't assume.

---

## 5. Sync strategy

**Idempotency (verified requirement):** every write keyed by a stable external ID; dedup inbound
events by Procore `event id`/ULID `[VERIFIED]`. Salesforce writes use **upsert on External ID** so
re-delivery is safe `[NEEDS LIVE VERIFICATION]`.

**Inbound Procore → SF (real-time):** webhook → return 2xx in <5s `[VERIFIED]` → enqueue → worker
dedups → maps → upserts into SF (Bulk API 2.0 for high-volume line items).

**Inbound SF → Procore (real-time):** Salesforce **Change Data Capture** / Platform Event → enqueue →
map → Procore create/update `[NEEDS LIVE VERIFICATION]`.

**Reconciliation backstop:** scheduled full/delta sweep (cron) catches missed webhooks (at-least-once
≠ exactly-once; webhooks can be dropped after retry exhaustion).

**Conflict resolution (DESIGN DECISION — see §7):** when both sides changed the same record since last
sync. Options: last-write-wins by timestamp; source-of-truth-per-field; or queue for human review.

**Deletes:** Procore emits `delete` events `[VERIFIED]`. Policy: **soft-delete/flag** in SF (set
`Procore_Deleted__c = true`) rather than hard delete, to preserve CRM history.

---

## 6. MCP surface (tools / resources / prompts) `[VERIFIED feature model]`

**Tools (side effects):**
- `procore_sync_project_to_salesforce(projectId)` / `salesforce_sync_opportunity_to_procore(oppId)`
- `link_records(procoreType, procoreId, sfType, sfId)` — establish a mapping manually
- `run_reconciliation(scope, since?)` — trigger a delta sweep
- `resolve_conflict(mappingId, resolution)` — apply a conflict decision
- `create_procore_webhook(scope, resources[])` — provision hooks+triggers

**Resources (read-only):**
- `procore://project/{id}`, `procore://company/{id}`, `salesforce://account/{id}`, etc.
- `sync://status` — queue depth, last reconcile, error count
- `sync://mappings/{procoreType}/{id}` — current link + last-synced hashes

**Prompts (templated workflows):**
- `onboard_won_opportunity` — guided SF Opp → Procore project creation
- `audit_unmapped_records` — find records present in one system but not the other

---

## 7. DESIGN DECISIONS for user (business logic)

These shape behavior and have no single right answer — flagged for your input during build:
1. **Conflict resolution policy** (last-write-wins vs field-level source-of-truth vs human review).
2. **Project ⇄ Opportunity vs custom object** — does a Procore project map to a standard SF
   Opportunity, or a custom `Procore_Project__c`?
3. **Sync trigger model** — fully agent-driven (tools only), fully scheduled, or hybrid (recommended).

---

## 8. Phased roadmap

- **Phase 0 — Foundation (this build):** scaffold, Streamable HTTP server, health/tools listing,
  config, token-store interface, provider-client interfaces (stubs that compile + unit-test).
- **Phase 1 — Auth:** MCP OAuth 2.1+PKCE; Procore + SF token exchange & refresh; multi-tenant store.
- **Phase 2 — Read path:** Procore + SF clients (real endpoints), MCP resources, pagination, limits.
- **Phase 3 — Write path + mapping:** upsert by external ID, mapping store, MCP sync tools.
- **Phase 4 — Real-time:** Procore webhooks + SF CDC ingestion, queue, dedup, idempotency.
- **Phase 5 — Reliability:** reconciliation cron, conflict resolution, observability, soft-deletes.
- **Phase 6 — Hardening:** rate-limit/governor-limit backoff, secrets, load test, deploy to Workers.

## 9. Verification checklist before production
- [ ] Re-verify every `[NEEDS LIVE VERIFICATION]` Procore/SF contract against live developer docs.
- [ ] Confirm Procore rate limits + Salesforce daily API/governor limits for expected volume.
- [ ] Confirm External-ID upsert semantics & Bulk API 2.0 batch limits.
- [ ] Penetration-test the OAuth 2.1 PKCE flow (DNS-rebinding/Origin validation `[VERIFIED]` MUST).
- [ ] Validate at-least-once dedup under webhook replay.
