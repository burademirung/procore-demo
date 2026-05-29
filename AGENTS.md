# AGENTS.md

Guidance for AI coding agents working **in this repository**. (If you are an agent that wants to
**use** the deployed MCP server, read [`docs/FOR_AI_AGENTS.md`](docs/FOR_AI_AGENTS.md) instead.)

## What this project is
**Conduit** — a Model Context Protocol (MCP) server that brokers **bidirectional** sync between
**Procore** (construction PM) and **Salesforce** (CRM). It exposes MCP tools/resources/prompts (the
agent plane) and runs a webhook-driven background sync engine (the sync plane). It deploys to
**Cloudflare Workers**. Full design: [`SPEC.md`](SPEC.md) and [`docs/`](docs/README.md).

## Where things live
- Logic: `src/` (config, `auth/`, `clients/`, `mapping/`, `sync/`, `mcp/`).
- Entrypoints: `src/node/index.ts` (Node) and `src/worker/index.ts` (Cloudflare).
- Tests: `test/unit/` + `test/integration/` (+ `test/helpers/`).
- Docs: `docs/` — start at [`docs/README.md`](docs/README.md); lowest level is
  [`docs/MODULE_REFERENCE.md`](docs/MODULE_REFERENCE.md).
- GUI: `public/index.html` (served via the Worker `[assets]` binding).

## Commands you must use
```bash
npm install --legacy-peer-deps   # required (Agents SDK optional peer)
npm run lint                     # ESLint (TS + security) — must be 0 errors
npm run typecheck                # node + worker targets — must pass
npm test                         # Vitest — must be all green
npm run test:coverage            # coverage gates 95/95/85/95 (165 tests)
npm run worker:deploy            # wrangler deploy (Cloudflare)
```

## Definition of done (before you claim completion)
1. `npm run lint` → 0 errors.
2. `npm run typecheck` → passes (both targets).
3. `npm test` → all pass; coverage thresholds met.
4. New behavior has tests (see [`docs/TESTING.md`](docs/TESTING.md)).
5. SAST/SCA stay clean (`npm run audit`; semgrep). See [`docs/SECURITY.md`](docs/SECURITY.md).

## Conventions (do not violate)
- **Strict TypeScript**; avoid `any` in `src/` (lint warns).
- **Centralize API paths** (e.g. `PATHS` in `clients/procore.ts`) — contract fixes should be one edit.
- **Prefer `Map`** over dynamic object indexing for keyed lookups (avoids object-injection findings).
- **Never clobber on sync** — null/undefined are skipped in transforms; deletes are soft-deletes.
- **Idempotency is sacred** — writes upsert by External ID; webhook handling dedups by event id.
- **Secrets**: never commit them. Use `wrangler secret put` / `.env` (git-ignored).
- Tag any new Procore/Salesforce contract you can't verify as `[NEEDS LIVE VERIFICATION]`.

## Gotchas
- Two TS targets: `tsconfig.json` (Node, excludes `src/worker`) and `tsconfig.worker.json`
  (Workers types, excludes `src/node`). Run **both** typechecks.
- ESLint flat config is `lint.mjs`, invoked via `--config lint.mjs` (a config-protection hook
  guards the conventional filenames).
- Deploy account must be **burademirung@gmail.com** (`wrangler whoami` to confirm).
