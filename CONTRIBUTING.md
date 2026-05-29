# Contributing

Thanks for your interest in Conduit (the Procore ↔ Salesforce MCP server).

## Prerequisites
- Node.js ≥ 20
- npm
- A Cloudflare account (for Worker deploys) and `wrangler` (installed as a dev dependency)

## Setup
```bash
npm install --legacy-peer-deps   # the Agents SDK has an optional peer that needs this flag
cp .env.example .env             # fill in for local Node runs
```

## Day-to-day commands
| Command | What it does |
|---|---|
| `npm run dev` | Run the Node server locally on `:8788` |
| `npm run worker:dev` | Run the Worker locally via Wrangler |
| `npm run typecheck` | Type-check both the Node and Worker targets |
| `npm run lint` | ESLint (TypeScript + security rules) |
| `npm test` | Run the Vitest suite |
| `npm run test:coverage` | Tests with coverage gates (95/95/85/95) |
| `npm run audit` | `npm audit` for production deps (SCA) |

## Definition of done (before opening a PR)
1. `npm run lint` — **0 errors**.
2. `npm run typecheck` — **passes** (both targets).
3. `npm test` — **all green**, coverage thresholds met.
4. New behavior has tests (see [docs/TESTING.md](docs/TESTING.md)).
5. Any new Procore/Salesforce contract is documented and tagged if unverified.

## Code style
- Strict TypeScript; no `any` in `src/` (lint warns).
- Keep API endpoint paths centralized (e.g. `PATHS` in `procore.ts`) so contract fixes are one edit.
- Prefer `Map` over dynamic object indexing for keyed lookups (avoids object-injection sinks).
- Match the surrounding code's comment density and naming.

## Branching & commits
- Branch from `main`; one logical change per PR.
- Conventional, present-tense commit subjects (e.g. `add Salesforce bulk job support`).

## Security
Never commit secrets. Use `wrangler secret put` for Worker secrets and `.env` (git-ignored) for
local runs. See [docs/SECURITY.md](docs/SECURITY.md).
