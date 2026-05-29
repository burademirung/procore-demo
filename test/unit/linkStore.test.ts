import { describe, it, expect } from "vitest";
import { InMemoryLinkStore, hashFields } from "../../src/sync/linkStore.js";

describe("hashFields", () => {
  it("is stable and order-independent", () => {
    expect(hashFields({ a: 1, b: "x" })).toBe(hashFields({ b: "x", a: 1 }));
  });
  it("changes when a value changes", () => {
    expect(hashFields({ a: 1 })).not.toBe(hashFields({ a: 2 }));
  });
});

describe("InMemoryLinkStore", () => {
  it("stores and retrieves a link by mapping key + procore id", async () => {
    const store = new InMemoryLinkStore();
    await store.set("project", { procoreId: "4821", salesforceId: "a0H", lastHash: "abc" });
    expect(await store.get("project", "4821")).toEqual({ procoreId: "4821", salesforceId: "a0H", lastHash: "abc" });
  });
  it("isolates by mapping key and returns undefined for unknown", async () => {
    const store = new InMemoryLinkStore();
    await store.set("project", { procoreId: "1" });
    expect(await store.get("company", "1")).toBeUndefined();
    expect(await store.get("project", "999")).toBeUndefined();
  });
});
