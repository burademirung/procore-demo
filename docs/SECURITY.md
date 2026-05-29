# Security

## Posture summary
| Discipline | Tool | Status |
|---|---|---|
| **SCA** (dependency vulns) | `npm audit` | **0 vulnerabilities** |
| **SAST** (static analysis) | Semgrep (`p/security-audit`, `p/xss`, `p/secrets`) + `eslint-plugin-security` | **0 findings** |
| **Lint** | ESLint + `typescript-eslint` | **0 errors** |
| **Type safety** | `tsc` strict (both targets) | passes |
| **Tests** | Vitest, ~99% lines | 153 passing |

Run them all:
```bash
npm run audit
npm run lint
npm run typecheck
npm test
npx semgrep --config p/security-audit --config p/xss --config p/secrets src public
```

## Threat model & controls
| Threat | Control |
|---|---|
| Credential leakage to the agent | Conduit issues its **own** bound token; provider keys never leave the server. |
| Token theft at rest | AES-256-GCM encryption (`RS_TOKENS_ENC_KEY`); secrets in Wrangler, not git. |
| DNS rebinding on the MCP endpoint | `Origin` validation → 403 (spec MUST); `enableDnsRebindingProtection` on the transport. |
| Auth-code interception | OAuth 2.1 + **PKCE (S256)**. |
| Forged inbound webhooks | **HMAC-SHA256 signature verification** (timing-safe) when `WEBHOOK_SECRET` is set; 401 on mismatch. |
| Search-string (SOSL) injection | Salesforce search escapes SOSL reserved characters before interpolation. |
| Path traversal in constructed URLs | Procore path components are `encodeURIComponent`-encoded. |
| Replay / duplicate webhooks | Dedup by event id + upsert-by-External-ID (idempotent). Manual syncs use fresh ids. |
| Audit / traceability | Every write records an `AuditEntry` (action, system, object, external id). |
| Object injection / prototype pollution | `Map`-based stores; `Reflect.get` + own-property guard for path walks. |
| XSS in the GUI | All network-derived values escaped before `innerHTML` (`esc()` in `public/index.html`). |
| Rate-limit abuse / cascading failure | `Retry-After`-aware exponential backoff on 429/5xx. |
| Accidental data loss on sync | null/undefined never overwrite; deletes are soft-deletes; conflicts use an explicit policy. |

## Secrets management
- **Workers:** `wrangler secret put NAME` (encrypted, never in the bundle or repo).
- **Local:** `.env` (git-ignored). `.dev.vars`, `.tokens/`, `coverage/` are also ignored.
- The repo's `wrangler.toml` contains only non-secret identifiers (account id, KV ids, public hosts).

## Notes on the `detect-object-injection` rule
The ESLint security plugin's `detect-object-injection` is a high-false-positive heuristic. Rather
than disable it, the keyed-lookup code was refactored to `Map`s and `Reflect.get` with own-property
guards, so the lint passes **without** suppressing the rule.

## Reporting
Email **burademirung@gmail.com** for any security concern. Do not open public issues for
vulnerabilities.
