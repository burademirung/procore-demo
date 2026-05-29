import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { buildTestStack } from "../helpers/fixtures.js";
import { installFetchMock } from "../helpers/fetchMock.js";

/**
 * End-to-end MCP integration: a real MCP Client talks to our real server over a linked
 * in-memory transport. The server is backed by the real clients + sync engine, with only
 * the outbound HTTP layer mocked — so this exercises tool dispatch, schema validation,
 * resource reads, and prompt rendering exactly as a production agent would.
 */
async function connectClient() {
  const stack = await buildTestStack();
  const server = buildMcpServer({ procore: stack.procore, salesforce: stack.salesforce, sync: stack.sync });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

function firstText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const block = result.content?.find((c) => c.type === "text");
  return block?.text ?? "";
}

describe("MCP server integration", () => {
  let conn: Awaited<ReturnType<typeof connectClient>>;
  let mock: ReturnType<typeof installFetchMock> | undefined;

  beforeEach(async () => {
    conn = await connectClient();
  });
  afterEach(async () => {
    mock?.restore();
    mock = undefined;
    await conn.client.close();
    await conn.server.close();
  });

  it("advertises the expected tools", async () => {
    const { tools } = await conn.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("sync_procore_project_to_salesforce");
    expect(names).toContain("run_reconciliation");
    expect(names).toContain("create_procore_webhook");
  });

  it("executes run_reconciliation through the full stack", async () => {
    mock = installFetchMock([
      { match: "/rest/v1.0/projects", responses: { json: [{ id: 1, name: "A" }, { id: 2, name: "B" }] } },
      { match: "/sobjects/Procore_Project__c/", responses: { json: { id: "x", success: true } } },
    ]);
    const result = await conn.client.callTool({ name: "run_reconciliation", arguments: { scope: "projects" } });
    expect(firstText(result as never)).toContain('"scanned": 2');
  });

  it("syncs a single Procore project to Salesforce via the tool", async () => {
    mock = installFetchMock([
      { match: "/rest/v1.0/projects/7", responses: { json: { id: 7, name: "Bridge", project_number: "B-7" } } },
      { match: "/sobjects/Procore_Project__c/", responses: { json: { id: "z", success: true, created: true } } },
    ]);
    const result = await conn.client.callTool({
      name: "sync_procore_project_to_salesforce",
      arguments: { projectId: 7 },
    });
    expect(firstText(result as never)).toContain('"status": "synced"');
  });

  it("provisions a Procore webhook via the two-tier tool", async () => {
    mock = installFetchMock([
      { match: "/webhooks/hooks/9/triggers", responses: { json: { id: 1 } } },
      { match: "/webhooks/hooks", responses: { json: { id: 9 } } },
    ]);
    const result = await conn.client.callTool({
      name: "create_procore_webhook",
      arguments: {
        deliveryUrl: "https://cb.test/webhooks/procore",
        companyId: 777,
        triggers: [{ resource_name: "Projects", event_type: "update" }],
      },
    });
    expect(firstText(result as never)).toContain('"hookId": 9');
  });

  it("returns an isError result for a tool call with an invalid argument schema", async () => {
    // MCP returns tool/validation failures in-band (isError) so the model can react,
    // rather than throwing — assert the error result, not a rejection.
    const result = await conn.client.callTool({
      name: "create_procore_webhook",
      arguments: { deliveryUrl: "not-a-url", triggers: [] },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("serves the mappings resource", async () => {
    const res = await conn.client.readResource({ uri: "config://mappings" });
    const text = res.contents[0]?.text as string;
    expect(JSON.parse(text).some((m: { key: string }) => m.key === "project")).toBe(true);
  });

  it("renders the audit_unmapped_records prompt", async () => {
    const { prompts } = await conn.client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("audit_unmapped_records");
    const prompt = await conn.client.getPrompt({ name: "audit_unmapped_records", arguments: { objectKey: "project" } });
    const msg = prompt.messages[0]?.content;
    expect(msg && "text" in msg ? msg.text : "").toContain("Projects ↔ Procore_Project__c");
  });
});
