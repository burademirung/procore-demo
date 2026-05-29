/**
 * Multi-tenant token storage.
 *
 * Research finding [VERIFIED]: a single MCP server brokering TWO downstream OAuth
 * providers must hold per-tenant tokens for BOTH (Procore + Salesforce). Cloudflare's
 * `workers-oauth-provider` does this via `tokenExchangeCallback` storing results in the
 * grant `props`; here we model the equivalent store behind an interface so the Node and
 * Workers builds can back it with a file/Postgres or KV respectively.
 *
 * Tokens are sensitive — production implementations MUST encrypt at rest
 * (AES-256-GCM, key from RS_TOKENS_ENC_KEY). The in-memory impl below is for dev only.
 */

export type Provider = "procore" | "salesforce";

export interface ProviderToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires; undefined = unknown/never. */
  expiresAt?: number;
  /** Provider-specific instance host, e.g. Salesforce `instance_url`. */
  instanceUrl?: string;
  scope?: string;
}

/** All tokens a single tenant holds across providers. */
export type TenantTokens = Partial<Record<Provider, ProviderToken>>;

export interface TokenStore {
  get(tenantId: string, provider: Provider): Promise<ProviderToken | undefined>;
  set(tenantId: string, provider: Provider, token: ProviderToken): Promise<void>;
  delete(tenantId: string, provider: Provider): Promise<void>;
  /** List tenant ids that have a token for the given provider (for sweep jobs). */
  tenantsWith(provider: Provider): Promise<string[]>;
}

/**
 * Dev-only in-memory store. Replace with KV / Postgres in production.
 *
 * Backed by nested Maps (not plain objects) so provider keys are looked up via Map.get
 * rather than dynamic property indexing — removing any object-injection surface.
 */
export class InMemoryTokenStore implements TokenStore {
  private readonly data = new Map<string, Map<Provider, ProviderToken>>();

  async get(tenantId: string, provider: Provider): Promise<ProviderToken | undefined> {
    return this.data.get(tenantId)?.get(provider);
  }

  async set(tenantId: string, provider: Provider, token: ProviderToken): Promise<void> {
    const tenant = this.data.get(tenantId) ?? new Map<Provider, ProviderToken>();
    tenant.set(provider, token);
    this.data.set(tenantId, tenant);
  }

  async delete(tenantId: string, provider: Provider): Promise<void> {
    this.data.get(tenantId)?.delete(provider);
  }

  async tenantsWith(provider: Provider): Promise<string[]> {
    return [...this.data.entries()].filter(([, t]) => t.has(provider)).map(([id]) => id);
  }
}
