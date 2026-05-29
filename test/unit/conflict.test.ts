import { describe, it, expect } from "vitest";
import { resolveConflict } from "../../src/sync/conflict.js";

describe("resolveConflict (default policy)", () => {
  it("newer Procore edit wins → write to Salesforce", () => {
    const r = resolveConflict({
      objectKey: "project",
      procore: { fields: { Name: "P" }, updatedAt: 200 },
      salesforce: { fields: { Name: "S" }, updatedAt: 100 },
    });
    expect(r).toEqual({ action: "write_to_salesforce", fields: { Name: "P" } });
  });

  it("newer Salesforce edit wins → write to Procore", () => {
    const r = resolveConflict({
      objectKey: "project",
      procore: { fields: { name: "P" }, updatedAt: 100 },
      salesforce: { fields: { name: "S" }, updatedAt: 200 },
    });
    expect(r.action).toBe("write_to_procore");
  });

  it("equal timestamps resolve deterministically to Salesforce (Procore >= Salesforce)", () => {
    const r = resolveConflict({
      objectKey: "project",
      procore: { fields: {}, updatedAt: 50 },
      salesforce: { fields: {}, updatedAt: 50 },
    });
    expect(r.action).toBe("write_to_salesforce");
  });

  it("no timestamps → escalate to human review", () => {
    const r = resolveConflict({ objectKey: "project", procore: { fields: {} }, salesforce: { fields: {} } });
    expect(r.action).toBe("needs_human_review");
  });
});
