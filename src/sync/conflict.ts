/**
 * Conflict resolution.
 *
 * A conflict occurs when the SAME logical record changed on BOTH sides since the last
 * successful sync. Because the sync is bidirectional, we cannot blindly overwrite — doing
 * so silently loses whichever edit we didn't pick.
 *
 * This is a genuine business-logic decision (spec §7.1) with several valid strategies:
 *
 *   • last-write-wins          — newest `updatedAt` wins; simple, but can drop edits.
 *   • source-of-truth-per-side — one system always wins for this object type.
 *   • field-level merge        — take each field from whichever side changed it; richest,
 *                                but ambiguous when BOTH changed the same field.
 *   • human-review             — emit a conflict record and don't write; safest, slowest.
 *
 * The right choice depends on YOUR data ownership model: e.g. Procore may own project
 * financials while Salesforce owns the sales-side relationship fields.
 */

export interface ConflictInput {
  objectKey: string; // mapping key, e.g. "project"
  procore: { fields: Record<string, unknown>; updatedAt?: number };
  salesforce: { fields: Record<string, unknown>; updatedAt?: number };
  /** Field bags as they were at the last successful sync, for change detection. */
  lastSynced?: { procore?: Record<string, unknown>; salesforce?: Record<string, unknown> };
}

export type ConflictResolution =
  | { action: "write_to_salesforce"; fields: Record<string, unknown> }
  | { action: "write_to_procore"; fields: Record<string, unknown> }
  | { action: "merge"; toSalesforce: Record<string, unknown>; toProcore: Record<string, unknown> }
  | { action: "needs_human_review"; reason: string };

/**
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  >>> USER CONTRIBUTION REQUESTED (5–10 lines) <<<                             │
 * │                                                                               │
 * │  Implement the conflict policy for YOUR data ownership model. The default     │
 * │  below is intentionally conservative (last-write-wins by timestamp, falling   │
 * │  back to human review when timestamps are missing/equal). Replace it with     │
 * │  the strategy that matches how your org actually owns each field.             │
 * │                                                                               │
 * │  Consider:                                                                    │
 * │   - Which system is the source of truth for financials vs relationship data?  │
 * │   - Is silently dropping an edit ever acceptable, or must conflicts queue     │
 * │     for human review?                                                         │
 * │   - For "project": does Salesforce or Procore win on the name/value fields?   │
 * └─────────────────────────────────────────────────────────────────────────────┘
 */
export function resolveConflict(input: ConflictInput): ConflictResolution {
  // TODO(user): replace this default with your ownership-aware policy.
  const pUpdated = input.procore.updatedAt ?? 0;
  const sUpdated = input.salesforce.updatedAt ?? 0;

  if (pUpdated === 0 && sUpdated === 0) {
    return { action: "needs_human_review", reason: "No timestamps available to order edits." };
  }
  return pUpdated >= sUpdated
    ? { action: "write_to_salesforce", fields: input.procore.fields }
    : { action: "write_to_procore", fields: input.salesforce.fields };
}
