import { describe, it, expect } from "vitest";
import { PropsTokenStore, KVDedupStore, KVLinkStore, DODedupStore, DOLinkStore, type KVLike } from "../../src/worker/stores.js";
import type { SyncStateDO } from "../../src/worker/syncStateDO.js";
import type { RecordLink } from "../../src/sync/linkStore.js";

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

describe("KVLinkStore", () => {
  it("round-trips a link by mapping key + procore id (link: prefix)", async () => {
    const kv = new FakeKV();
    const links = new KVLinkStore(kv);
    expect(await links.get("contract_document", "55")).toBeUndefined();
    await links.set("contract_document", { procoreId: "55", salesforceId: "a06x", lastHash: "abc123" });
    expect(kv.puts[0]!.key).toBe("link:contract_document::55");
    const got = await links.get("contract_document", "55");
    expect(got).toEqual({ procoreId: "55", salesforceId: "a06x", lastHash: "abc123" });
  });

  it("isolates links by mapping key", async () => {
    const kv = new FakeKV();
    const links = new KVLinkStore(kv);
    await links.set("lien_waiver", { procoreId: "55", lastHash: "h1" });
    expect(await links.get("contract_document", "55")).toBeUndefined(); // same id, different mapping
    expect((await links.get("lien_waiver", "55"))?.lastHash).toBe("h1");
  });
});

describe("DO-backed stores (adapters over the SyncStateDO stub)", () => {
  // Minimal fake of the DO RPC surface the adapters call.
  function fakeStub() {
    const dedup = new Set<string>();
    const linkMap = new Map<string, RecordLink>();
    const calls: string[] = [];
    const stub = {
      async markIfNew(id: string) {
        calls.push(`markIfNew:${id}`);
        if (dedup.has(id)) return false;
        dedup.add(id);
        return true;
      },
      async linkGet(mk: string, pid: string) {
        return linkMap.get(`${mk}::${pid}`);
      },
      async linkSet(mk: string, link: RecordLink) {
        linkMap.set(`${mk}::${link.procoreId}`, link);
      },
    };
    return { stub: stub as unknown as DurableObjectStub<SyncStateDO>, calls };
  }

  it("DODedupStore delegates markIfNew to the DO (dedups via the DO)", async () => {
    const { stub, calls } = fakeStub();
    const dedup = new DODedupStore(stub);
    expect(await dedup.markIfNew("e1")).toBe(true);
    expect(await dedup.markIfNew("e1")).toBe(false);
    expect(calls).toEqual(["markIfNew:e1", "markIfNew:e1"]);
  });

  it("DOLinkStore delegates get/set to the DO", async () => {
    const { stub } = fakeStub();
    const links = new DOLinkStore(stub);
    expect(await links.get("contract_document", "55")).toBeUndefined();
    await links.set("contract_document", { procoreId: "55", lastHash: "h1" });
    expect((await links.get("contract_document", "55"))?.lastHash).toBe("h1");
  });
});
