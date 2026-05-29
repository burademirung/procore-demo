import { describe, it, expect } from "vitest";
import { SyncState, type KvStorage } from "../../src/sync/syncState.js";

/** Map-backed fake of the DO storage surface, so SyncState is tested without the Workers runtime. */
class FakeStorage implements KvStorage {
  m = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.m.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.m.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.m.delete(key);
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of this.m) if (!options?.prefix || k.startsWith(options.prefix)) out.set(k, v as T);
    return out;
  }
}

describe("SyncState (strongly-consistent dedup + link)", () => {
  it("marks an event new exactly once, then rejects replays", async () => {
    const s = new SyncState(new FakeStorage());
    expect(await s.markIfNew("e1", 1000)).toBe(true);
    expect(await s.markIfNew("e1", 2000)).toBe(false);
    expect(await s.markIfNew("e2", 2000)).toBe(true);
  });

  it("round-trips a link keyed by mapping + procore id", async () => {
    const s = new SyncState(new FakeStorage());
    expect(await s.get("contract_document", "55")).toBeUndefined();
    await s.set("contract_document", { procoreId: "55", salesforceId: "a06x", lastHash: "h1" });
    expect(await s.get("contract_document", "55")).toEqual({ procoreId: "55", salesforceId: "a06x", lastHash: "h1" });
    expect(await s.get("lien_waiver", "55")).toBeUndefined(); // isolated by mapping key
  });

  it("prunes only dedup markers older than the TTL (leaves links and fresh markers)", async () => {
    const storage = new FakeStorage();
    const s = new SyncState(storage, 1000); // 1s TTL
    await s.markIfNew("old", 0);
    await s.markIfNew("fresh", 5000);
    await s.set("contract_document", { procoreId: "1", lastHash: "h" });
    const pruned = await s.pruneDedup(5500); // old (age 5500) > 1000 → gone; fresh (age 500) stays
    expect(pruned).toBe(1);
    expect(await s.markIfNew("old", 6000)).toBe(true); // forgotten → treated as new again
    expect(await s.markIfNew("fresh", 6000)).toBe(false); // still remembered
    expect(await s.get("contract_document", "1")).toBeDefined(); // links untouched by dedup prune
  });
});
