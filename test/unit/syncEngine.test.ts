import { describe, it, expect, afterEach } from "vitest";
import { buildTestStack } from "../helpers/fixtures.js";
import { installFetchMock } from "../helpers/fetchMock.js";
import { SyncEngine, type ProcoreWebhookEvent } from "../../src/sync/engine.js";
import { InMemoryAuditLog } from "../../src/sync/audit.js";
import { InMemoryLinkStore } from "../../src/sync/linkStore.js";

const baseEvent: ProcoreWebhookEvent = {
  id: "evt-1",
  resource_name: "Projects",
  event_type: "update",
  resource_id: 42,
};

describe("SyncEngine.handleProcoreWebhook", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("syncs a Procore project into Salesforce (fetch → map → upsert)", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/42", responses: { json: { id: 42, name: "Tower", project_number: "P-9" } } },
      { match: "/sobjects/Procore_Project__c/", responses: { json: { id: "a", success: true, created: true } } },
    ]);
    const result = await sync.handleProcoreWebhook({ ...baseEvent });
    expect(result.status).toBe("synced");
    const upsert = mock.callsFor("/sobjects/Procore_Project__c/")[0]!;
    expect(upsert.url).toContain("/Procore_Project_Id__c/42");
    expect(JSON.parse(upsert.body!)).toMatchObject({ Name: "Tower", Project_Number__c: "P-9" });
  });

  it("is idempotent — a replayed event id is skipped with no side effects", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/42", responses: { json: { id: 42, name: "Tower" } } },
      { match: "/sobjects/Procore_Project__c/", responses: { json: { id: "a", success: true } } },
    ]);
    expect((await sync.handleProcoreWebhook({ ...baseEvent })).status).toBe("synced");
    const callsAfterFirst = mock.calls.length;
    expect((await sync.handleProcoreWebhook({ ...baseEvent })).status).toBe("skipped_duplicate");
    expect(mock.calls.length).toBe(callsAfterFirst); // no additional I/O
  });

  it("soft-deletes in Salesforce on a delete event (preserving CRM history)", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/sobjects/Procore_Project__c/", responses: { json: { id: "a", success: true } } },
    ]);
    const result = await sync.handleProcoreWebhook({ ...baseEvent, id: "evt-del", event_type: "delete" });
    expect(result.status).toBe("deleted");
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ Procore_Deleted__c: true });
  });

  it("returns no_mapping for an unmapped resource and performs no I/O", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([{ match: "__never__", responses: { json: {} } }]);
    const result = await sync.handleProcoreWebhook({ ...baseEvent, id: "evt-x", resource_name: "Unknown" });
    expect(result.status).toBe("no_mapping");
    expect(mock.calls).toHaveLength(0);
  });
});

describe("SyncEngine.reconcileProjects", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("sweeps all Procore projects into Salesforce and reports counts", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rest/v1.0/projects", responses: { json: [{ id: 1, name: "A" }, { id: 2, name: "B" }] } },
      { match: "/sobjects/Procore_Project__c/", responses: { json: { id: "x", success: true } } },
    ]);
    const result = await sync.reconcileProjects();
    expect(result).toEqual({ scanned: 2, upserted: 2 });
    expect(mock.callsFor("/sobjects/Procore_Project__c/")).toHaveLength(2);
  });

  it("skips records without an id", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rest/v1.0/projects", responses: { json: [{ name: "no-id" }, { id: 5, name: "ok" }] } },
      { match: "/sobjects/Procore_Project__c/", responses: { json: { id: "x", success: true } } },
    ]);
    const result = await sync.reconcileProjects();
    expect(result).toEqual({ scanned: 2, upserted: 1 });
  });
});

describe("SyncEngine.syncFinancials", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("bulk-upserts each financial object type into Salesforce", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/7/", responses: { json: [
        { id: 1, title: "X", grand_total: 100, status: "open", number: "CO-1", amount: 50, invoice_number: "INV-1", total_amount: 200 },
        { title: "no-id record — must be skipped" },
      ] } },
      { match: "/sobjects/", responses: { json: { id: "x", success: true, created: true } } },
    ]);
    const result = await sync.syncFinancials(7);
    // 4 financial mappings (prime_contract, commitment, change_order, invoice), 1 record each
    expect(result.synced).toBe(4);
    expect(result.byObject["Procore_Commitment__c"]).toBe(1);
    expect(result.byObject["Procore_Change_Order__c"]).toBe(1);
  });
});

describe("SyncEngine.createCaseFromRfi", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("creates a Salesforce Case from a Procore RFI and links them", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rfis/214", responses: { json: { id: 214, subject: "Curtain wall conflict", body: "details" } } },
      { match: "/sobjects/Case", responses: { json: { id: "500x9", success: true } } },
    ]);
    const result = await sync.createCaseFromRfi(7, 214);
    expect(result).toEqual({ caseId: "500x9", rfiId: "214" });
    const caseCall = mock.callsFor("/sobjects/Case")[0]!;
    expect(JSON.parse(caseCall.body!)).toMatchObject({ Subject: "Curtain wall conflict", Procore_RFI_Id__c: "214" });
  });

  it("falls back to a generated subject when the RFI has none", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rfis/9", responses: { json: { id: 9 } } },
      { match: "/sobjects/Case", responses: { json: { id: "500c", success: true } } },
    ]);
    await sync.createCaseFromRfi(7, 9);
    expect(JSON.parse(mock.callsFor("/sobjects/Case")[0]!.body!).Subject).toBe("RFI 9");
  });
});

describe("SyncEngine options — audit, notifier, no-op skip", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("records an audit entry and emits a notification on sync", async () => {
    const { procore, salesforce, dedup } = await buildTestStack();
    const audit = new InMemoryAuditLog();
    const notes: Array<{ object: string; externalId: string }> = [];
    const engine = new SyncEngine(procore, salesforce, dedup, { audit, onSynced: (i) => notes.push(i) });
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/42", responses: { json: { id: 42, name: "Tower" } } },
      { match: "/sobjects/Procore_Project__c/", responses: { json: { id: "a", success: true } } },
    ]);
    expect((await engine.handleProcoreWebhook({ ...baseEvent })).status).toBe("synced");
    expect(audit.entries()).toHaveLength(1);
    expect(audit.entries()[0]).toMatchObject({ action: "upsert", system: "salesforce", externalId: "42" });
    expect(notes).toEqual([{ system: "salesforce", object: "Procore_Project__c", externalId: "42" }]);
  });

  it("skips a no-op write when the field hash is unchanged", async () => {
    const { procore, salesforce, dedup } = await buildTestStack();
    const links = new InMemoryLinkStore();
    const engine = new SyncEngine(procore, salesforce, dedup, { links });
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/42", responses: { json: { id: 42, name: "Tower", project_number: "P-9" } } },
      { match: "/sobjects/Procore_Project__c/", responses: { json: { id: "a", success: true } } },
    ]);
    expect((await engine.handleProcoreWebhook({ ...baseEvent, id: "e1" })).status).toBe("synced");
    const sfWritesAfterFirst = mock.callsFor("/sobjects/").length; // 1
    const totalAfterFirst = mock.calls.length;
    // Same record, new event id (passes dedup) → hash unchanged → skipped, no SF write.
    expect((await engine.handleProcoreWebhook({ ...baseEvent, id: "e2" })).status).toBe("skipped_unchanged");
    expect(mock.callsFor("/sobjects/").length).toBe(sfWritesAfterFirst); // no new Salesforce write
    expect(mock.calls.length).toBeGreaterThan(totalAfterFirst); // but it DID re-fetch the Procore record
  });
});

describe("SyncEngine.handleSalesforceChange (reverse: SF → Procore)", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("creates a Procore record from a Salesforce change", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([{ match: "/rest/v1.0/projects", responses: { json: { id: 9001 } } }]);
    const result = await sync.handleSalesforceChange({
      id: "cdc-1",
      sobject: "Procore_Project__c",
      changeType: "CREATE",
      fields: { Name: "Won Deal Tower", Project_Number__c: "WD-1" },
    });
    expect(result.status).toBe("synced");
    expect(result.detail).toContain("projects#9001");
    expect(JSON.parse(mock.calls[0]!.body!)).toMatchObject({ name: "Won Deal Tower", project_number: "WD-1" });
  });

  it("returns no_mapping for an unknown object and dedups replays", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([{ match: "__never__", responses: { json: {} } }]);
    expect((await sync.handleSalesforceChange({ id: "x1", sobject: "Unknown__c", changeType: "UPDATE", fields: {} })).status).toBe("no_mapping");
    expect((await sync.handleSalesforceChange({ id: "x1", sobject: "Account", changeType: "UPDATE", fields: {} })).status).toBe("skipped_duplicate");
  });

  it("ignores objects whose mapping flows the other direction", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([{ match: "__never__", responses: { json: {} } }]);
    const r = await sync.handleSalesforceChange({ id: "rfi-rev", sobject: "Procore_RFI__c", changeType: "UPDATE", fields: {} });
    expect(r.status).toBe("ignored");
  });

  it("does NOT duplicate a Procore record on a reverse UPDATE (only CREATE creates)", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([{ match: "/rest/v1.0/projects", responses: { json: { id: 1 } } }]);
    const r = await sync.handleSalesforceChange({ id: "u1", sobject: "Procore_Project__c", changeType: "UPDATE", fields: { Name: "X" } });
    expect(r.status).toBe("ignored");
    expect(mock.calls).toHaveLength(0); // no Procore create call was made
  });
});

describe("SyncEngine resource-aware fetch routing", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("fetches a project-scoped RFI from the project endpoint, not /projects/{id}", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/700/rfis/214", responses: { json: { id: 214, subject: "Wall", status: "open" } } },
      { match: "/sobjects/Procore_RFI__c/", responses: { json: { id: "a", success: true } } },
    ]);
    const result = await sync.handleProcoreWebhook({
      id: "rfi-evt",
      resource_name: "RfiS",
      event_type: "update",
      resource_id: 214,
      project_id: 700,
    });
    expect(result.status).toBe("synced");
    expect(mock.callsFor("/rest/v1.0/projects/700/rfis/214")).toHaveLength(1);
  });
});
