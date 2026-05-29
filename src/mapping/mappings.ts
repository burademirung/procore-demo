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
