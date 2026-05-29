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
    expect(mock.calls[0]!.url).toContain("/Procore_Project_Id__c/42"); // correct external-id field + id
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

describe("SyncEngine.syncLegalDocuments", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("bulk-upserts each legal-document type into Salesforce", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/7/", responses: { json: [
        { id: 1, title: "Prime Agreement", status: "executed", contract_type: "Prime", executed_date: "2026-01-04",
          certificate_number: "COI-9", expiration_date: "2027-01-01", amount: 5000, due_date: "2026-06-01" },
        { title: "no-id record — must be skipped" },
      ] } },
      { match: "/sobjects/", responses: { json: { id: "x", success: true, created: true } } },
    ]);
    const result = await sync.syncLegalDocuments(7);
    // 4 legal mappings (contract_document, insurance_certificate, lien_waiver, compliance_document), 1 record each
    expect(result.synced).toBe(4);
    expect(result.byObject["Procore_Contract_Document__c"]).toBe(1);
    expect(result.byObject["Procore_Insurance_Certificate__c"]).toBe(1);
    expect(result.byObject["Procore_Lien_Waiver__c"]).toBe(1);
    expect(result.byObject["Procore_Compliance_Document__c"]).toBe(1);
    // each legal collection is fetched from its correct, distinct Procore URL segment
    expect(mock.callsFor("/projects/7/contract_documents")).toHaveLength(1);
    expect(mock.callsFor("/projects/7/insurance_certificates")).toHaveLength(1);
    expect(mock.callsFor("/projects/7/lien_waivers")).toHaveLength(1);
    expect(mock.callsFor("/projects/7/compliance_documents")).toHaveLength(1);
  });

  it("aborts mid-loop and returns PARTIAL results (cancellation honored between collections)", async () => {
    const { sync } = await buildTestStack();
    const ac = new AbortController();
    mock = installFetchMock([
      {
        match: "/rest/v1.0/projects/7/",
        // Abort right after the first legal collection is fetched, so the loop breaks before the rest.
        responses: () => {
          ac.abort();
          return { json: [{ id: 1, title: "Prime Agreement", status: "executed" }] };
        },
      },
      { match: "/sobjects/", responses: { json: { id: "x", success: true } } },
    ]);
    const result = await sync.syncLegalDocuments(7, ac.signal);
    // Only the first collection (contract_document) was processed — partial result, not zero, not all four.
    expect(result.synced).toBe(1);
    expect(Object.keys(result.byObject)).toEqual(["Procore_Contract_Document__c"]);
    expect(mock.callsFor("/projects/7/contract_documents")).toHaveLength(1);
    expect(mock.callsFor("/projects/7/insurance_certificates")).toHaveLength(0); // loop broke first
  });

  it("reports zero and skips the Salesforce write when a collection has no id'd records", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/7/", responses: { json: [{ title: "no id" }] } }, // all filtered out
      { match: "/sobjects/", responses: { json: { id: "x", success: true } } },
    ]);
    const result = await sync.syncLegalDocuments(7);
    expect(result.synced).toBe(0);
    expect(mock.callsFor("/sobjects/")).toHaveLength(0);
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

  it("reports zero and skips the Salesforce write when a collection has no id'd records", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/7/", responses: { json: [{ title: "no id" }] } }, // all filtered out
      { match: "/sobjects/", responses: { json: { id: "x", success: true } } },
    ]);
    const result = await sync.syncFinancials(7);
    expect(result.synced).toBe(0);
    expect(mock.callsFor("/sobjects/")).toHaveLength(0);
  });
});

describe("SyncEngine.createCaseFromRfi", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("creates a Salesforce Case from a Procore RFI and links them", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/7/rfis/214", responses: { json: { id: 214, subject: "Curtain wall conflict", body: "details" } } },
      { match: "/sobjects/Case", responses: { json: { id: "500x9", success: true } } },
    ]);
    const result = await sync.createCaseFromRfi(7, 214);
    expect(result).toEqual({ caseId: "500x9", rfiId: "214" });
    expect(mock.callsFor("/rest/v1.0/projects/7/rfis/214")).toHaveLength(1); // project-scoped, not /rfis/{id}
    const caseCall = mock.callsFor("/sobjects/Case")[0]!;
    expect(JSON.parse(caseCall.body!)).toMatchObject({ Subject: "Curtain wall conflict", Procore_RFI_Id__c: "214" });
  });

  it("falls back to a generated subject when the RFI has none", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/7/rfis/9", responses: { json: { id: 9 } } },
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
    expect(audit.entries()[0]).toMatchObject({ action: "upsert", system: "salesforce", externalId: "42", at: expect.any(Number) });
    expect(notes).toEqual([{ system: "salesforce", object: "Procore_Project__c", externalId: "42", action: "upsert" }]);
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

  it("ignores a reverse UPDATE when the Procore id (External Id field) is absent", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([{ match: "/rest/v1.0/projects", responses: { json: { id: 1 } } }]);
    // No Procore_Project_Id__c on the record → we can't target a Procore record, so don't write.
    const r = await sync.handleSalesforceChange({ id: "u1", sobject: "Procore_Project__c", changeType: "UPDATE", fields: { Name: "X" } });
    expect(r.status).toBe("ignored");
    expect(r.detail).toContain("Procore_Project_Id__c");
    expect(mock.calls).toHaveLength(0); // never wrote to Procore
  });

  it("deduplicates a replay of the SAME real sobject event (not just any prior id)", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([{ match: "/rest/v1.0/projects", responses: { json: { id: 1 } } }]);
    const ev = { id: "sf-dup-1", sobject: "Procore_Project__c", changeType: "CREATE" as const, fields: { Name: "X" } };
    expect((await sync.handleSalesforceChange({ ...ev })).status).toBe("synced");
    expect((await sync.handleSalesforceChange({ ...ev })).status).toBe("skipped_duplicate");
    expect(mock.calls).toHaveLength(1); // exactly one Procore create
  });

  it("ignores a reverse DELETE when the Procore id is absent (no target record)", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([{ match: "__never__", responses: { json: {} } }]);
    const r = await sync.handleSalesforceChange({ id: "del-1", sobject: "Procore_Project__c", changeType: "DELETE", fields: {} });
    expect(r.status).toBe("ignored");
    expect(mock.calls).toHaveLength(0);
  });

  it("records a 'create' audit entry on a reverse CREATE", async () => {
    const { procore, salesforce, dedup } = await buildTestStack();
    const audit = new InMemoryAuditLog();
    const engine = new SyncEngine(procore, salesforce, dedup, { audit });
    mock = installFetchMock([{ match: "/rest/v1.0/projects", responses: { json: { id: 9001 } } }]);
    await engine.handleSalesforceChange({ id: "sf-audit", sobject: "Procore_Project__c", changeType: "CREATE", fields: { Name: "T" } });
    expect(audit.entries()[0]).toMatchObject({ action: "create", system: "procore", externalId: "9001", at: expect.any(Number) });
  });

  // ── Bidirectional legal documents (0.6.0): SF → Procore CREATE / UPDATE / DELETE ──────────────
  it("reverse CREATE: creates a project-scoped legal document in Procore", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([{ match: "/rest/v1.0/projects/7/contract_documents", responses: { json: { id: 555 } } }]);
    const r = await sync.handleSalesforceChange({
      id: "leg-c1",
      sobject: "Procore_Contract_Document__c",
      changeType: "CREATE",
      fields: { Name: "Master Agreement", Status__c: "Draft", Procore_Project_Id__c: 7 },
    });
    expect(r.status).toBe("synced");
    expect(r.detail).toContain("contract_documents#555");
    const call = mock.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("/rest/v1.0/projects/7/contract_documents");
    expect(JSON.parse(call.body!)).toMatchObject({ title: "Master Agreement", status: "Draft" });
  });

  it("reverse UPDATE: PATCHes the existing Procore legal record by id", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([{ match: "/rest/v1.0/projects/7/contract_documents/55", responses: { json: { id: 55 } } }]);
    const r = await sync.handleSalesforceChange({
      id: "leg-u1",
      sobject: "Procore_Contract_Document__c",
      changeType: "UPDATE",
      fields: { Procore_Id__c: 55, Procore_Project_Id__c: 7, Status__c: "Executed" },
    });
    expect(r.status).toBe("synced");
    const call = mock.calls[0]!;
    expect(call.method).toBe("PATCH");
    expect(call.url).toContain("/projects/7/contract_documents/55");
    expect(JSON.parse(call.body!)).toMatchObject({ status: "Executed" });
  });

  it("reverse DELETE: deletes the Procore legal record by id", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([{ match: "/rest/v1.0/projects/7/lien_waivers/88", responses: { text: "" } }]);
    const r = await sync.handleSalesforceChange({
      id: "leg-d1",
      sobject: "Procore_Lien_Waiver__c",
      changeType: "DELETE",
      fields: { Procore_Id__c: 88, Procore_Project_Id__c: 7 },
    });
    expect(r.status).toBe("deleted");
    expect(mock.calls[0]!.method).toBe("DELETE");
    expect(mock.calls[0]!.url).toContain("/projects/7/lien_waivers/88");
  });

  it("reverse legal change without the Procore project id is ignored (project-scoped guard)", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([{ match: "__never__", responses: { json: {} } }]);
    const r = await sync.handleSalesforceChange({
      id: "leg-np",
      sobject: "Procore_Compliance_Document__c",
      changeType: "CREATE",
      fields: { Name: "Permit" }, // missing Procore_Project_Id__c
    });
    expect(r.status).toBe("ignored");
    expect(r.detail).toContain("Procore_Project_Id__c");
    expect(mock.calls).toHaveLength(0);
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

  it("throws when a project-scoped resource event has no project_id", async () => {
    const { sync } = await buildTestStack();
    await expect(
      sync.handleProcoreWebhook({ id: "bad", resource_name: "RfiS", event_type: "update", resource_id: 214 }),
    ).rejects.toThrow(/missing project_id/);
  });
});

describe("SyncEngine cancellation + logging", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("aborts a reconciliation when the signal is already aborted (partial result, no writes)", async () => {
    const { procore, salesforce, dedup } = await buildTestStack();
    const logs: string[] = [];
    const engine = new SyncEngine(procore, salesforce, dedup, { log: (_l, m) => logs.push(m) });
    mock = installFetchMock([
      { match: "/rest/v1.0/projects", responses: { json: [{ id: 1 }, { id: 2 }] } },
      { match: "/sobjects/", responses: { json: { id: "x", success: true } } },
    ]);
    const ac = new AbortController();
    ac.abort();
    const result = await engine.reconcileProjects(ac.signal);
    expect(result.cancelled).toBe(true);
    expect(result.upserted).toBe(0);
    expect(mock.callsFor("/sobjects/")).toHaveLength(0); // no Salesforce writes
    expect(logs.some((m) => /cancelled/.test(m))).toBe(true); // emitted a log
  });

  it("syncFinancials stops immediately when the signal is aborted", async () => {
    const { procore, salesforce, dedup } = await buildTestStack();
    const engine = new SyncEngine(procore, salesforce, dedup);
    mock = installFetchMock([{ match: "__never__", responses: { json: [] } }]);
    const ac = new AbortController();
    ac.abort();
    const result = await engine.syncFinancials(7, ac.signal);
    expect(result.synced).toBe(0);
    expect(mock.calls).toHaveLength(0); // never even listed a financial collection
  });

  it("syncLegalDocuments stops immediately when the signal is aborted", async () => {
    const { procore, salesforce, dedup } = await buildTestStack();
    const engine = new SyncEngine(procore, salesforce, dedup);
    mock = installFetchMock([{ match: "__never__", responses: { json: [] } }]);
    const ac = new AbortController();
    ac.abort();
    const result = await engine.syncLegalDocuments(7, ac.signal);
    expect(result.synced).toBe(0);
    expect(mock.calls).toHaveLength(0); // never even listed a legal collection
  });
});
