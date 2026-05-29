# Configuration

All configuration is environment-driven and validated at boot by `src/config.ts` (Zod). A
misconfigured deployment fails fast with a clear error rather than throwing opaque 401s later.

- **Node / local:** values come from `process.env` (use a git-ignored `.env`, see `.env.example`).
- **Cloudflare Workers:** non-secret values live in `wrangler.toml` `[vars]`; secrets are set with
  `wrangler secret put NAME`.

## Variables

### MCP server
| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `8788` | Node HTTP listen port (ignored on Workers). |
| `MCP_ALLOWED_ORIGINS` | no | `http://localhost,http://127.0.0.1` | Comma-separated `Origin` allowlist for Streamable HTTP. The MCP spec **requires** Origin validation (403 on mismatch) to prevent DNS rebinding. |
| `RS_TOKENS_ENC_KEY` | prod | — | 32-byte base64 key for AES-256-GCM encryption of stored provider tokens. Set via `wrangler secret put`. |

### Procore (`https://developers.procore.com`) — `[NEEDS LIVE VERIFICATION]`
| Variable | Required | Default | Description |
|---|---|---|---|
| `PROCORE_CLIENT_ID` | yes | — | OAuth app client id. |
| `PROCORE_CLIENT_SECRET` | yes | — | OAuth app client secret (secret). |
| `PROCORE_REDIRECT_URI` | yes (user flow) | `http://localhost:8788/oauth/procore/callback` | Authorization-code redirect URI. |
| `PROCORE_AUTH_BASE` | no | `https://login.procore.com` | OAuth host. Sandbox: `https://login-sandbox.procore.com`. |
| `PROCORE_API_BASE` | no | `https://api.procore.com` | REST API host. Sandbox: `https://sandbox.procore.com`. |
| `PROCORE_COMPANY_ID` | yes | — | Default company scope for company-scoped calls & webhooks. |

### Salesforce (`https://developer.salesforce.com`) — `[NEEDS LIVE VERIFICATION]`
| Variable | Required | Default | Description |
|---|---|---|---|
| `SF_LOGIN_URL` | no | `https://login.salesforce.com` | Login host. Sandbox: `https://test.salesforce.com`. |
| `SF_CLIENT_ID` | yes | — | Connected App consumer key. |
| `SF_CLIENT_SECRET` | yes (web flow) | — | Connected App consumer secret (secret). |
| `SF_USERNAME` | yes (JWT flow) | — | Integration user for the JWT bearer flow. |
| `SF_JWT_PRIVATE_KEY` | yes (JWT flow) | — | PEM private key for JWT bearer assertions (secret). |
| `SF_REDIRECT_URI` | yes (web flow) | `http://localhost:8788/oauth/salesforce/callback` | Web-server flow redirect URI. |
| `SF_API_VERSION` | no | `v62.0` | Salesforce REST API version path segment. |

## Cloudflare bindings (set in `wrangler.toml`, not env)
| Binding | Type | Purpose |
|---|---|---|
| `MCP_OBJECT` | Durable Object (`ProcoreSalesforceMCP`) | One stateful MCP session per instance. |
| `OAUTH_KV` | KV namespace | OAuth grants + brokered provider tokens. |
| `DEDUP_KV` | KV namespace | Webhook event-id dedup (TTL). |
| `ASSETS` | Assets | Serves the `public/` GUI. |

## Setting secrets (Workers)
```bash
wrangler secret put PROCORE_CLIENT_SECRET
wrangler secret put SF_CLIENT_SECRET
wrangler secret put SF_JWT_PRIVATE_KEY
wrangler secret put RS_TOKENS_ENC_KEY
```
Never commit secrets. `.env`, `.dev.vars`, and `.tokens/` are git-ignored.
