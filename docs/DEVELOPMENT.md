# Development Guide

## Prerequisites
- Node.js ≥ 20, npm, `wrangler` (installed as a dev dependency).

## Install & run
```bash
npm install --legacy-peer-deps   # Agents SDK has an optional peer needing this flag
npm run dev                      # Node server on :8788
npm run worker:dev               # Worker via wrangler (DO + KV emulated)
```

## Scripts
| Script | Purpose |
|---|---|
| `npm run dev` | Watch-run the Node entrypoint (`tsx`). |
| `npm run worker:dev` | Run the Worker locally (`wrangler dev`). |
| `npm run build` | `tsc` build of the Node target → `dist/`. |
| `npm run typecheck` | Type-check Node **and** Worker targets. |
| `npm run lint` | ESLint (TypeScript + security). |
| `npm test` / `test:watch` | Vitest. |
| `npm run test:coverage` | Vitest with coverage gates (85/85/80/85). |
| `npm run audit` | `npm audit` for production deps (SCA). |
| `npm run worker:deploy` | `wrangler deploy`. |

## Project layout
```
procore-salesforce-mcp/
├─ src/
│  ├─ config.ts              # Zod-validated env config
│  ├─ auth/tokenStore.ts     # TokenStore interface + InMemoryTokenStore (Map-backed)
│  ├─ clients/
│  │  ├─ http.ts             # fetchWithRetry / fetchJson (Retry-After, backoff)
│  │  ├─ procore.ts          # ProcoreClient (auth, pagination, webhooks)
│  │  └─ salesforce.ts       # SalesforceClient (SOQL, upsert, bulk)
│  ├─ mapping/mappings.ts    # MAPPINGS registry + transforms
│  ├─ sync/
│  │  ├─ engine.ts           # SyncEngine (ingest + reconcile)
│  │  ├─ dedup.ts            # DedupStore (idempotency)
│  │  └─ conflict.ts         # resolveConflict (policy seam)
│  ├─ mcp/server.ts          # buildMcpServer — tools/resources/prompts
│  ├─ node/index.ts          # Node entrypoint (http + Streamable HTTP + webhook)
│  └─ worker/
│     ├─ index.ts            # Worker entry: McpAgent + OAuthProvider + cron/webhook
│     └─ stores.ts           # PropsTokenStore + KVDedupStore (+ KVLike)
├─ test/                     # unit/ + integration/ + helpers/
├─ public/index.html         # GUI demo / docs landing page (served via [assets])
├─ docs/                     # this documentation suite
├─ wrangler.toml             # Cloudflare config (DO, KV, cron, assets, vars)
├─ tsconfig.json             # Node target (excludes src/worker)
├─ tsconfig.worker.json      # Worker target (workers-types)
├─ lint.mjs                  # ESLint flat config (run via --config)
└─ vitest.config.ts          # test + coverage config
```

## Dual build targets
One codebase, two runtimes. Shared logic lives in `src/` and is imported by both entrypoints.
- **Node** (`tsconfig.json`): DOM + Node libs, excludes `src/worker`.
- **Worker** (`tsconfig.worker.json`): `@cloudflare/workers-types`, excludes `src/node` & tests.
`npm run typecheck` runs both so a change can't silently break one target.

## Extending
- **Add a mapping** → append an `ObjectMapping` to `MAPPINGS` (`src/mapping/mappings.ts`).
- **Add a tool** → `server.registerTool(name, { inputSchema: { … zod … } }, handler)` in
  `src/mcp/server.ts`. It becomes callable by every connected agent, with validation handled.
- **Add a provider method** → add to the relevant client; route all I/O through `fetchWithRetry`.
- **Change conflict policy** → implement `resolveConflict()` in `src/sync/conflict.ts`.

## Conventions
- Strict TypeScript; avoid `any` (lint warns).
- Centralize API paths (`PATHS` in `procore.ts`) so contract fixes are one edit.
- Prefer `Map` over dynamic object indexing for keyed lookups.
- Every new behavior gets a test; see [TESTING.md](TESTING.md).
