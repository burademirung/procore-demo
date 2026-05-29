# Authentication

Conduit sits between an MCP client and **two** downstream SaaS providers, so there are **three
OAuth relationships** per tenant. Getting this right is the hardest part of the system.

## The three relationships

```
   ┌────────────┐   (1) MCP client ⇄ Conduit        ┌─────────────┐
   │ MCP client │◀────── OAuth 2.1 + PKCE ──────────▶│             │
   └────────────┘   Conduit issues its OWN token     │   CONDUIT   │
                                                      │  (its own   │
   ┌────────────┐   (2) Conduit ⇄ Procore            │  OAuth AS)  │
   │  Procore   │◀────── OAuth 2.0 (code / CC) ──────▶│             │
   └────────────┘                                     │             │
   ┌────────────┐   (3) Conduit ⇄ Salesforce         │             │
   │ Salesforce │◀────── OAuth 2.0 (JWT / code) ─────▶│             │
   └────────────┘                                     └─────────────┘
```

### (1) MCP client ⇄ Conduit  — `[VERIFIED]`
Conduit is its own **OAuth 2.1 Authorization Server** (via `@cloudflare/workers-oauth-provider`).
The client never sees provider API keys; it receives a **bound token** Conduit issues for itself.
- Endpoints: `/authorize`, `/token`, `/register` (Dynamic Client Registration, RFC 7591).
- Discovery: `/.well-known/oauth-authorization-server` (RFC 8414).
- PKCE required; `code_challenge_methods_supported` advertises `S256`.
- Streamable HTTP requests to `/mcp` are rejected (401) without a valid bound token.

### (2) Conduit ⇄ Procore  — `[NEEDS LIVE VERIFICATION]`
- **User-based** (authorization-code): acts as a user; refresh-token rotation.
- **Data Connection / service account** (client-credentials): acts as the app/company.
- Token endpoint: `${PROCORE_AUTH_BASE}/oauth/token`. Access tokens are short-lived (~2h);
  `ProcoreClient.accessToken()` refreshes automatically when within 60s of expiry.

### (3) Conduit ⇄ Salesforce  — `[NEEDS LIVE VERIFICATION]`
- **JWT Bearer** (server-to-server): best for the background sync plane — no interactive refresh;
  Conduit mints a fresh signed assertion using `SF_JWT_PRIVATE_KEY`.
- **Web-server** (authorization-code): for per-user agent actions that must respect user perms.
- Session carries an `instance_url` used as the REST base.

## The keystone: `tokenExchangeCallback`  — `[VERIFIED mechanism]`
`workers-oauth-provider` invokes a `tokenExchangeCallback` when issuing/refreshing Conduit's bound
token. That is where Conduit performs the **upstream exchanges** for Procore and Salesforce and
stores both tokens in the grant `props`. One grant therefore carries **both** provider identities
per tenant.

```
authorize → user approves → Conduit gets upstream code(s)
  → tokenExchangeCallback:
        exchange code → Procore tokens     ┐
        exchange/mint → Salesforce session  ├─ store in grant props
  → issue bound MCP token to the client    ┘
```

> **Phase 0 status:** the callback scaffold exists in `src/worker/index.ts` but the upstream
> exchanges are stubbed. Wiring the real Procore + Salesforce flows is Phase 1.

## Token storage
- Interface: `TokenStore` (`src/auth/tokenStore.ts`) — `get/set/delete/tenantsWith`, keyed by
  `(tenantId, provider)`, backed by `Map`s (no dynamic object indexing).
- Workers: `PropsTokenStore` reads the live grant props; `OAUTH_KV` persists grants across sessions.
- At rest: tokens are encrypted with **AES-256-GCM** (`RS_TOKENS_ENC_KEY`).

## Security notes
- The MCP server validates the `Origin` header (403) to block DNS rebinding (spec MUST).
- Provider keys never leave the server; the agent only ever holds Conduit's bound token.
- See [SECURITY.md](SECURITY.md) for the full threat model.
