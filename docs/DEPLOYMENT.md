# Deployment (Cloudflare Workers)

Conduit deploys as a **single Worker** combining an OAuth 2.1 server, a per-session Durable Object,
KV storage, a cron trigger, and static assets. Live:
`https://procore-salesforce-mcp.burademirung.workers.dev`.

## Topology (`wrangler.toml`)
| Resource | Binding / value | Purpose |
|---|---|---|
| Worker entry | `main = src/worker/index.ts` | OAuthProvider + McpAgent + webhook receiver |
| Compatibility | `nodejs_compat`, `compatibility_date = 2025-05-01` | Node APIs on Workers |
| Durable Object | `MCP_OBJECT` → `ProcoreSalesforceMCP` (migration `v1`, SQLite) | per-session MCP state |
| KV | `OAUTH_KV` | OAuth grants + brokered tokens |
| KV | `DEDUP_KV` | webhook event-id dedup (TTL) |
| Assets | `[assets] directory = ./public` (`ASSETS`) | GUI / docs landing page |
| Cron | `crons = ["*/30 * * * *"]` | reconciliation backstop |
| Observability | `[observability] enabled = true` | Workers Logs |
| Account | `account_id` | pins the deploy to the correct account |

## First-time provisioning
```bash
# 1. Authenticate the deploy account
wrangler login                 # sign in as burademirung@gmail.com
wrangler whoami                # confirm the active account

# 2. Create the KV namespaces, then paste the ids into wrangler.toml
wrangler kv namespace create OAUTH_KV
wrangler kv namespace create DEDUP_KV

# 3. Set secrets (never committed)
wrangler secret put PROCORE_CLIENT_SECRET
wrangler secret put SF_CLIENT_SECRET
wrangler secret put SF_JWT_PRIVATE_KEY
wrangler secret put RS_TOKENS_ENC_KEY     # 32-byte base64, AES-256-GCM
```

## Deploy
```bash
npm run typecheck                         # node + worker targets
npm test                                  # 165 tests
wrangler deploy --dry-run --outdir /tmp/build   # validate the bundle (no upload)
npm run worker:deploy                     # = wrangler deploy
```
Observed: ~324 KB gzip bundle, ~65 ms startup.

## Verify a deploy
```bash
curl -s https://<worker>.workers.dev/healthz                    # {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" -X POST .../mcp        # 401 (OAuth-gated)
curl -s .../.well-known/oauth-authorization-server | jq .       # discovery doc
```

## Local development
- `npm run dev` — Node server (`src/node/index.ts`) on `:8788`.
- `npm run worker:dev` — Worker locally via `wrangler dev` (Durable Objects + KV emulated).

## Rollback
`wrangler deployments list` then `wrangler rollback [--version-id <id>]`. Each deploy prints a
`Current Version ID` for reference.

## Production checklist
- [ ] Re-verify every `[NEEDS LIVE VERIFICATION]` contract (see [`../SPEC.md`](../SPEC.md) §9).
- [ ] Confirm Procore rate limits & Salesforce governor limits for expected volume.
- [ ] Penetration-test the OAuth 2.1 PKCE flow (Origin validation / DNS-rebinding).
- [ ] Validate dedup under webhook replay.
- [ ] Custom domain (optional) via `routes`/`custom_domains` in `wrangler.toml`.
