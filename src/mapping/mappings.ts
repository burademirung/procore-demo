/**
 * Bidirectional object mapping registry.
 *
 * Each entry declares how a Procore object corresponds to a Salesforce object, the
 * Salesforce External ID field used for idempotent upsert, and the sync direction.
 *
 * Direction rationale (from spec §4): master data is bidirectional; financial & PM
 * objects flow Procore→Salesforce (CRM is not the system of record for construction
 * financials).
 *
 * [NEEDS LIVE VERIFICATION] field names and the Procore↔SF object choices are proposals;
 * confirm against the customer's Salesforce schema and live Procore field sets.
 */

export type SyncDirection = "bidirectional" | "procore_to_sf" | "sf_to_procore";

export interface FieldMap {
  /** Procore field path (dot notation supported). */
  procore: string;
  /** Salesforce field API name. */
  salesforce: string;
}

export interface ObjectMapping {
  key: string;
  procoreResource: string; // resource_name used in Procore webhooks, e.g. "Projects"
  salesforceObject: string; // SF sobject API name
  /** SF External ID field holding the Procore record id (idempotency anchor). */
  sfExternalIdField: string;
  direction: SyncDirection;
  fields: FieldMap[];
  /**
   * For PROJECT-SCOPED bidirectional resources only: the Salesforce field that carries the
   * Procore project id. The reverse path (SF → Procore) reads it to know which project to
   * write under, and the forward path injects it so the SF record round-trips. e.g. "Procore_Project_Id__c".
   */
  projectIdField?: string;
}

export const MAPPINGS: ObjectMapping[] = [
  {
    key: "company",
    procoreResource: "Companies",
    salesforceObject: "Account",
    sfExternalIdField: "Procore_Company_Id__c",
    direction: "bidirectional",
    fields: [
      { procore: "name", salesforce: "Name" },
      { procore: "address", salesforce: "BillingStreet" },
      { procore: "city", salesforce: "BillingCity" },
      { procore: "state_code", salesforce: "BillingState" },
      { procore: "zip", salesforce: "BillingPostalCode" },
    ],
  },
  {
    key: "project",
    procoreResource: "Projects",
    // DESIGN DECISION (spec §7.2): standard Opportunity vs custom Procore_Project__c.
    salesforceObject: "Procore_Project__c",
    sfExternalIdField: "Procore_Project_Id__c",
    direction: "bidirectional",
    fields: [
      { procore: "name", salesforce: "Name" },
      { procore: "project_number", salesforce: "Project_Number__c" },
      { procore: "active", salesforce: "Active__c" },
      { procore: "total_value", salesforce: "Total_Value__c" },
    ],
  },
  {
    key: "contact",
    procoreResource: "Users",
    salesforceObject: "Contact",
    sfExternalIdField: "Procore_Contact_Id__c",
    direction: "bidirectional",
    fields: [
      { procore: "first_name", salesforce: "FirstName" },
      { procore: "last_name", salesforce: "LastName" },
      { procore: "email_address", salesforce: "Email" },
      { procore: "business_phone", salesforce: "Phone" },
    ],
  },
  // ── LEGAL DOCUMENTS (featured vertical) ──────────────────────────────────────
  // The contracts, certificates, waivers and compliance records that govern a job.
  // These flow Procore → Salesforce so the CRM/legal team has a live, queryable record
  // of every executed agreement and its status — the headline capability of this server.
  // Mirrors the financial-documents vertical: each is a project-scoped Procore collection
  // upserted into a Salesforce custom object, anchored by the Procore record id.
  //
  // [NEEDS LIVE VERIFICATION] — the Procore resource names below (ContractDocuments,
  // InsuranceCertificates, LienWaivers, ComplianceDocuments → segments contract_documents,
  // insurance_certificates, lien_waivers, compliance_documents) and their field names are
  // PROPOSALS, not confirmed Procore REST contracts. The sync logic is real and tested, but
  // these endpoints will 404 against a live Procore tenant until the exact resource paths and
  // fields are confirmed against the Procore API, and the matching Salesforce custom objects
  // (Procore_*__c with a Procore_Id__c External Id) are created in the target org.
  // Legal docs sync BIDIRECTIONALLY (0.6.0): Procore is the document system of record, but
  // legal/CRM edits in Salesforce (status, review/approval outcomes) flow back to Procore. The
  // reverse path recovers the Procore record id from `sfExternalIdField` and the project from
  // `projectIdField`. Conflicts resolve last-write-wins by event order (see src/sync/conflict.ts).
  {
    key: "contract_document",
    procoreResource: "ContractDocuments",
    salesforceObject: "Procore_Contract_Document__c",
    sfExternalIdField: "Procore_Id__c",
    projectIdField: "Procore_Project_Id__c",
    direction: "bidirectional",
    fields: [
      { procore: "title", salesforce: "Name" },
      { procore: "status", salesforce: "Status__c" },
      { procore: "contract_type", salesforce: "Type__c" },
      { procore: "executed_date", salesforce: "Executed_Date__c" },
      { procore: "project_id", salesforce: "Procore_Project_Id__c" },
    ],
  },
  {
    key: "insurance_certificate",
    procoreResource: "InsuranceCertificates",
    salesforceObject: "Procore_Insurance_Certificate__c",
    sfExternalIdField: "Procore_Id__c",
    projectIdField: "Procore_Project_Id__c",
    direction: "bidirectional",
    fields: [
      { procore: "certificate_number", salesforce: "Name" },
      { procore: "status", salesforce: "Status__c" },
      { procore: "expiration_date", salesforce: "Expiration_Date__c" },
      { procore: "project_id", salesforce: "Procore_Project_Id__c" },
    ],
  },
  {
    key: "lien_waiver",
    procoreResource: "LienWaivers",
    salesforceObject: "Procore_Lien_Waiver__c",
    sfExternalIdField: "Procore_Id__c",
    projectIdField: "Procore_Project_Id__c",
    direction: "bidirectional",
    fields: [
      { procore: "title", salesforce: "Name" },
      { procore: "status", salesforce: "Status__c" },
      { procore: "amount", salesforce: "Amount__c" },
      { procore: "project_id", salesforce: "Procore_Project_Id__c" },
    ],
  },
  {
    key: "compliance_document",
    procoreResource: "ComplianceDocuments",
    salesforceObject: "Procore_Compliance_Document__c",
    sfExternalIdField: "Procore_Id__c",
    projectIdField: "Procore_Project_Id__c",
    direction: "bidirectional",
    fields: [
      { procore: "title", salesforce: "Name" },
      { procore: "status", salesforce: "Status__c" },
      { procore: "due_date", salesforce: "Due_Date__c" },
      { procore: "project_id", salesforce: "Procore_Project_Id__c" },
    ],
  },
  // ── FINANCIAL DOCUMENTS ──────────────────────────────────────────────────────
  {
    key: "prime_contract",
    procoreResource: "PrimeContracts",
    salesforceObject: "Procore_Prime_Contract__c",
    sfExternalIdField: "Procore_Id__c",
    direction: "procore_to_sf",
    fields: [
      { procore: "title", salesforce: "Name" },
      { procore: "grand_total", salesforce: "Grand_Total__c" },
      { procore: "status", salesforce: "Status__c" },
    ],
  },
  {
    key: "rfi",
    procoreResource: "RfiS",
    salesforceObject: "Procore_RFI__c",
    sfExternalIdField: "Procore_Id__c",
    direction: "procore_to_sf",
    fields: [
      { procore: "subject", salesforce: "Name" },
      { procore: "status", salesforce: "Status__c" },
      { procore: "due_date", salesforce: "Due_Date__c" },
    ],
  },
  {
    key: "commitment",
    procoreResource: "Commitments",
    salesforceObject: "Procore_Commitment__c",
    sfExternalIdField: "Procore_Id__c",
    direction: "procore_to_sf",
    fields: [
      { procore: "title", salesforce: "Name" },
      { procore: "grand_total", salesforce: "Grand_Total__c" },
      { procore: "status", salesforce: "Status__c" },
    ],
  },
  {
    key: "change_order",
    procoreResource: "ChangeOrders",
    salesforceObject: "Procore_Change_Order__c",
    sfExternalIdField: "Procore_Id__c",
    direction: "procore_to_sf",
    fields: [
      { procore: "number", salesforce: "Name" },
      { procore: "amount", salesforce: "Amount__c" },
      { procore: "status", salesforce: "Status__c" },
    ],
  },
  {
    key: "invoice",
    procoreResource: "Invoices",
    salesforceObject: "Procore_Invoice__c",
    sfExternalIdField: "Procore_Id__c",
    direction: "procore_to_sf",
    fields: [
      { procore: "invoice_number", salesforce: "Name" },
      { procore: "total_amount", salesforce: "Total_Amount__c" },
      { procore: "status", salesforce: "Status__c" },
    ],
  },
  {
    key: "submittal",
    procoreResource: "Submittals",
    salesforceObject: "Procore_Submittal__c",
    sfExternalIdField: "Procore_Id__c",
    direction: "procore_to_sf",
    fields: [
      { procore: "title", salesforce: "Name" },
      { procore: "status", salesforce: "Status__c" },
      { procore: "due_date", salesforce: "Due_Date__c" },
    ],
  },
];

/**
 * Legal-document mappings that flow Procore → Salesforce (used by the legal-documents sync tool).
 * This is the featured vertical: contracts, insurance certificates, lien waivers and compliance
 * records — the documents legal/CRM teams most need mirrored into Salesforce.
 */
export const LEGAL_MAPPING_KEYS = [
  "contract_document",
  "insurance_certificate",
  "lien_waiver",
  "compliance_document",
] as const;

/** Mappings whose financials flow Procore → Salesforce (used by the financials sync tool). */
export const FINANCIAL_MAPPING_KEYS = ["prime_contract", "commitment", "change_order", "invoice"] as const;

export function mappingForProcoreResource(resource: string): ObjectMapping | undefined {
  return MAPPINGS.find((m) => m.procoreResource === resource);
}

export function mappingForSalesforceObject(sobject: string): ObjectMapping | undefined {
  return MAPPINGS.find((m) => m.salesforceObject === sobject);
}

export function mappingByKey(key: string): ObjectMapping | undefined {
  return MAPPINGS.find((m) => m.key === key);
}

/**
 * Resolve a possibly-nested field path from a source record.
 * Uses Reflect.get with an own-property guard so only the object's own keys are read
 * (never inherited/prototype props) — avoiding any object-injection / prototype traversal.
 */
function read(src: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return Object.prototype.hasOwnProperty.call(acc, k) ? Reflect.get(acc, k) : undefined;
  }, src);
}

/** Transform a Procore record into a Salesforce field bag according to the mapping. */
export function procoreToSalesforce(mapping: ObjectMapping, procoreRecord: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of mapping.fields) {
    const value = read(procoreRecord, f.procore);
    // Skip null/undefined: a missing source value must NOT clobber the target field.
    // Clearing a field should be a deliberate, explicit operation, not a sync side effect.
    if (value !== undefined && value !== null) out[f.salesforce] = value;
  }
  return out;
}

/** Transform a Salesforce record into a Procore field bag (reverse direction). */
export function salesforceToProcore(mapping: ObjectMapping, sfRecord: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of mapping.fields) {
    const value = sfRecord[f.salesforce];
    if (value !== undefined && value !== null) out[f.procore] = value;
  }
  return out;
}
