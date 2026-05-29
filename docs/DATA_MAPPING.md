# Data Mapping

Defined in `src/mapping/mappings.ts` as the `MAPPINGS` array. Each entry is an `ObjectMapping`.

## Mapping shape
```ts
interface ObjectMapping {
  key: string;               // stable id, e.g. "project"
  procoreResource: string;   // webhook resource_name, e.g. "Projects"
  salesforceObject: string;  // SF sobject API name
  sfExternalIdField: string; // SF External ID field → idempotency anchor
  direction: "bidirectional" | "procore_to_sf" | "sf_to_procore";
  fields: { procore: string; salesforce: string }[]; // procore path (dot-notation) ↔ SF field
}
```

## Direction rationale
- **Master data** (companies, projects, contacts) → **bidirectional**.
- **Financials & project-management records** (contracts, change orders, RFIs, submittals) →
  **Procore → Salesforce** (Salesforce is rarely the source of truth for construction financials).

## The registry  — `[NEEDS LIVE VERIFICATION]` (field names are proposals)
| key | Procore resource | Direction | Salesforce object | External ID field |
|---|---|---|---|---|
| `company` | `Companies` | ⇄ bidirectional | `Account` | `Procore_Company_Id__c` |
| `project` | `Projects` | ⇄ bidirectional | `Procore_Project__c` | `Procore_Project_Id__c` |
| `contact` | `Users` | ⇄ bidirectional | `Contact` | `Procore_Contact_Id__c` |
| `prime_contract` | `PrimeContracts` | → to SF | `Procore_Prime_Contract__c` | `Procore_Id__c` |
| `rfi` | `RfiS` | → to SF | `Procore_RFI__c` | `Procore_Id__c` |

Additional objects (commitments, change orders, invoices, submittals, budget line items) are
described in [`../SPEC.md`](../SPEC.md) §4 and added the same way.

## Field transforms
- `procoreToSalesforce(mapping, record)` → SF field bag.
- `salesforceToProcore(mapping, record)` → Procore field bag (reverse).
- Nested Procore paths use dot-notation (e.g. `primary_contact.email`); resolution uses
  `Reflect.get` with an own-property guard (no prototype traversal, no object-injection sink).
- **`null`/`undefined` are skipped** — a missing source value must never clobber the target field.
  Clearing a field is a deliberate, separate operation.

## Idempotency
All Salesforce writes use **upsert by External ID** (`PATCH …/{ExtIdField}/{value}`), so a
re-delivered Procore event re-applies the same change without creating duplicates.

## Conflict resolution
When both systems changed the same record since the last sync, `resolveConflict()`
(`src/sync/conflict.ts`) decides. Policies:
- `last-write-wins` by timestamp (the default),
- source-of-truth-per-field,
- escalate to human review.

The default never silently drops the older edit beyond what the chosen policy dictates; the loser
is preserved for audit. See [SYNC_ENGINE.md](SYNC_ENGINE.md).

## Deletes
Procore `delete` events trigger a **soft delete** in Salesforce (`Procore_Deleted__c = true`)
rather than a hard delete, preserving CRM history.

## Adding a mapping
Append one `ObjectMapping` to `MAPPINGS`. The sync engine, the `config://mappings` resource, and
the audit prompt pick it up automatically — no other code changes required.
