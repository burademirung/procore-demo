import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ResourceUpdatedNotificationSchema,
  ResourceListChangedNotificationSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { buildTestStack } from "../helpers/fixtures.js";
import { installFetchMock } from "../helpers/fetchMock.js";

/**
 * Advanced-capability integration: a real MCP Client that DECLARES sampling + elicitation and
 * answers those server-initiated requests, connected to our real server over an in-memory
 * transport. This proves the sampling/elicitation/completion/resource-template round-trips work,
 * not just that the server compiles.
 */
async function connect() {
  const stack = await buildTestStack();
  const server = buildMcpServer({ procore: stack.procore, salesforce: stack.salesforce, sync: stack.sync });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client(
    { name: "advanced-test-client", version: "0.0.0" },
    { capabilities: { sampling: {}, elicitation: {} } },
  );
  // Sampling: the client's "LLM" answers.
  client.setRequestHandler(CreateMessageRequestSchema, async () => ({
    role: "assistant",
    content: { type: "text", text: "On budget; 3 overdue submittals threaten the Q3 milestone." },
    model: "test-model-1",
  }));
  // Elicitation: answer depends on which schema the server asked for.
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    const props = req.params.requestedSchema.properties as Record<string, unknown>;
    if ("decision" in props) return { action: "accept", content: { decision: "salesforce" } };
    if ("email" in props) return { action: "accept", content: { email: "jordan.rivera@acme.com" } };
    return { action: "decline" };
  });
  await client.connect(ct);
  return { client, server };
}

function firstText(r: { content?: Array<{ type: string; text?: string }> }): string {
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

/** Connect a client with a custom elicitation handler (for exercising decision branches). */
async function connectElicit(handler: Parameters<Client["setRequestHandler"]>[1]) {
  const stack = await buildTestStack();
  const server = buildMcpServer({ procore: stack.procore, salesforce: stack.salesforce, sync: stack.sync });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: "e", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  c.setRequestHandler(ElicitRequestSchema, handler);
  await c.connect(ct);
  return { c, server };
}

describe("MCP advanced capabilities", () => {
  let conn: Awaited<ReturnType<typeof connect>>;
  let mock: ReturnType<typeof installFetchMock> | undefined;
  beforeEach(async () => {
    conn = await connect();
  });
  afterEach(async () => {
    mock?.restore();
    mock = undefined;
    await conn.client.close();
    await conn.server.close();
  });

  it("advertises the new tools with structured output", async () => {
    const { tools } = await conn.client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      "sync_project_legal_documents",
      "upload_contract_file",
      "get_contract",
      "list_contracts_by_status",
      "submit_for_approval",
      "list_approval_processes",
      "check_signature_status",
      "sync_procore_financials",
      "create_salesforce_case_from_rfi",
      "dedupe_contacts",
      "summarize_project",
      "resolve_sync_conflict",
    ]) {
      expect(names, n).toContain(n);
    }
  });

  it("SAMPLING: summarize_project asks the client's LLM", async () => {
    mock = installFetchMock([{ match: "/rest/v1.0/projects/4821", responses: { json: { id: 4821, name: "Riverside Tower" } } }]);
    const res = await conn.client.callTool({ name: "summarize_project", arguments: { projectId: 4821 } });
    const sc = (res as { structuredContent?: { summary?: string; model?: string } }).structuredContent;
    expect(sc?.summary).toContain("submittals");
    expect(sc?.model).toBe("test-model-1");
  });

  it("ELICITATION: resolve_sync_conflict asks a human which value wins", async () => {
    const res = await conn.client.callTool({
      name: "resolve_sync_conflict",
      arguments: { objectKey: "project", field: "total_value", procoreValue: "12.4M", salesforceValue: "12.1M" },
    });
    const sc = (res as { structuredContent?: { resolved?: boolean; decision?: string; winner?: string } }).structuredContent;
    expect(sc?.resolved).toBe(true);
    expect(sc?.decision).toBe("salesforce");
    expect(sc?.winner).toBe("12.1M");
  });

  it("ELICITATION: dedupe_contacts confirms a canonical email", async () => {
    const res = await conn.client.callTool({
      name: "dedupe_contacts",
      arguments: {
        contacts: [
          { id: "p1", email: "jrivera@gmail.com", source: "procore" },
          { id: "s1", email: "j.rivera@gmail.com", source: "salesforce" },
        ],
      },
    });
    const sc = (res as { structuredContent?: { duplicateGroups?: number; merges?: Array<{ canonicalEmail: string }> } }).structuredContent;
    expect(sc?.duplicateGroups).toBe(1);
    expect(sc?.merges?.[0]?.canonicalEmail).toBe("jordan.rivera@acme.com");
  });

  it("TOOL: sync_project_legal_documents bulk-syncs legal documents (featured)", async () => {
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/7/", responses: { json: [{ id: 1, title: "Prime Agreement", status: "executed", contract_type: "Prime", certificate_number: "COI-9", amount: 5000 }] } },
      { match: "/sobjects/", responses: { json: { id: "x", success: true } } },
    ]);
    const res = await conn.client.callTool({ name: "sync_project_legal_documents", arguments: { projectId: 7 } });
    const sc = (res as { structuredContent?: { synced?: number; byObject?: Record<string, number> } }).structuredContent;
    expect(sc?.synced).toBe(4);
    expect(sc?.byObject?.["Procore_Contract_Document__c"]).toBe(1);
  });

  it("TOOL: upload_contract_file uploads a ContentVersion and links it to a record", async () => {
    mock = installFetchMock([{ match: "/sobjects/ContentVersion", responses: { json: { id: "068aa", success: true } } }]);
    const res = await conn.client.callTool({
      name: "upload_contract_file",
      arguments: { recordId: "800aa", fileName: "agreement.pdf", contentBase64: btoa("%PDF-1.7 fake"), title: "Master Agreement" },
    });
    const sc = (res as { structuredContent?: { contentVersionId?: string; linkedTo?: string } }).structuredContent;
    expect(sc?.contentVersionId).toBe("068aa");
    expect(sc?.linkedTo).toBe("800aa");
    expect(mock!.callsFor("/sobjects/ContentVersion")[0]!.method).toBe("POST");
  });

  it("TOOL: get_contract reads a Salesforce Contract", async () => {
    mock = installFetchMock([{ match: "/sobjects/Contract/800bb", responses: { json: { Id: "800bb", ContractNumber: "00001", Status: "Draft" } } }]);
    const res = await conn.client.callTool({ name: "get_contract", arguments: { contractId: "800bb" } });
    const sc = (res as { structuredContent?: { contract?: { ContractNumber?: string } } }).structuredContent;
    expect(sc?.contract?.ContractNumber).toBe("00001");
  });

  it("TOOL: list_contracts_by_status queries by Status and guards against SOQL injection", async () => {
    mock = installFetchMock([{ match: "/services/data/v62.0/query", responses: { json: { records: [{ Id: "800cc", Status: "Activated" }], done: true } } }]);
    const res = await conn.client.callTool({ name: "list_contracts_by_status", arguments: { status: "Activated' OR Name!=''", limit: 10 } });
    const sc = (res as { structuredContent?: { count?: number } }).structuredContent;
    expect(sc?.count).toBe(1);
    // the injected single quote is escaped inside the SOQL literal (no early string break)
    expect(decodeURIComponent(mock!.calls[0]!.url)).toContain("WHERE Status = 'Activated\\' OR");
  });

  it("TOOL: submit_for_approval posts to the Process Approvals resource", async () => {
    mock = installFetchMock([{ match: "/process/approvals/", responses: { json: [{ success: true, instanceId: "04gxx" }] } }]);
    const res = await conn.client.callTool({ name: "submit_for_approval", arguments: { recordId: "800dd", comments: "ready" } });
    expect(firstText(res as never)).toContain("04gxx");
    const body = JSON.parse(mock!.calls[0]!.body!);
    expect(body.requests[0]).toMatchObject({ actionType: "Submit", contextId: "800dd", comments: "ready" });
  });

  it("TOOL: list_approval_processes GETs the approvals resource", async () => {
    mock = installFetchMock([{ match: "/process/approvals/", responses: { json: { approvals: { Contract: [] } } } }]);
    const res = await conn.client.callTool({ name: "list_approval_processes", arguments: {} });
    expect(firstText(res as never)).toContain("approvals");
    expect(mock!.calls[0]!.method).toBe("GET");
  });

  it("TOOL: check_signature_status returns records when DocuSign is installed", async () => {
    mock = installFetchMock([{ match: "/services/data/v62.0/query", responses: { json: { records: [{ Id: "a1", dsfs__Envelope_Status__c: "Completed" }], done: true } } }]);
    const res = await conn.client.callTool({ name: "check_signature_status", arguments: { envelopeId: "env-123" } });
    const sc = (res as { structuredContent?: { available?: boolean; records?: unknown[] } }).structuredContent;
    expect(sc?.available).toBe(true);
    expect(sc?.records).toHaveLength(1);
  });

  it("TOOL: check_signature_status degrades gracefully when the DocuSign package is absent", async () => {
    mock = installFetchMock([{ match: "/services/data/v62.0/query", responses: { status: 400, json: [{ errorCode: "INVALID_TYPE", message: "sObject type 'dsfs__DocuSign_Status__c' is not supported." }] } }]);
    const res = await conn.client.callTool({ name: "check_signature_status", arguments: { envelopeId: "env-404" } });
    const sc = (res as { structuredContent?: { available?: boolean; detail?: string } }).structuredContent;
    expect(sc?.available).toBe(false);
    expect(sc?.detail).toContain("managed package");
  });

  it("TOOL: sync_procore_financials bulk-syncs financial objects", async () => {
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/7/", responses: { json: [{ id: 1, title: "X", grand_total: 1, status: "o", number: "C", amount: 2, invoice_number: "I", total_amount: 3 }] } },
      { match: "/sobjects/", responses: { json: { id: "x", success: true } } },
    ]);
    const res = await conn.client.callTool({ name: "sync_procore_financials", arguments: { projectId: 7 } });
    const sc = (res as { structuredContent?: { synced?: number } }).structuredContent;
    expect(sc?.synced).toBe(4);
  });

  it("TOOL: create_salesforce_case_from_rfi creates a Case", async () => {
    mock = installFetchMock([
      { match: "/rfis/214", responses: { json: { id: 214, subject: "Curtain wall" } } },
      { match: "/sobjects/Case", responses: { json: { id: "500z", success: true } } },
    ]);
    const res = await conn.client.callTool({ name: "create_salesforce_case_from_rfi", arguments: { projectId: 7, rfiId: 214 } });
    expect(firstText(res as never)).toContain("500z");
  });

  it("DEGRADES gracefully when the client lacks sampling/elicitation", async () => {
    const stack = await buildTestStack();
    const server = buildMcpServer({ procore: stack.procore, salesforce: stack.salesforce, sync: stack.sync });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const bare = new Client({ name: "bare", version: "0.0.0" }, { capabilities: {} }); // no sampling/elicitation
    await bare.connect(ct);

    const r1 = await bare.callTool({
      name: "resolve_sync_conflict",
      arguments: { objectKey: "p", field: "f", procoreValue: "a", salesforceValue: "b" },
    });
    expect((r1 as { isError?: boolean }).isError).toBe(true);

    mock = installFetchMock([{ match: "/rest/v1.0/projects/9", responses: { json: { id: 9 } } }]);
    const r2 = await bare.callTool({ name: "summarize_project", arguments: { projectId: 9 } });
    expect((r2 as { isError?: boolean }).isError).toBe(true);

    await bare.close();
    await server.close();
  });

  it("COMPLETION: prompt argument autocompletes from mapping keys", async () => {
    const res = await conn.client.complete({
      ref: { type: "ref/prompt", name: "audit_unmapped_records" },
      argument: { name: "objectKey", value: "p" },
    });
    expect(res.completion.values).toEqual(expect.arrayContaining(["project", "prime_contract"]));
  });

  it("RESOURCE TEMPLATE: cross-system search reads from both systems + completes the query", async () => {
    // completion on the template variable
    const comp = await conn.client.complete({
      ref: { type: "ref/resource", uri: "conduit://search/{query}" },
      argument: { name: "query", value: "river" },
    });
    expect(comp.completion.values).toEqual(expect.arrayContaining(["Riverside Tower", "River Oaks Plaza"]));

    // reading the resource merges Procore + Salesforce results
    mock = installFetchMock([
      { match: "/rest/v1.0/projects", responses: { json: [{ id: 1, name: "Riverside Tower" }] } },
      { match: "/services/data/v62.0/search", responses: { json: { searchRecords: [{ Id: "001", Name: "Riverside Tower" }] } } },
    ]);
    const read = await conn.client.readResource({ uri: "conduit://search/Riverside" });
    const payload = JSON.parse(read.contents[0]!.text as string);
    expect(payload.query).toBe("Riverside");
    expect(payload.procore).toHaveLength(1);
    expect(payload.salesforce.searchRecords).toHaveLength(1);
  });

  it("ELICITATION: merge decision combines both values", async () => {
    const { c, server } = await connectElicit(async () => ({ action: "accept", content: { decision: "merge" } }));
    const r = await c.callTool({
      name: "resolve_sync_conflict",
      arguments: { objectKey: "p", field: "f", procoreValue: "a", salesforceValue: "b" },
    });
    expect((r as { structuredContent?: { winner?: string } }).structuredContent?.winner).toBe("a | b");
    await c.close();
    await server.close();
  });

  it("ELICITATION: a declined prompt resolves nothing", async () => {
    const { c, server } = await connectElicit(async () => ({ action: "decline" }));
    const r = await c.callTool({
      name: "resolve_sync_conflict",
      arguments: { objectKey: "p", field: "f", procoreValue: "a", salesforceValue: "b" },
    });
    expect((r as { structuredContent?: { resolved?: boolean } }).structuredContent?.resolved).toBe(false);
    await c.close();
    await server.close();
  });

  it("TOOL: sync_salesforce_to_procore applies a reverse change", async () => {
    mock = installFetchMock([{ match: "/rest/v1.0/projects", responses: { json: { id: 9001 } } }]);
    const r = await conn.client.callTool({
      name: "sync_salesforce_to_procore",
      arguments: { sobject: "Procore_Project__c", changeType: "CREATE", recordId: "006x", fields: { Name: "Won Tower" } },
    });
    expect((r as { structuredContent?: { status?: string } }).structuredContent?.status).toBe("synced");
  });

  it("RESOURCES: reads a Procore project and a Salesforce account by id", async () => {
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/4821", responses: { json: { id: 4821, name: "Riverside" } } },
      { match: "/sobjects/Account/001", responses: { json: { Id: "001", Name: "Acme" } } },
    ]);
    const p = await conn.client.readResource({ uri: "procore://project/4821" });
    expect(JSON.parse(p.contents[0]!.text as string).name).toBe("Riverside");
    const a = await conn.client.readResource({ uri: "salesforce://account/001" });
    expect(JSON.parse(a.contents[0]!.text as string).Name).toBe("Acme");
  });

  it("REAL-TIME: emits resources/updated when a record syncs", async () => {
    const updated: string[] = [];
    let resolveGot: () => void;
    const got = new Promise<void>((r) => (resolveGot = r));
    conn.client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
      updated.push(n.params.uri);
      resolveGot();
    });
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/42", responses: { json: { id: 42, name: "Tower" } } },
      { match: "/sobjects/Procore_Project__c/", responses: { json: { id: "a", success: true } } },
    ]);
    await conn.client.callTool({ name: "sync_procore_project_to_salesforce", arguments: { projectId: 42 } });
    await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error("no notification")), 2000))]);
    expect(updated[0]).toContain("conduit://salesforce/Procore_Project__c/42");
  });

  it("TOOL: create_procore_webhook with project scope", async () => {
    mock = installFetchMock([
      { match: "/webhooks/hooks/3/triggers", responses: { json: { id: 1 } } },
      { match: "/webhooks/hooks", responses: { json: { id: 3 } } },
    ]);
    const r = await conn.client.callTool({
      name: "create_procore_webhook",
      arguments: { deliveryUrl: "https://cb.test/x", projectId: 55, triggers: [{ resource_name: "RfiS", event_type: "create" }] },
    });
    expect((r as { structuredContent?: { hookId?: number } }).structuredContent?.hookId).toBe(3);
  });

  it("propagates an upstream API failure as an isError tool result", async () => {
    mock = installFetchMock([{ match: "/rest/v1.0/projects/42", responses: { status: 404, text: "not found" } }]);
    const r = await conn.client.callTool({ name: "sync_procore_project_to_salesforce", arguments: { projectId: 42 } });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });

  it("PROGRESS: run_reconciliation emits progress notifications", async () => {
    mock = installFetchMock([
      { match: "/rest/v1.0/projects", responses: { json: [{ id: 1, name: "A" }] } },
      { match: "/sobjects/Procore_Project__c/", responses: { json: { id: "x", success: true } } },
    ]);
    const progress: number[] = [];
    await conn.client.callTool({ name: "run_reconciliation", arguments: { scope: "projects" } }, undefined, {
      onprogress: (p) => progress.push(p.progress),
    });
    expect(progress).toContain(100);
  });

  it("LOGGING: reconciliation emits logging/message notifications", async () => {
    const logs: string[] = [];
    let resolveGot: () => void;
    const got = new Promise<void>((r) => (resolveGot = r));
    conn.client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      logs.push(JSON.stringify(n.params.data));
      resolveGot();
    });
    mock = installFetchMock([
      { match: "/rest/v1.0/projects", responses: { json: [{ id: 1, name: "A" }] } },
      { match: "/sobjects/Procore_Project__c/", responses: { json: { id: "x", success: true } } },
    ]);
    await conn.client.callTool({ name: "run_reconciliation", arguments: { scope: "projects" } });
    await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error("no log")), 2000))]);
    expect(logs.join(" ")).toContain("reconcile");
  });

  it("LIST_CHANGED: a reverse create emits resources/list_changed", async () => {
    let resolveGot: () => void;
    const got = new Promise<void>((r) => (resolveGot = r));
    conn.client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => resolveGot());
    mock = installFetchMock([{ match: "/rest/v1.0/projects", responses: { json: { id: 9001 } } }]);
    await conn.client.callTool({
      name: "sync_salesforce_to_procore",
      arguments: { sobject: "Procore_Project__c", changeType: "CREATE", recordId: "006", fields: { Name: "T" } },
    });
    await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error("no list_changed")), 2000))]);
    expect(true).toBe(true); // resolved → notification received
  });

  it("PAGINATION: list_procore_projects pages with an opaque cursor", async () => {
    mock = installFetchMock([
      { match: "/rest/v1.0/projects", responses: { json: [{ id: 1 }, { id: 2 }, { id: 3 }] } },
    ]);
    const p1 = await conn.client.callTool({ name: "list_procore_projects", arguments: { limit: 2 } });
    const sc1 = (p1 as { structuredContent?: { items?: unknown[]; nextCursor?: string } }).structuredContent!;
    expect(sc1.items).toHaveLength(2);
    expect(sc1.nextCursor).toBeTruthy();
    const p2 = await conn.client.callTool({ name: "list_procore_projects", arguments: { limit: 2, cursor: sc1.nextCursor } });
    const sc2 = (p2 as { structuredContent?: { items?: unknown[]; nextCursor?: string } }).structuredContent!;
    expect(sc2.items).toHaveLength(1); // last page
    expect(sc2.nextCursor).toBeUndefined();
  });

  it("URL ELICITATION: authorize_salesforce degrades to isError when the client can't elicit", async () => {
    // URL-mode elicitation is an out-of-band flow; we assert the tool is wired and degrades
    // gracefully when the client lacks elicitation support (the deterministic, client-agnostic path).
    const stack = await buildTestStack();
    const server = buildMcpServer({ procore: stack.procore, salesforce: stack.salesforce, sync: stack.sync });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const bare = new Client({ name: "bare", version: "0.0.0" }, { capabilities: {} });
    await bare.connect(ct);
    const r = await bare.callTool({ name: "authorize_salesforce", arguments: { scope: "api" } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    await bare.close();
    await server.close();
  });
});
