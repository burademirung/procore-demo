# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

## [0.5.0] — 2026-05-28 — Salesforce-native legal-document operations (Tier 1)

Six new MCP tools that work with legal documents *inside* Salesforce — all on the existing `api`
OAuth scope (no add-on), grounded in primary-source deep research (111-agent, adversarially verified).

### Added
- **`upload_contract_file`** — upload a binary document (base64 over MCP) into Salesforce Files via
  REST **multipart** `ContentVersion` (≤2 GB; *not* the ~37.5 MB base64 path) and link it to a
  Contract/record via `FirstPublishLocationId`. New `SalesforceClient.uploadContentVersion`.
- **`get_contract`**, **`list_contracts_by_status`** — read/query the standard Contract object (SOQL; status escaped against injection).
- **`submit_for_approval`**, **`list_approval_processes`** — native Process Approvals REST resource. New `SalesforceClient.processApproval` / `listApprovalProcesses`.
- **`check_signature_status`** — SOQL on the DocuSign `dsfs__DocuSign_Status__c` managed-package object; degrades gracefully (`available:false`) if absent.
- **Tests** — 3 client unit tests + 7 integration tool tests (incl. graceful DocuSign degradation + SOQL-injection guard). Suite grows 143 → **153** passing.
- **Demo page & docs** — a full-width "Legal document operations" tool card, an "Upload signed contract file" demo scenario, and updates across API/MCP_CAPABILITIES/FOR_AI_AGENTS/MODULE_REFERENCE/SPEC §4.

> Tier 2 (clause libraries, native e-sign send/void via the licensed **Salesforce Contracts** /
> Revenue Cloud product) is documented as roadmap — it requires per-org provisioning, detected at runtime.

## [0.4.0] — 2026-05-28 — ★ Legal documents (featured vertical)

### Added — legal-documents exchange (the headline capability)
- **`sync_project_legal_documents`** tool (registered first) — upserts a project's **contracts,
  insurance certificates, lien waivers and compliance records** into Salesforce custom objects by
  External ID; typed `{ synced, byObject }` output; honors `AbortSignal`.
- **`LEGAL_MAPPING_KEYS`** + four mappings (`contract_document`, `insurance_certificate`,
  `lien_waiver`, `compliance_document` → `Procore_*__c` custom objects, `Procore_Id__c`).
- **`SyncEngine.syncLegalDocuments(projectId, signal?)`** — shares the new private
  `syncProjectVertical()` driver with `syncFinancials`, so the two verticals stay identical.
- Engine `RESOURCE_SEGMENT` / `PROJECT_SCOPED` extended with the four legal resources.
- **Tests** — legal-document parity tests (mappings, engine bulk-upsert / zero-skip / abort,
  integration tool list + bulk-sync). Suite grows 137 → **143** passing.
- **Demo page & docs** — legal documents featured first: hero, a ★ featured demo scenario, a
  full-width "Legal documents" tool card leading the catalog, top of the mapping table, and
  threaded through SPEC, API, DATA_MAPPING, MCP_CAPABILITIES, FOR_AI_AGENTS & MODULE_REFERENCE.
- **Documented next layer** — syncing the underlying binary file (PDF/DOCX) into Salesforce Files
  (`ContentVersion`/`ContentDocumentLink`); see SPEC §4.

> **`[NEEDS LIVE VERIFICATION]`** — the legal-document **Procore resource names** (`ContractDocuments`,
> `InsuranceCertificates`, `LienWaivers`, `ComplianceDocuments`) and **field names** are proposals, not
> confirmed Procore API contracts. The code/tests are real, but these endpoints must be verified against
> the live Procore API (and the matching Salesforce `Procore_*__c` custom objects created) before they
> work against a real tenant. Same status as the rest of the Phase-0 mapping registry.

## [0.3.0] — 2026-05-28 — Broader MCP surface + third-review hardening

### Added — MCP capabilities (closing declared-but-unused gaps)
- **Logging** — engine emits structured `notifications/message` during sync/reconcile (+`logging/setLevel`).
- **`resources/list_changed`** — fired when a new record introduces a new resource.
- **Cancellation** — `run_reconciliation` / `sync_procore_financials` honor the client's `AbortSignal` and return partial results.
- **Pagination** — `list_procore_projects` with opaque cursors (`{ items, nextCursor }`).
- **URL-mode elicitation** — `authorize_salesforce` (SEP-1036) for out-of-band OAuth consent; degrades gracefully.

### Fixed (third independent review)
- `loadConfig` now actually reads `WEBHOOK_SECRET` (`min(1)` so an empty value fails loud).
- Constant-time `timingSafeEqual` (no length short-circuit); `recordsToCsv` escapes `\r`.
- Worker webhook narrows the parsed event to `const` before the async closure.
- Security headers extracted to a tested module (`src/security/headers.ts`).

### Quality
- **137 tests**, ~98% stmts / ~99% lines / ~89% branches (gated). Added tests proving `enc()` actually
  percent-encodes (was untestable), Bulk PUT-failure, paginate non-2xx, audit timestamps, and cancellation.
- HTTP security headers (`public/_headers` + Worker) and `/.well-known/security.txt`.

## [0.2.0] — 2026-05-28 — Advanced MCP capabilities + hardening

### Added — full MCP protocol surface
- **Sampling** (`summarize_project`) — server requests an LLM completion from the client (no server keys).
- **Elicitation** (`resolve_sync_conflict`, `dedupe_contacts`) — human-in-the-loop structured input.
- **Completion** — autocompletion for the audit prompt argument and the search resource-template variable.
- **Resource templates** — `conduit://search/{query}` (cross-system search), `procore://project/{id}`,
  `salesforce://account/{id}` (rich readable records).
- **Structured tool output + annotations** (`outputSchema`, `readOnlyHint`/`destructiveHint`/`idempotentHint`).
- **Real-time `resources/updated`** notifications emitted when a record syncs.
- **Logging** capability enabled.

### Added — sync engine & integrations
- **Reverse sync** `sync_salesforce_to_procore` / `handleSalesforceChange` (Salesforce CDC → Procore, CREATE).
- **Financial sync** `sync_procore_financials` + mappings for commitments, change orders, invoices, submittals.
- **RFI → Salesforce Case** tool.
- **Contact dedup** by normalized email (Gmail dot/+tag aware).
- **Real Bulk API 2.0 job** (`bulkUpsertJob`) with terminal-state polling.
- **Audit log** + **link/hash store** (no-op-write skipping via field hashing).

### Security & correctness (independent review fixes)
- **Webhook HMAC signature verification** (timing-safe) on both entrypoints.
- **SOSL injection** escaping in Salesforce search.
- **Resource-aware fetch dispatcher** — events fetch the correct Procore endpoint per resource type
  (was incorrectly using the projects endpoint for all resources).
- **Unique event ids** for manual/agent syncs (manual syncs no longer dedupe-swallowed).
- **Reverse UPDATE no longer duplicates** Procore records (CREATE-only until Phase 4 link index).
- **Exact Origin matching** (removed `startsWith` prefix bypass); path-param encoding; HTTP-date `Retry-After`.

### Quality
- **137 tests**, coverage ~98% statements / ~99% lines / ~89% branches (gated at 95/95/85/95). ESLint + Semgrep + `npm audit` clean.
- CI/CD (GitHub Actions), Dockerfile, example client, `server.json` manifest, issue/PR templates.

## [0.1.0] — 2026-05-28 — Phase 0 (Foundation)

### Added
- **MCP server core** — Streamable HTTP server using `@modelcontextprotocol/sdk`, dual-target
  (Node entrypoint `src/node/index.ts` + Cloudflare Worker `src/worker/index.ts`).
- **Provider clients** — `ProcoreClient` (OAuth refresh, pagination, two-tier webhooks) and
  `SalesforceClient` (SOQL, upsert-by-External-ID, bulk) over a shared retry/backoff HTTP layer.
- **Bidirectional mapping registry** — `src/mapping/mappings.ts` with field transforms.
- **Sync engine** — webhook ingestion → dedup → map → upsert, plus a reconciliation sweep.
- **Conflict resolution** — pluggable policy (`src/sync/conflict.ts`), default last-write-wins.
- **MCP surface** — tools (`sync_procore_project_to_salesforce`, `run_reconciliation`,
  `create_procore_webhook`), a resource (`config://mappings`), and a prompt
  (`audit_unmapped_records`).
- **Auth** — multi-tenant token store interface; Cloudflare `workers-oauth-provider` integration
  (OAuth 2.1 + PKCE) with a `tokenExchangeCallback` for brokering both providers.
- **Tests** — 61 unit + integration tests (Vitest), ~99% line coverage, coverage gates.
- **Deployment** — live on Cloudflare Workers with Durable Objects, KV, Cron Triggers, and a
  static-assets-served GUI demo / docs landing page.
- **Quality gates** — ESLint (typescript-eslint + eslint-plugin-security), Semgrep (SAST),
  `npm audit` (SCA): all clean.
- **Documentation** — full `docs/` suite (architecture, API, auth, mapping, sync, deployment,
  development, testing, security, module reference).

### Known limitations (tracked for Phase 1+)
- Procore & Salesforce API contracts tagged `[NEEDS LIVE VERIFICATION]` in `SPEC.md`.
- `tokenExchangeCallback` upstream exchanges are stubbed (no live credential flow yet).
- Salesforce Bulk API 2.0 is implemented as a per-record loop (job API pending Phase 3).
