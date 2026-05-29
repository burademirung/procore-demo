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
- **Legal documents** (contracts, insurance certificates, lien waivers, compliance records) →
  **bidirectional** (the **featured vertical**). Procore is the document system of record, so the
  forward push (`sync_project_legal_documents`) gives legal/CRM teams a live mirror; the reverse path
  (`sync_salesforce_to_procore` / CDC) writes Salesforce edits — status, approval/review outcomes —
  back onto the Procore record. The SF record carries `Procore_Id__c` (record) and
  `Procore_Project_Id__c` (project) so the reverse write targets the right Procore document.
- **Master data** (companies, projects, contacts) → **bidirectional**.
- **Financials & project-management records** (contracts, change orders, RFIs, submittals) →
  **Procore → Salesforce** (Salesforce is rarely the source of truth for construction financials).

## The registry  — `[NEEDS LIVE VERIFICATION]` (field names are proposals)
| key | Procore resource | Direction | Salesforce object | External ID field |
|---|---|---|---|---|
| `company` | `Companies` | ⇄ bidirectional | `Account` | `Procore_Company_Id__c` |
| `project` | `Projects` | ⇄ bidirectional | `Procore_Project__c` | `Procore_Project_Id__c` |
| `contact` | `Users` | ⇄ bidirectional | `Contact` | `Procore_Contact_Id__c` |
| **`contract_document`** ★ | `ContractDocuments` | ⇄ bidirectional | `Procore_Contract_Document__c` | `Procore_Id__c` |
| **`insurance_certificate`** ★ | `InsuranceCertificates` | ⇄ bidirectional | `Procore_Insurance_Certificate__c` | `Procore_Id__c` |
| **`lien_waiver`** ★ | `LienWaivers` | ⇄ bidirectional | `Procore_Lien_Waiver__c` | `Procore_Id__c` |
| **`compliance_document`** ★ | `ComplianceDocuments` | ⇄ bidirectional | `Procore_Compliance_Document__c` | `Procore_Id__c` |
| `prime_contract` | `PrimeContracts` | → to SF | `Procore_Prime_Contract__c` | `Procore_Id__c` |
| `rfi` | `RfiS` | → to SF | `Procore_RFI__c` | `Procore_Id__c` |

★ = the featured **legal-documents** vertical (`LEGAL_MAPPING_KEYS`). Additional objects
(commitments, change orders, invoices, submittals, budget line items) are described in
[`../SPEC.md`](../SPEC.md) §4 and added the same way.

> **Document content (files).** This vertical syncs the **structured record + metadata** of each
> legal document (status, type, dates, amount), at the same level as the financial vertical. Syncing
> the underlying **binary file** (PDF/DOCX) into Salesforce Files (`ContentVersion` /
> `ContentDocumentLink`) is the documented next layer — see [`../SPEC.md`](../SPEC.md) §4.

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
