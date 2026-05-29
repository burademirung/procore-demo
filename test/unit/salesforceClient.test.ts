import { describe, it, expect, afterEach } from "vitest";
import { SalesforceClient } from "../../src/clients/salesforce.js";
import { InMemoryTokenStore } from "../../src/auth/tokenStore.js";
import { testConfig } from "../helpers/fixtures.js";
import { installFetchMock } from "../helpers/fetchMock.js";

const INSTANCE = "https://acme.my.salesforce.test";

async function sfClient() {
  const tokens = new InMemoryTokenStore();
  await tokens.set("default", "salesforce", { accessToken: "sf-access", instanceUrl: INSTANCE });
  return new SalesforceClient(testConfig(), tokens, 0); // pollDelayMs=0 → fast Bulk-job polling in tests
}

describe("SalesforceClient", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("throws when there is no session/instance url", async () => {
    const client = new SalesforceClient(testConfig(), new InMemoryTokenStore());
    await expect(client.query("SELECT Id FROM Account")).rejects.toThrow(/No Salesforce session/);
  });

  it("escapes SOSL reserved characters in search (injection guard)", async () => {
    const client = await sfClient();
    mock = installFetchMock([{ match: "/services/data/v62.0/search", responses: { json: { searchRecords: [] } } }]);
    await client.search('Riverside{} OR (1=1)');
    const url = decodeURIComponent(mock.calls[0]!.url);
    // reserved chars are backslash-escaped inside the FIND {...} clause
    expect(url).toContain("FIND {Riverside\\{\\} OR \\(1=1\\)}");
  });

  it("runs a SOQL query against the versioned endpoint with bearer auth", async () => {
    const client = await sfClient();
    mock = installFetchMock([
      { match: "/services/data/v62.0/query", responses: { json: { records: [{ Id: "1" }], done: true } } },
    ]);
    const res = await client.query("SELECT Id FROM Account");
    expect(res.records).toHaveLength(1);
    const call = mock.calls[0]!;
    expect(call.url).toContain(`${INSTANCE}/services/data/v62.0/query?q=`);
    expect(call.headers["authorization"]).toBe("Bearer sf-access");
  });

  it("upserts by external id with PATCH (idempotency keystone)", async () => {
    const client = await sfClient();
    mock = installFetchMock([
      { match: "/sobjects/Account/Procore_Company_Id__c/", responses: { json: { id: "001", created: true, success: true } } },
    ]);
    const r = await client.upsertByExternalId("Account", "Procore_Company_Id__c", "C-1", { Name: "Acme" });
    expect(r).toMatchObject({ id: "001", created: true });
    const call = mock.calls[0]!;
    expect(call.method).toBe("PATCH");
    expect(JSON.parse(call.body!)).toEqual({ Name: "Acme" });
  });

  it("percent-encodes path components to prevent traversal/injection", async () => {
    const client = await sfClient();
    mock = installFetchMock([{ match: "/sobjects/Account/Procore_Company_Id__c/", responses: { json: { id: "001", created: true, success: true } } }]);
    await client.upsertByExternalId("Account", "Procore_Company_Id__c", "abc/def", { Name: "X" });
    expect(mock.calls[0]!.url).toContain("/Procore_Company_Id__c/abc%2Fdef"); // slash encoded, not a path segment
  });

  it("creates and reads a record", async () => {
    const client = await sfClient();
    mock = installFetchMock([
      { match: "/sobjects/Contact/003", responses: { json: { Id: "003", LastName: "Doe" } } },
      { match: "/sobjects/Contact", responses: { json: { id: "003", success: true } } },
    ]);
    const created = await client.createRecord("Contact", { LastName: "Doe" });
    expect(created.id).toBe("003");
    const read = await client.getRecord<{ LastName: string }>("Contact", "003", ["LastName"]);
    expect(read.LastName).toBe("Doe");
  });

  it("bulk upserts a batch, one PATCH per record, stripping the synthetic key", async () => {
    const client = await sfClient();
    mock = installFetchMock([
      { match: "/sobjects/Procore_Budget_Line__c/", responses: { json: { id: "x", success: true, created: true } } },
    ]);
    const { processed } = await client.bulkUpsert("Procore_Budget_Line__c", "Procore_Id__c", [
      { __externalId: "L1", Amount__c: 10 },
      { __externalId: "L2", Amount__c: 20 },
    ]);
    expect(processed).toBe(2);
    expect(mock.calls).toHaveLength(2);
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ Amount__c: 10 }); // __externalId stripped
  });

  it("runs a real Bulk API 2.0 upsert job (create → upload CSV → complete → poll)", async () => {
    const client = await sfClient();
    mock = installFetchMock([
      { match: "/jobs/ingest/j1/batches", responses: { status: 201, text: "" } },
      { match: "/jobs/ingest/j1", responses: [{ json: {} }, { json: { state: "JobComplete", numberRecordsProcessed: 2 } }] },
      { match: "/jobs/ingest", responses: { json: { id: "j1" } } },
    ]);
    const r = await client.bulkUpsertJob("Procore_Budget_Line__c", "Procore_Id__c", [
      { __externalId: "L1", Amount__c: 10, Note__c: "needs, quoting" }, // comma forces CSV quoting
      { __externalId: "L2", Amount__c: 20, Note__c: "plain" },
    ]);
    expect(r).toEqual({ jobId: "j1", state: "JobComplete", processed: 2 });
    const put = mock.callsFor("/batches")[0]!;
    expect(put.headers["content-type"]).toBe("text/csv");
    expect(put.body).toContain("Procore_Id__c,Amount__c");
    expect(put.body).toContain('"needs, quoting"'); // value with a comma is quoted
  });

  it("polls past a non-terminal state until the Bulk job completes", async () => {
    const client = await sfClient();
    mock = installFetchMock([
      { match: "/jobs/ingest/j2/batches", responses: { status: 201, text: "" } },
      {
        match: "/jobs/ingest/j2",
        responses: [{ json: {} }, { json: { state: "InProgress" } }, { json: { state: "JobComplete", numberRecordsProcessed: 1 } }],
      },
      { match: "/jobs/ingest", responses: { json: { id: "j2" } } },
    ]);
    const r = await client.bulkUpsertJob("Procore_Budget_Line__c", "Procore_Id__c", [{ __externalId: "L1", Amount__c: 1 }]);
    expect(r.state).toBe("JobComplete");
  });

  it("throws when the Bulk job ends in a Failed state", async () => {
    const client = await sfClient();
    mock = installFetchMock([
      { match: "/jobs/ingest/j3/batches", responses: { status: 201, text: "" } },
      { match: "/jobs/ingest/j3", responses: [{ json: {} }, { json: { state: "Failed" } }] },
      { match: "/jobs/ingest", responses: { json: { id: "j3" } } },
    ]);
    await expect(client.bulkUpsertJob("X__c", "Procore_Id__c", [{ __externalId: "L1" }])).rejects.toThrow(/Failed/);
  });

  it("throws when the Bulk job is Aborted", async () => {
    const client = await sfClient();
    mock = installFetchMock([
      { match: "/jobs/ingest/j4/batches", responses: { status: 201, text: "" } },
      { match: "/jobs/ingest/j4", responses: [{ json: {} }, { json: { state: "Aborted" } }] },
      { match: "/jobs/ingest", responses: { json: { id: "j4" } } },
    ]);
    await expect(client.bulkUpsertJob("X__c", "Procore_Id__c", [{ __externalId: "L1" }])).rejects.toThrow(/Aborted/);
  });

  it("throws when the Bulk job never reaches a terminal state (poll timeout)", async () => {
    const client = await sfClient();
    mock = installFetchMock([
      { match: "/jobs/ingest/j5/batches", responses: { status: 201, text: "" } },
      { match: "/jobs/ingest/j5", responses: [{ json: {} }, { json: { state: "InProgress" } }] }, // never terminal
      { match: "/jobs/ingest", responses: { json: { id: "j5" } } },
    ]);
    await expect(client.bulkUpsertJob("X__c", "Procore_Id__c", [{ __externalId: "L1" }])).rejects.toThrow(/InProgress/);
  });

  it("throws when the CSV batch upload (PUT) is rejected", async () => {
    const client = await sfClient();
    mock = installFetchMock([
      { match: "/jobs/ingest/j6/batches", responses: { status: 413, text: "Payload Too Large" } },
      { match: "/jobs/ingest", responses: { json: { id: "j6" } } },
    ]);
    await expect(client.bulkUpsertJob("X__c", "Procore_Id__c", [{ __externalId: "L1" }])).rejects.toThrow(/413/);
  });

  it("falls back to records.length when Salesforce omits numberRecordsProcessed; quotes embedded quotes", async () => {
    const client = await sfClient();
    mock = installFetchMock([
      { match: "/jobs/ingest/j7/batches", responses: { status: 201, text: "" } },
      { match: "/jobs/ingest/j7", responses: [{ json: {} }, { json: { state: "JobComplete" } }] }, // no count
      { match: "/jobs/ingest", responses: { json: { id: "j7" } } },
    ]);
    const r = await client.bulkUpsertJob("X__c", "Procore_Id__c", [
      { __externalId: "L1", Note__c: 'say "hi"' },
      { __externalId: "L2" },
    ]);
    expect(r.processed).toBe(2); // fallback to input length
    expect(mock.callsFor("/batches")[0]!.body).toContain('"say ""hi"""'); // RFC-4180 quote doubling
  });

  it("getRecord without fields omits the ?fields query", async () => {
    const client = await sfClient();
    mock = installFetchMock([{ match: "/sobjects/Account/001", responses: { json: { Id: "001" } } }]);
    await client.getRecord("Account", "001");
    expect(mock.calls[0]!.url).not.toContain("?fields=");
  });

  it("uploads a ContentVersion via REST multipart and links it to a record", async () => {
    const client = await sfClient();
    mock = installFetchMock([{ match: "/sobjects/ContentVersion", responses: { json: { id: "068xx", success: true } } }]);
    const r = await client.uploadContentVersion({
      title: "Master Agreement",
      fileName: "ma.pdf",
      data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // "%PDF"
      linkedRecordId: "800xx",
    });
    expect(r).toMatchObject({ id: "068xx", success: true });
    const call = mock.calls[0]!;
    expect(call.url).toContain(`${INSTANCE}/services/data/v62.0/sobjects/ContentVersion`);
    expect(call.method).toBe("POST");
    expect(call.headers["authorization"]).toBe("Bearer sf-access");
    // multipart path: we must NOT force application/json — fetch derives the boundary itself.
    expect(call.headers["content-type"]).toBeUndefined();
  });

  it("submits a record for approval via the Process Approvals resource", async () => {
    const client = await sfClient();
    mock = installFetchMock([{ match: "/process/approvals/", responses: { json: [{ success: true, instanceId: "04g" }] } }]);
    await client.processApproval({ actionType: "Submit", contextId: "800xx", comments: "Please review", nextApproverIds: ["005x"] });
    const call = mock.calls[0]!;
    expect(call.url).toContain(`${INSTANCE}/services/data/v62.0/process/approvals/`);
    expect(call.method).toBe("POST");
    const body = JSON.parse(call.body!);
    expect(body.requests[0]).toMatchObject({ actionType: "Submit", contextId: "800xx", comments: "Please review", nextApproverIds: ["005x"] });
  });

  it("lists approval processes via GET /process/approvals/", async () => {
    const client = await sfClient();
    mock = installFetchMock([{ match: "/process/approvals/", responses: { json: { approvals: [{ object: "Contract" }] } } }]);
    await client.listApprovalProcesses();
    const call = mock.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toContain(`${INSTANCE}/services/data/v62.0/process/approvals/`);
    expect(call.body).toBeUndefined();
  });
});
