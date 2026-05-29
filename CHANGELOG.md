# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

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
- **118 tests**, coverage ~98% statements / ~99% lines / 86% branches (gated at 95/95/85/95). ESLint + Semgrep + `npm audit` clean.
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
