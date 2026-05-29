import type { DedupStore } from "./dedup.js";
import type { LinkStore, RecordLink } from "./linkStore.js";

/**
 * Minimal key/value storage surface — the subset of Cloudflare's `DurableObjectStorage` we use.
 * Modeling it as an interface keeps `SyncState` runtime-agnostic and unit-testable with a fake Map.
 */
export interface KvStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

/**
 * Strongly-consistent dedup + link/hash state, designed to run INSIDE a single Durable Object whose
 * input gates serialize the read-modify-write — eliminating the get→put TOCTOU that Cloudflare KV's
 * eventual consistency allows (concurrent webhook retries both seeing "new", double-processing, and —
 * with reverse writes — double-inserting). The DO is the serialization boundary; this class is the
 * pure logic. See SPEC §8a.
 */
export class SyncState implements DedupStore, LinkStore {
  constructor(
    private readonly storage: KvStorage,
    /** Dedup retention; replays older than this are forgotten (pruned by the DO alarm). */
    private readonly dedupTtlMs = 24 * 60 * 60 * 1000,
  ) {}

  /** Atomic within the DO: returns true exactly once per event id, false for replays. */
  async markIfNew(eventId: string, nowMs: number = Date.now()): Promise<boolean> {
    const key = `dedup:${eventId}`;
    if ((await this.storage.get<number>(key)) !== undefined) return false;
    await this.storage.put(key, nowMs);
    return true;
  }

  async get(mappingKey: string, procoreId: string): Promise<RecordLink | undefined> {
    return this.storage.get<RecordLink>(`link:${mappingKey}::${procoreId}`);
  }

  async set(mappingKey: string, link: RecordLink): Promise<void> {
    await this.storage.put(`link:${mappingKey}::${link.procoreId}`, link);
  }

  /** Delete dedup markers older than the TTL. Returns how many were pruned. (Run from a DO alarm.) */
  async pruneDedup(nowMs: number = Date.now()): Promise<number> {
    const entries = await this.storage.list<number>({ prefix: "dedup:" });
    let pruned = 0;
    for (const [key, ts] of entries) {
      if (nowMs - ts > this.dedupTtlMs) {
        await this.storage.delete(key);
        pruned += 1;
      }
    }
    return pruned;
  }
}
