/**
 * Audit log.
 *
 * Construction + CRM data is compliance-sensitive: every write the broker makes should be
 * traceable (what changed, where, when, with what outcome). The engine records an entry per
 * write through this interface; production can back it with a database or log sink.
 */
export interface AuditEntry {
  action: "upsert" | "create" | "soft_delete" | "conflict";
  system: "procore" | "salesforce";
  object: string;
  externalId: string;
  status: string;
  at?: number;
}

export interface AuditLog {
  record(entry: AuditEntry): void;
  entries(): readonly AuditEntry[];
}

export class InMemoryAuditLog implements AuditLog {
  private readonly log: AuditEntry[] = [];
  record(entry: AuditEntry): void {
    this.log.push(entry);
  }
  entries(): readonly AuditEntry[] {
    return this.log;
  }
}
