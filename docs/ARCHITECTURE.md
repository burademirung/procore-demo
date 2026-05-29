# Architecture

## 1. The core idea: two planes

MCP tool calls are **synchronous and agent-driven**. Durable bidirectional sync is
**asynchronous and event-driven** (Procore delivers webhooks at-least-once with a 5-second
timeout). Forcing both through one path would either block tool calls or drop events. Conduit
therefore separates concerns into two planes that share the same clients and mapping layer:

- **Agent plane** — thin MCP tools/resources/prompts an LLM calls on demand (`src/mcp/server.ts`).
- **Sync plane** — a background engine: ingest webhook → ACK fast → dedup → map → upsert, with a
  cron sweep as a backstop (`src/sync/`).

## 2. Component diagram

```
            MCP client (Claude / agent / IDE)
                        │  Streamable HTTP (POST + GET), OAuth 2.1 bound token
                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        CONDUIT  (one Worker)                            │
│                                                                        │
│  workers-oauth-provider  ──issues bound token──▶  validates requests   │
│        │ tokenExchangeCallback (brokers Procore + Salesforce tokens)   │
│        ▼                                                               │
│  ┌───────────────┐                       ┌──────────────────────────┐ │
│  │  Agent plane  │                       │       Sync plane         │ │
│  │  MCP tools /  │                       │  webhook → dedup →        │ │
│  │  resources /  │                       │  reconcile (+ cron */30)  │ │
│  │  prompts      │                       └─────────────┬────────────┘ │
│  └──────┬────────┘                                     │              │
│         └───────────────┬──────────────────────────────┘              │
│                  ┌───────▼────────┐  bidirectional field transforms    │
│                  │  Mapping layer │  (MAPPINGS registry)                │
│                  └──┬──────────┬──┘                                     │
│            ┌────────▼──┐   ┌───▼─────────┐   shared retry/backoff HTTP  │
│            │ Procore   │   │ Salesforce  │   (Retry-After, 429/5xx)     │
│            │ client    │   │ client      │                             │
│            └────┬──────┘   └──────┬──────┘                             │
│         ┌───────▼─────────────────▼────────┐                          │
│         │ Token store (per tenant, Maps)   │  KV / props-backed       │
│         │ + Dedup store (event ids, TTL)   │                          │
│         └──────────────────────────────────┘                          │
└──────────▲───────────────────────────────────▲───────────────────────┘
           │ webhooks (at-least-once, 5s)       │ Change Data Capture (Phase 4)
        Procore                              Salesforce
```

## 3. Layers (bottom-up)

1. **HTTP** (`src/clients/http.ts`) — `fetchWithRetry` / `fetchJson`: honors `Retry-After`,
   exponential backoff on 429/5xx, typed `HttpError`. Every outbound call goes through it.
2. **Provider clients** (`src/clients/procore.ts`, `salesforce.ts`) — OAuth token lifecycle,
   pagination, and typed methods for the in-scope objects. API paths are centralized so an
   unverified contract is a one-line fix.
3. **Token store** (`src/auth/tokenStore.ts`, `src/worker/stores.ts`) — per-tenant, per-provider
   tokens behind a `TokenStore` interface (in-memory for dev/Node; KV/props on Workers).
4. **Mapping** (`src/mapping/mappings.ts`) — the `MAPPINGS` registry + `procoreToSalesforce` /
   `salesforceToProcore` transforms. Null/undefined are skipped so a sync never clobbers a field.
5. **Sync engine** (`src/sync/`) — `engine.ts` (ingest/reconcile), `dedup.ts` (idempotency),
   `conflict.ts` (resolution policy).
6. **MCP surface** (`src/mcp/server.ts`) — registers tools/resources/prompts onto an `McpServer`.
7. **Entrypoints** — `src/node/index.ts` (Node http + Streamable HTTP) and `src/worker/index.ts`
   (`McpAgent` Durable Object + `OAuthProvider`).

## 4. Request flows

### Agent tool call (agent plane)
```
client → POST /mcp (bound token) → OAuthProvider validates → McpAgent → tool handler
       → mapping → provider client(s) → external API → result back to client
```

### Inbound webhook (sync plane)
```
Procore → POST /webhooks/procore → ACK 202 (<5s) → enqueue/process async
        → dedup.markIfNew(eventId) → mapping → salesforce.upsertByExternalId → done
```

### Reconciliation (sync plane, backstop)
```
Cron */30 → SyncEngine.reconcileProjects() → list Procore → map → upsert each (delta sweep)
```

## 5. Why this shape (design rationale)
- **Idempotency everywhere** — at-least-once delivery means replays are expected; dedup + upsert
  make them no-ops.
- **Fast ACK** — the 5-second webhook timeout forbids synchronous downstream work in the handler.
- **Backstop reconciliation** — at-least-once ≠ exactly-once; a periodic sweep heals dropped events.
- **One codebase, two runtimes** — shared `src/` logic; only the entrypoints differ.

See [SYNC_ENGINE.md](SYNC_ENGINE.md) for sequence diagrams and [AUTHENTICATION.md](AUTHENTICATION.md)
for the OAuth topology.
