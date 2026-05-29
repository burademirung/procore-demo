/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import { SyncState, type KvStorage } from "../sync/syncState.js";
import type { RecordLink } from "../sync/linkStore.js";

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Durable Object holding sync state (webhook dedup + link/hash) with STRONG consistency. A single
 * named instance ("global") serializes all read-modify-write through the DO's input gates, so the
 * dedup get→put can't interleave across Worker isolates the way KV allows — closing the double-
 * process / double-insert race (see SPEC §8a). RPC methods are callable directly on the stub.
 */
export class SyncStateDO extends DurableObject {
  private readonly state = new SyncState(this.ctx.storage as unknown as KvStorage);

  async markIfNew(eventId: string): Promise<boolean> {
    const isNew = await this.state.markIfNew(eventId, Date.now());
    // Ensure a periodic prune is scheduled so dedup markers don't accumulate forever.
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    return isNew;
  }

  async linkGet(mappingKey: string, procoreId: string): Promise<RecordLink | undefined> {
    return this.state.get(mappingKey, procoreId);
  }

  async linkSet(mappingKey: string, link: RecordLink): Promise<void> {
    return this.state.set(mappingKey, link);
  }

  /** Periodic dedup prune; reschedules itself. */
  override async alarm(): Promise<void> {
    await this.state.pruneDedup(Date.now());
    await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
  }
}
