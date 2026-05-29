/**
 * Idempotency / dedup store.
 *
 * Research [VERIFIED]: Procore webhook delivery is at-least-once with possible duplicates;
 * consumers MUST dedup by event id (or ULID) and process idempotently. This store records
 * which event ids we have already handled so replays become no-ops.
 *
 * Dev impl is in-memory + TTL; production should use KV/Redis/Postgres with a TTL index.
 */
export interface DedupStore {
  /** Returns true if this is the FIRST time we've seen the id (i.e. proceed). */
  markIfNew(eventId: string): Promise<boolean>;
}

export class InMemoryDedupStore implements DedupStore {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  async markIfNew(eventId: string): Promise<boolean> {
    const now = Date.now();
    this.evict(now);
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, now + this.ttlMs);
    return true;
  }

  private evict(now: number): void {
    for (const [id, exp] of this.seen) if (exp < now) this.seen.delete(id);
  }
}
