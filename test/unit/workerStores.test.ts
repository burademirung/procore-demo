import { describe, it, expect } from "vitest";
import { PropsTokenStore, KVDedupStore, type KVLike } from "../../src/worker/stores.js";

class FakeKV implements KVLike {
  store = new Map<string, string>();
  puts: Array<{ key: string; opts?: { expirationTtl?: number } }> = [];
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    this.puts.push({ key, ...(opts ? { opts } : {}) });
  }
}

describe("PropsTokenStore (OAuth grant props → TokenStore)", () => {
  it("exposes Procore and Salesforce tokens carried in props", async () => {
    const store = new PropsTokenStore("t1", {
      tenantId: "t1",
      procore: { accessToken: "p" },
      salesforce: { accessToken: "s", instanceUrl: "https://i" },
    });
    expect((await store.get("t1", "procore"))?.accessToken).toBe("p");
    expect((await store.get("t1", "salesforce"))?.instanceUrl).toBe("https://i");
    expect(await store.tenantsWith("procore")).toEqual(["t1"]);
  });

  it("returns undefined for a different tenant", async () => {
    const store = new PropsTokenStore("t1", { procore: { accessToken: "p" } });
    expect(await store.get("other", "procore")).toBeUndefined();
  });

  it("supports in-session set and delete", async () => {
    const store = new PropsTokenStore("t1", {});
    await store.set("t1", "procore", { accessToken: "new" });
    expect((await store.get("t1", "procore"))?.accessToken).toBe("new");
    await store.delete("t1", "procore");
    expect(await store.get("t1", "procore")).toBeUndefined();
    expect(await store.tenantsWith("procore")).toEqual([]);
  });
});

describe("KVDedupStore", () => {
  it("marks new ids once and rejects replays, writing with a TTL", async () => {
    const kv = new FakeKV();
    const dedup = new KVDedupStore(kv, 3600);
    expect(await dedup.markIfNew("e1")).toBe(true);
    expect(await dedup.markIfNew("e1")).toBe(false);
    expect(kv.puts[0]).toMatchObject({ key: "dedup:e1", opts: { expirationTtl: 3600 } });
  });
});
