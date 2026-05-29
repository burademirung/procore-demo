import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema, ElicitRequestSchema, ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
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
    for (const n of ["sync_procore_financials", "create_salesforce_case_from_rfi", "dedupe_contacts", "summarize_project", "resolve_sync_conflict"]) {
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
});
