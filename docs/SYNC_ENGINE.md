# Sync Engine

Implemented in `src/sync/` — `engine.ts`, `dedup.ts`, `conflict.ts`. This is the **sync plane**:
durable, asynchronous, idempotent.

## Why async (the constraint)
Procore webhooks are delivered **at-least-once** with a **5-second timeout** and exponential-backoff
retries (1s → 1hr). Two consequences drive the whole design:
1. The handler **must** return `2xx` within 5s → no synchronous downstream work in the request path.
2. Duplicates are expected → processing **must** be idempotent and dedup by event id.

## Inbound flow: Procore → Salesforce

```
Procore ──POST /webhooks/procore──▶ entrypoint
   │  (Node: src/node/index.ts · Worker: src/worker/index.ts)
   ├─ respond 202 immediately  (Worker uses ctx.waitUntil to keep processing)
   ▼
SyncEngine.handleProcoreWebhook(event):
   1. dedup.markIfNew(event.id) ── false ─▶ return { status: "skipped_duplicate" }
   2. mappingForProcoreResource(resource_name) ── none ─▶ { status: "no_mapping" }
                                              ── sf_to_procore ─▶ { status: "ignored" }
   3. event_type === "delete" ─▶ upsert { Procore_Deleted__c: true } → { status: "deleted" }
   4. fetch full record from Procore
   5. procoreToSalesforce(mapping, record)
   6. salesforce.upsertByExternalId(...) → { status: "synced" }
```

Result statuses: `synced` · `skipped_duplicate` · `deleted` · `no_mapping` · `ignored`.

## Idempotency (`dedup.ts`)
`DedupStore.markIfNew(eventId)` returns `true` exactly once per id, `false` on every replay.
- Dev/Node: `InMemoryDedupStore` (Map + TTL eviction).
- Workers: `KVDedupStore` — `DEDUP_KV` with `expirationTtl` (default 24h). Note KV is eventually
  consistent; for strict dedup under extreme concurrency, back it with Durable Object storage.

A replay-storm test (`test/integration/webhookFlow.test.ts`) asserts that N identical deliveries
yield exactly **1 synced** and **N-1 skipped**, with no duplicate writes.

## Reconciliation backstop (`engine.ts`)
`SyncEngine.reconcileProjects()` lists Procore projects and upserts each into Salesforce — a delta
sweep that heals any webhook drops (at-least-once ≠ exactly-once). Wired to the Cron Trigger
`*/30 * * * *` on Workers, and exposed as the `run_reconciliation` MCP tool.

## Outbound flow: Salesforce → Procore (Phase 4)
Salesforce **Change Data Capture** events will feed the same enqueue → dedup → map → create/update
pipeline in reverse (`salesforceToProcore` + Procore create/update). Mappings with direction
`bidirectional` or `sf_to_procore` participate.

## Conflict resolution (`conflict.ts`)
`resolveConflict(input)` returns one of:
- `{ action: "write_to_salesforce", fields }`
- `{ action: "write_to_procore", fields }`
- `{ action: "merge", toSalesforce, toProcore }`
- `{ action: "needs_human_review", reason }`

Default policy = last-write-wins by `updatedAt`, falling back to human review when timestamps are
absent. Replace with your data-ownership model (e.g. Procore owns financials, Salesforce owns
relationship fields). This is a deliberate business-logic seam — see the `TODO(user)` in the file.

## Rate limits & backoff
All provider calls go through `fetchWithRetry` (`src/clients/http.ts`): `Retry-After`-aware
exponential backoff on `429`/`5xx`, capped, with a typed `HttpError` after max retries. This
respects Procore's hourly limits and Salesforce's daily governor limits under load.
