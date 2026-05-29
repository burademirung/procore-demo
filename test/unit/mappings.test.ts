import { describe, it, expect } from "vitest";
import {
  MAPPINGS,
  mappingByKey,
  mappingForProcoreResource,
  procoreToSalesforce,
  salesforceToProcore,
  type ObjectMapping,
} from "../../src/mapping/mappings.js";

describe("mapping registry lookups", () => {
  it("finds mappings by key and by Procore resource name", () => {
    expect(mappingByKey("project")?.salesforceObject).toBe("Procore_Project__c");
    expect(mappingForProcoreResource("Companies")?.key).toBe("company");
  });

  it("returns undefined for unknown lookups", () => {
    expect(mappingByKey("nope")).toBeUndefined();
    expect(mappingForProcoreResource("Nope")).toBeUndefined();
  });

  it("includes the financial & PM objects used by the advanced scenarios", () => {
    for (const key of ["commitment", "change_order", "invoice", "submittal"]) {
      expect(mappingByKey(key), `mapping ${key}`).toBeDefined();
    }
    expect(mappingForProcoreResource("ChangeOrders")?.salesforceObject).toBe("Procore_Change_Order__c");
  });

  it("every mapping declares an external id field and at least one field map", () => {
    for (const m of MAPPINGS) {
      expect(m.sfExternalIdField).toBeTruthy();
      expect(m.fields.length).toBeGreaterThan(0);
    }
  });
});

describe("field transforms", () => {
  const projectMapping = mappingByKey("project")!;

  it("maps Procore → Salesforce and omits undefined sources", () => {
    const sf = procoreToSalesforce(projectMapping, { name: "Tower", project_number: "P1" });
    expect(sf).toEqual({ Name: "Tower", Project_Number__c: "P1" });
  });

  it("maps Salesforce → Procore (reverse)", () => {
    const pc = salesforceToProcore(projectMapping, { Name: "Tower", Project_Number__c: "P1", Active__c: true });
    expect(pc).toMatchObject({ name: "Tower", project_number: "P1", active: true });
  });

  it("resolves nested Procore field paths via dot notation", () => {
    const nested: ObjectMapping = {
      key: "x",
      procoreResource: "X",
      salesforceObject: "X__c",
      sfExternalIdField: "Id__c",
      direction: "procore_to_sf",
      fields: [{ procore: "primary_contact.email", salesforce: "Email__c" }],
    };
    const sf = procoreToSalesforce(nested, { primary_contact: { email: "a@b.com" } });
    expect(sf.Email__c).toBe("a@b.com");
  });

  it("safely handles a missing nested path", () => {
    const nested: ObjectMapping = {
      key: "x",
      procoreResource: "X",
      salesforceObject: "X__c",
      sfExternalIdField: "Id__c",
      direction: "procore_to_sf",
      fields: [{ procore: "a.b.c", salesforce: "Deep__c" }],
    };
    expect(procoreToSalesforce(nested, { a: null })).toEqual({});
  });
});
