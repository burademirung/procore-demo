/**
 * Link / state store.
 *
 * Bidirectional sync needs to remember the correspondence between a Procore record and its
 * Salesforce counterpart, plus a hash of the last-synced field bag so we can:
 *   • avoid no-op writes (skip when nothing changed), and
 *   • detect conflicts (both sides changed since the last sync).
 *
 * Keyed by the stable Procore external id per mapping. In-memory impl for dev; back with KV /
 * Postgres in production.
 */
export interface RecordLink {
  procoreId: string;
  salesforceId?: string;
  /** Hash of the last field bag we successfully synced. */
  lastHash?: string;
}

export interface LinkStore {
  get(mappingKey: string, procoreId: string): Promise<RecordLink | undefined>;
  set(mappingKey: string, link: RecordLink): Promise<void>;
}

export class InMemoryLinkStore implements LinkStore {
  private readonly data = new Map<string, RecordLink>();
  private key(mappingKey: string, procoreId: string) {
    return `${mappingKey}::${procoreId}`;
  }
  async get(mappingKey: string, procoreId: string): Promise<RecordLink | undefined> {
    return this.data.get(this.key(mappingKey, procoreId));
  }
  async set(mappingKey: string, link: RecordLink): Promise<void> {
    this.data.set(this.key(mappingKey, link.procoreId), link);
  }
}

/** Stable, order-independent hash of a field bag (FNV-1a over sorted key=value pairs). */
export function hashFields(fields: Record<string, unknown>): string {
  // \x01 / \x00 separators can't appear in field names or normal values, so distinct field bags
  // can't collide via separator confusion (e.g. {a:"x&b=y"} vs {a:"x", b:"y"}).
  const serialized = Object.keys(fields)
    .sort()
    .map((k) => `${k}\x01${String(Reflect.get(fields, k))}`)
    .join("\x00");
  let h = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    h ^= serialized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
