# Testing

Framework: **Vitest** with `@vitest/coverage-v8`. The only mocked boundary is outbound `fetch`, so
client, mapping, and engine code run for real.

## Run
```bash
npm test                 # 118 tests
npm run test:watch       # watch mode
npm run test:coverage    # enforces thresholds
```

## Coverage gates (`vitest.config.ts`)
Lines 95 · Functions 95 · Branches 85 · Statements 95. Entrypoints (`src/node/index.ts`,
`src/worker/index.ts`) are excluded — they are I/O bootstrap exercised by integration and manual
runs. Current: **~98% statements · ~99% lines · ~98% functions · 86% branches** across 118 tests.

## Layout
```
test/
├─ helpers/
│  ├─ fetchMock.ts   # installFetchMock: route-based fetch stub with response SEQUENCES
│  └─ fixtures.ts    # testConfig() + buildTestStack() (seeded tokens, wired clients/engine)
├─ unit/
│  ├─ config.test.ts          # defaults, origin parsing, coercion
│  ├─ tokenStore.test.ts      # get/set/delete/tenantsWith, isolation
│  ├─ dedup.test.ts           # markIfNew + TTL eviction
│  ├─ http.test.ts            # 429/5xx retry, Retry-After, max-retries, network errors
│  ├─ mappings.test.ts        # transforms, nested paths, null skipping
│  ├─ conflict.test.ts        # all policy branches
│  ├─ procoreClient.test.ts   # auth refresh, pagination, two-tier webhooks, headers
│  ├─ salesforceClient.test.ts# SOQL, upsert-by-ExternalId, create/read, bulk
│  ├─ syncEngine.test.ts      # synced/dup/delete/no_mapping + reconcile
│  └─ workerStores.test.ts    # PropsTokenStore + KVDedupStore (fake KV)
└─ integration/
   ├─ mcpServer.test.ts       # real MCP Client ⇄ server over in-memory transport
   └─ webhookFlow.test.ts     # end-to-end webhook → upsert + replay-storm idempotency
```

## Notable techniques
- **`installFetchMock`** supports per-route response **sequences** (e.g. `429` then `200`) to
  exercise retry/backoff deterministically; it records every call for assertions.
- **`buildTestStack`** wires real `ProcoreClient`/`SalesforceClient`/`SyncEngine` with seeded
  non-expired tokens, so tests cover the full stack against simulated HTTP.
- **MCP integration** uses the SDK's `InMemoryTransport.createLinkedPair()` to connect a real
  `Client` to `buildMcpServer(...)` — listing tools, calling tools, reading resources, rendering
  prompts, and asserting in-band `isError` results for invalid input.
- **Replay storm** fires N identical webhook deliveries concurrently and asserts exactly one
  `synced` and N-1 `skipped_duplicate`.

## Writing a test
1. `const { sync, procore, salesforce } = await buildTestStack();`
2. `const mock = installFetchMock([{ match: "/path", responses: { json: {…} } }]);`
3. Exercise the unit; assert on results and `mock.callsFor("/path")`.
4. `mock.restore()` in `afterEach`.
