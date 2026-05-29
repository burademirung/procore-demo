import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryTokenStore } from "../../src/auth/tokenStore.js";

describe("InMemoryTokenStore", () => {
  let store: InMemoryTokenStore;
  beforeEach(() => {
    store = new InMemoryTokenStore();
  });

  it("returns undefined for an unknown tenant/provider", async () => {
    expect(await store.get("t1", "procore")).toBeUndefined();
  });

  it("stores and retrieves a token per provider without cross-talk", async () => {
    await store.set("t1", "procore", { accessToken: "p" });
    await store.set("t1", "salesforce", { accessToken: "s", instanceUrl: "https://x" });
    expect((await store.get("t1", "procore"))?.accessToken).toBe("p");
    expect((await store.get("t1", "salesforce"))?.instanceUrl).toBe("https://x");
  });

  it("isolates tenants", async () => {
    await store.set("t1", "procore", { accessToken: "p1" });
    await store.set("t2", "procore", { accessToken: "p2" });
    expect((await store.get("t2", "procore"))?.accessToken).toBe("p2");
  });

  it("deletes a provider token", async () => {
    await store.set("t1", "procore", { accessToken: "p" });
    await store.delete("t1", "procore");
    expect(await store.get("t1", "procore")).toBeUndefined();
  });

  it("lists tenants holding a given provider", async () => {
    await store.set("t1", "procore", { accessToken: "p" });
    await store.set("t2", "salesforce", { accessToken: "s" });
    await store.set("t3", "procore", { accessToken: "p3" });
    expect((await store.tenantsWith("procore")).sort()).toEqual(["t1", "t3"]);
    expect(await store.tenantsWith("salesforce")).toEqual(["t2"]);
  });
});
