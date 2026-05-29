# Examples

## Connect an MCP client

Point any MCP client at the remote endpoint and complete the OAuth handshake (discovery is
automatic via `/.well-known/oauth-authorization-server`).

`mcp-config.json`:
```json
{
  "mcpServers": {
    "conduit": {
      "url": "https://procore-salesforce-mcp.burademirung.workers.dev/mcp",
      "transport": "streamable-http"
    }
  }
}
```

## Drive it programmatically (TypeScript)

`client.mjs` shows a minimal client that lists tools and calls one. Run it against a **local**
server (`npm run dev`) so no OAuth is required for the demo:

```bash
npm run dev          # in the repo root, starts the Node server on :8788
node examples/client.mjs
```
