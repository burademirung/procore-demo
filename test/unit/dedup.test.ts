import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryDedupStore } from "../../src/sync/dedup.js";

describe("InMemoryDedupStore (at-least-once webhook safety)", () => {
  afterEach(() => vi.useRealTimers());

  it("marks a new id once and rejects replays", async () => {
    const d = new InMemoryDedupStore();
    expect(await d.markIfNew("e1")).toBe(true);
    expect(await d.markIfNew("e1")).toBe(false);
    expect(await d.markIfNew("e1")).toBe(false);
  });

  it("treats distinct ids independently", async () => {
    const d = new InMemoryDedupStore();
    expect(await d.markIfNew("a")).toBe(true);
    expect(await d.markIfNew("b")).toBe(true);
  });

  it("evicts entries after the TTL so the id can be seen again", async () => {
    vi.useFakeTimers();
    const d = new InMemoryDedupStore(1000);
    expect(await d.markIfNew("e1")).toBe(true);
    vi.advanceTimersByTime(1500);
    // After TTL expiry the eviction sweep frees the id.
    expect(await d.markIfNew("e1")).toBe(true);
  });
});
