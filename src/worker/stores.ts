import type { TokenStore, Provider, ProviderToken } from "../auth/tokenStore.js";
import type { DedupStore } from "../sync/dedup.js";
import type { LinkStore, RecordLink } from "../sync/linkStore.js";

/**
 * Cloudflare-native store implementations.
 *
 * TOKENS: On Workers the per-user provider tokens (Procore + Salesforce) ride inside the
 * OAuth grant `props`, populated by `workers-oauth-provider`'s tokenExchangeCallback
 * [VERIFIED mechanism]. Within a single McpAgent session we expose those props through the
 * TokenStore interface so the shared clients work unchanged. Cross-session persistence and
 * refresh write-back are handled by the OAuth provider / a KV fallback (Phase 1).
 *
 * DEDUP: KV with expirationTtl. NOTE: KV is eventually consistent, so for strict
 * at-least-once dedup under high concurrency, back this with Durable Object storage
 * instead. Adequate for typical webhook volumes.
 */

export interface OAuthProps {
  tenantId?: string;
  procore?: ProviderToken;
  salesforce?: ProviderToken;
  [k: string]: unknown;
}

/**
 * Reads tokens from the live OAuth grant props for the current session.
 * Uses a Map internally so provider access is Map.get, not dynamic indexing.
 */
export class PropsTokenStore implements TokenStore {
  private readonly mem = new Map<Provider, ProviderToken>();
  constructor(
    private readonly tenantId: string,
    props: OAuthProps,
  ) {
    if (props.procore) this.mem.set("procore", props.procore);
    if (props.salesforce) this.mem.set("salesforce", props.salesforce);
  }

  async get(tenantId: string, provider: Provider): Promise<ProviderToken | undefined> {
    return tenantId === this.tenantId ? this.mem.get(provider) : undefined;
  }

  async set(_tenantId: string, provider: Provider, token: ProviderToken): Promise<void> {
    // In-session update (e.g. after a refresh). Durable write-back to the grant is a
    // Phase-1 concern via OAuthHelpers; for now this keeps the client working this request.
    this.mem.set(provider, token);
  }

  async delete(_tenantId: string, provider: Provider): Promise<void> {
    this.mem.delete(provider);
  }

  async tenantsWith(provider: Provider): Promise<string[]> {
    return this.mem.has(provider) ? [this.tenantId] : [];
  }
}

/** Minimal KV shape we depend on (avoids requiring full Workers types here). */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export class KVDedupStore implements DedupStore {
  constructor(
    private readonly kv: KVLike,
    private readonly ttlSeconds = 24 * 60 * 60,
  ) {}

  async markIfNew(eventId: string): Promise<boolean> {
    const key = `dedup:${eventId}`;
    if ((await this.kv.get(key)) !== null) return false;
    await this.kv.put(key, "1", { expirationTtl: this.ttlSeconds });
    return true;
  }
}

/**
 * KV-backed link/hash store so the engine's no-op skip + echo suppression actually run in the
 * Worker (where each request builds a fresh engine, so an in-memory store would be useless).
 * NOTE: KV is eventually consistent — the get→write→set is not atomic across isolates; for strict
 * correctness under concurrency this should move to Durable Object storage (Phase 4, see SPEC §5).
 */
export class KVLinkStore implements LinkStore {
  constructor(private readonly kv: KVLike) {}
  private key(mappingKey: string, procoreId: string) {
    return `link:${mappingKey}::${procoreId}`;
  }
  async get(mappingKey: string, procoreId: string): Promise<RecordLink | undefined> {
    const raw = await this.kv.get(this.key(mappingKey, procoreId));
    return raw ? (JSON.parse(raw) as RecordLink) : undefined;
  }
  async set(mappingKey: string, link: RecordLink): Promise<void> {
    await this.kv.put(this.key(mappingKey, link.procoreId), JSON.stringify(link));
  }
}
