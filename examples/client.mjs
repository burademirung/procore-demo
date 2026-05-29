// Minimal MCP client example. Connects over Streamable HTTP, lists tools, reads the mappings
// resource, and renders a prompt. Run a local server first: `npm run dev`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp";

const client = new Client({ name: "conduit-example", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const { tools } = await client.listTools();
console.log("Tools:", tools.map((t) => t.name).join(", "));

const mappings = await client.readResource({ uri: "config://mappings" });
console.log("Mappings resource bytes:", mappings.contents[0]?.text?.length ?? 0);

const prompt = await client.getPrompt({ name: "audit_unmapped_records", arguments: { objectKey: "project" } });
console.log("Prompt:", prompt.messages[0]?.content?.text);

await client.close();
