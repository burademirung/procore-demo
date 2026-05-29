# Module Reference

File-by-file, export-by-export reference for `src/`. Signatures are TypeScript.

---

## `src/config.ts`
Validated, environment-driven configuration (Zod).

- **`type Config`** — inferred from `ConfigSchema`: `{ port, mcpAllowedOrigins: string[], rsTokensEncKey?, procore: {...}, salesforce: {...} }`.
- **`loadConfig(env: Record<string,string|undefined>): Config`** — parses/validates an env bag
  (`process.env` on Node, the Worker `env` on Cloudflare). `mcpAllowedOrigins` is split/trimmed into
  an array; `port` is coerced to number. Throws (fast) on invalid input.

---

## `src/auth/tokenStore.ts`
Multi-tenant, multi-provider token storage.

- **`type Provider = "procore" | "salesforce"`**
- **`interface ProviderToken`** — `{ accessToken, refreshToken?, expiresAt?, instanceUrl?, scope? }`.
- **`type TenantTokens = Partial<Record<Provider, ProviderToken>>`** (public type).
- **`interface TokenStore`**
  - `get(tenantId, provider): Promise<ProviderToken | undefined>`
  - `set(tenantId, provider, token): Promise<void>`
  - `delete(tenantId, provider): Promise<void>`
  - `tenantsWith(provider): Promise<string[]>` — tenant ids holding a token for the provider (sweep jobs).
- **`class InMemoryTokenStore implements TokenStore`** — dev/Node impl backed by nested `Map`s
  (`Map<tenantId, Map<Provider, ProviderToken>>`); no dynamic object indexing.

---

## `src/clients/http.ts`
Rate-limit-aware fetch.

- **`interface RetryOptions`** — `{ maxRetries?, baseDelayMs?, maxDelayMs? }`.
- **`class HttpError extends Error`** — `{ status, body, url }`.
- **`fetchWithRetry(url, init, opts?): Promise<Response>`** — retries `429`/`5xx`, prefers the
  `Retry-After` header, else capped exponential backoff; retries transient network errors; throws
  `HttpError` after `maxRetries`.
- **`fetchJson<T>(url, init, opts?): Promise<T>`** — `fetchWithRetry` + JSON parse; throws
  `HttpError` on non-2xx.

---

## `src/clients/procore.ts`
- **`interface ProcoreWebhookTrigger`** — `{ resource_name, event_type: "create"|"update"|"delete" }`.
- **`class ProcoreClient`** — `constructor(cfg: Config, tokens: TokenStore)`.
  - `accessToken()` *(private)* — returns a valid token, refreshing within 60s of expiry.
  - `paginate<T>(path, params?): AsyncGenerator<T>` — page/`per_page` pagination.
  - `listProjects(): Promise<unknown[]>` — all projects for `PROCORE_COMPANY_ID`.
  - `getProject(projectId): Promise<unknown>`
  - `listCompanies(): Promise<unknown[]>`
  - `createWebhookHook({ deliveryUrl, companyId?, projectId?, apiVersion? }): Promise<{id:number}>`
    — step 1 of the two-tier model (endpoint + scope).
  - `addWebhookTrigger(hookId, trigger): Promise<unknown>` — step 2 (resource + event type).
  - API paths are centralized in a private `PATHS` constant. *(Contracts: `[NEEDS LIVE VERIFICATION]`.)*

---

## `src/clients/salesforce.ts`
- **`class SalesforceClient`** — `constructor(cfg: Config, tokens: TokenStore)`.
  - `session()` *(private)* — `{ accessToken, instanceUrl }`; throws if no session.
  - `query<T>(soql): Promise<{ records: T[]; done; nextRecordsUrl? }>`
  - `upsertByExternalId(sobject, externalIdField, externalId, fields): Promise<{id, created, success}>`
    — idempotency keystone (`PATCH …/{field}/{value}`).
  - `getRecord<T>(sobject, id, fields?): Promise<T>`
  - `createRecord(sobject, fields): Promise<{id, success}>`
  - `bulkUpsert(sobject, externalIdField, records[]): Promise<{processed}>` — Phase-0 per-record
    loop; real Bulk API 2.0 job is Phase 3. *(Contracts: `[NEEDS LIVE VERIFICATION]`.)*

---

## `src/mapping/mappings.ts`
- **`type SyncDirection = "bidirectional" | "procore_to_sf" | "sf_to_procore"`**
- **`interface FieldMap`** — `{ procore: string; salesforce: string }` (procore path is dot-notation).
- **`interface ObjectMapping`** — `{ key, procoreResource, salesforceObject, sfExternalIdField, direction, fields }`.
- **`const MAPPINGS: ObjectMapping[]`** — the registry (company, project, contact, prime_contract, rfi, …).
- **`mappingForProcoreResource(resource): ObjectMapping | undefined`**
- **`mappingByKey(key): ObjectMapping | undefined`**
- **`procoreToSalesforce(mapping, record): Record<string,unknown>`** — skips null/undefined.
- **`salesforceToProcore(mapping, record): Record<string,unknown>`** — reverse; skips null/undefined.
- *(private)* `read(src, path)` — nested resolution via `Reflect.get` + own-property guard.

---

## `src/sync/dedup.ts`
- **`interface DedupStore`** — `markIfNew(eventId): Promise<boolean>` (true once per id).
- **`class InMemoryDedupStore implements DedupStore`** — Map + TTL eviction (default 24h).

## `src/sync/conflict.ts`
- **`interface ConflictInput`** — `{ objectKey, procore:{fields,updatedAt?}, salesforce:{fields,updatedAt?}, lastSynced? }`.
- **`type ConflictResolution`** — `write_to_salesforce | write_to_procore | merge | needs_human_review`.
- **`resolveConflict(input): ConflictResolution`** — default last-write-wins; the business-logic seam (`TODO(user)`).

## `src/sync/engine.ts`
- **`interface ProcoreWebhookEvent`** — `{ id, resource_name, event_type, resource_id, company_id?, project_id?, timestamp? }`.
- **`interface SyncResult`** — `{ status: "synced"|"skipped_duplicate"|"deleted"|"no_mapping"|"ignored"; detail? }`.
- **`class SyncEngine`** — `constructor(procore, salesforce, dedup)`.
  - `handleProcoreWebhook(event): Promise<SyncResult>` — dedup → map → (soft-delete | fetch+upsert).
  - `reconcileProjects(): Promise<{scanned, upserted}>` — delta sweep backstop.

---

## `src/mcp/server.ts`
- **`interface Deps`** — `{ procore, salesforce, sync }`.
- **`buildMcpServer(deps): McpServer`** — registers:
  - tools: `sync_procore_project_to_salesforce`, `run_reconciliation`, `create_procore_webhook`
  - resource: `config://mappings`
  - prompt: `audit_unmapped_records`

  Tool handlers return `{ content: [{ type: "text", text }] }`. See [API.md](API.md) for schemas.

---

## `src/node/index.ts` (Node entrypoint)
Boots `loadConfig(process.env)`, in-memory stores, clients, engine, and an HTTP server:
- `GET /healthz` → `{ ok: true }`
- `POST`/`GET /mcp` → `StreamableHTTPServerTransport` (Origin validation + DNS-rebinding protection),
  one transport per `mcp-session-id`.
- `POST /webhooks/procore` → ACK `202`, then `SyncEngine.handleProcoreWebhook` (fire-and-forget;
  Phase 4 = queue).

## `src/worker/index.ts` (Cloudflare entrypoint)
- **`interface Env`** — bindings (`ASSETS`, `MCP_OBJECT`, `OAUTH_KV`, `DEDUP_KV`) + config vars/secrets.
- **`class ProcoreSalesforceMCP extends McpAgent<Env, unknown, OAuthProps>`** — `init()` builds
  Worker-native stores + `buildMcpServer(...)` from `this.env`/`this.props`.
- `defaultHandler` — `/healthz` + `/webhooks/procore` (ACK then `ctx.waitUntil`).
- `tokenExchangeCallback` — brokers upstream Procore + Salesforce tokens into grant props *(Phase 1 stub)*.
- **`export default new OAuthProvider({...})`** — wires `apiRoute:/mcp`, auth endpoints, the agent, and the default handler.

## `src/security/webhookSignature.ts`
- **`computeHmacSha256(rawBody, secret)`** — lowercase hex HMAC-SHA256 (Web Crypto).
- **`timingSafeEqual(a, b)`** — constant-time string compare.
- **`verifyWebhookSignature(rawBody, header, secret)`** — verifies an inbound webhook signature (tolerates `sha256=` prefix).

## `src/sync/audit.ts`
- **`interface AuditEntry`** / **`AuditLog`** + **`InMemoryAuditLog`** — per-write audit trail.

## `src/sync/linkStore.ts`
- **`interface RecordLink`** / **`LinkStore`** + **`InMemoryLinkStore`** — Procore↔SF link + last-synced hash.
- **`hashFields(fields)`** — stable, order-independent FNV-1a hash (collision-safe separators).

## `src/sync/engine.ts` — added in 0.2.0
- **`SyncEngineOptions`** `{ audit?, links?, onSynced? }`; constructor accepts them; **`setNotifier(fn)`**.
- **`handleSalesforceChange(event)`** — reverse (SF CDC → Procore), CREATE-only.
- **`syncFinancials(projectId)`**, **`createCaseFromRfi(projectId, rfiId)`**.
- Private **`fetchProcoreRecord`** routes events to the correct Procore endpoint by resource scope.

## `src/clients` — added in 0.2.0
- `ProcoreClient`: **`search`**, **`getById`**, **`listProjectResource`**, **`getProjectResource`**, **`create`**.
- `SalesforceClient`: **`search`** (SOSL, escaped), **`bulkUpsertJob`** (Bulk API 2.0 with terminal polling).

## `src/worker/stores.ts`
- **`interface OAuthProps`** — `{ tenantId?, procore?, salesforce?, [k]:unknown }`.
- **`class PropsTokenStore implements TokenStore`** — reads tokens from grant props; `Map`-backed.
- **`interface KVLike`** — minimal `{ get, put }` KV shape.
- **`class KVDedupStore implements DedupStore`** — `DEDUP_KV` + `expirationTtl`.
