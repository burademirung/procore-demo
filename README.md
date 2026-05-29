# Procore ↔ Salesforce MCP Server — Legal Documents

A remote **Model Context Protocol (MCP)** server whose **featured capability** is **legal-document
exchange**: it syncs a project's **contracts, insurance certificates, lien waivers and compliance
records** from [Procore](https://www.procore.com/) into Salesforce (via `sync_project_legal_documents`),
and also brokers **bidirectional** sync of projects, financials and contacts between the two systems.
It exposes agent-callable **tools / resources / prompts** and runs a durable background
**reconciliation engine** for webhook-driven sync. Legal documents sync **bidirectionally** —
Procore is the system of record, and legal/CRM edits in Salesforce (status, approval outcomes) flow
back to Procore. Beyond metadata, it also works with documents **inside Salesforce** — uploading
signed files to Contracts (`upload_contract_file` → ContentVersion), querying Contracts, routing
records for approval, and checking e-signature status — all on the standard `api` OAuth scope.

> Architecture, data mapping, auth design, and the phased roadmap live in **[SPEC.md](./SPEC.md)**.
> Claims in the spec are tagged `[VERIFIED]` (primary-sourced research) or
> `[NEEDS LIVE VERIFICATION]` (confirm against live Procore/Salesforce docs before prod).

## Why this shape

MCP tool calls are request/response and agent-driven, but durable bidirectional sync needs a
queue + dedup + scheduler. So the server has **two planes**:

- **Agent plane** — thin MCP tools for on-demand reads/writes (`src/mcp/server.ts`).
- **Sync plane** — webhook ingestion → dedup → reconcile, plus a cron backstop (`src/sync/`).

```
MCP client ──Streamable HTTP──▶ MCP server ──▶ mapping ──▶ Procore client
                                    │                  └──▶ Salesforce client
Procore webhooks ──▶ /webhooks/procore ──▶ dedup ──▶ sync engine ──▶ Salesforce upsert
```

## Layout

| Path | Purpose |
|---|---|
| `src/config.ts` | Validated env config (zod) |
| `src/auth/tokenStore.ts` | Multi-tenant, dual-provider token storage interface |
| `src/clients/http.ts` | Rate-limit-aware retry/backoff fetch |
| `src/clients/procore.ts` | Procore API client (auth refresh, pagination, **webhooks two-tier model**) |
| `src/clients/salesforce.ts` | Salesforce client (SOQL, **upsert-by-External-ID**, bulk) |
| `src/mapping/mappings.ts` | Object/field mapping registry — incl. **`LEGAL_MAPPING_KEYS`** (★ featured) + `FINANCIAL_MAPPING_KEYS` |
| `src/sync/conflict.ts` | Conflict-resolution policy (**your business logic** — see TODO) |
| `src/sync/dedup.ts` | Idempotency store (at-least-once webhook safety) |
| `src/sync/engine.ts` | Webhook → map → upsert + reconciliation sweep |
| `src/mcp/server.ts` | MCP tools / resources / prompts — **`sync_project_legal_documents`** registered first (★ featured) |
| `src/node/index.ts` | Node entrypoint (Streamable HTTP + webhook receiver) |
| `src/worker/` | **Cloudflare Workers entrypoint (primary deploy target)** |

## Develop & test

```bash
npm install --legacy-peer-deps
npm run typecheck        # node + worker targets
npm test                 # 165 tests
npm run test:coverage    # enforces 95/95/85/95 thresholds (lines/functions/branches/statements)
npm run dev              # local Node server on :8788
```

Test framework (Vitest): unit tests per module + **integration tests** that drive a real MCP
`Client` against the server over an in-memory transport, and a full webhook→sync flow. The
only mocked boundary is outbound HTTP (`test/helpers/fetchMock.ts`), so client/engine code
runs for real.

## Deploy to Cloudflare (primary)

Uses `McpAgent` (Durable Object per session) + `@cloudflare/workers-oauth-provider`.

```bash
# 1. Authenticate as the deployment account (burademirung@gmail.com):
npx wrangler login          # or: npm run cf:login
npx wrangler whoami         # confirm the active account

# 2. Create KV namespaces and paste the ids into wrangler.toml:
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create DEDUP_KV

# 3. Set secrets (never commit these):
npx wrangler secret put PROCORE_CLIENT_ID
npx wrangler secret put PROCORE_CLIENT_SECRET
npx wrangler secret put SF_CLIENT_ID
npx wrangler secret put SF_CLIENT_SECRET
npx wrangler secret put SF_JWT_PRIVATE_KEY     # JWT bearer flow
npx wrangler secret put RS_TOKENS_ENC_KEY      # AES-256-GCM key (base64)

# 4. Validate the bundle, then ship:
npx wrangler deploy --dry-run --outdir /tmp/build
npm run worker:deploy
```

MCP endpoint: `POST/GET https://<worker>.workers.dev/mcp` ·
Webhook receiver: `POST /webhooks/procore` · Health: `GET /healthz`.

## Status / next phases

Phase 0 (this build) is complete: scaffold, dual-target server, clients, mapping, sync engine,
MCP surface, and a full test suite. Phases 1–6 (live OAuth flows, real endpoint contracts,
Bulk API 2.0 jobs, SF Change Data Capture, conflict policy, hardening) are tracked in
[SPEC.md](./SPEC.md) §8. Re-verify every `[NEEDS LIVE VERIFICATION]` API contract before prod.
