import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "../config.js";
import { InMemoryTokenStore } from "../auth/tokenStore.js";
import { InMemoryDedupStore } from "../sync/dedup.js";
import { ProcoreClient } from "../clients/procore.js";
import { SalesforceClient } from "../clients/salesforce.js";
import { SyncEngine, type ProcoreWebhookEvent } from "../sync/engine.js";
import { buildMcpServer } from "../mcp/server.js";
import { verifyWebhookSignature } from "../security/webhookSignature.js";

/**
 * Node entrypoint. Streamable HTTP is the only supported remote MCP transport [VERIFIED].
 *
 * Security [VERIFIED MUST]: validate the Origin header (403 on invalid) to prevent DNS
 * rebinding. The SDK transport does this when given `enableDnsRebindingProtection` +
 * `allowedOrigins`; we also gate at the HTTP layer for defense in depth.
 */
const cfg = loadConfig(process.env);

// Dependency wiring (dev: in-memory stores; swap for KV/Postgres in production).
const tokens = new InMemoryTokenStore();
const dedup = new InMemoryDedupStore();
const procore = new ProcoreClient(cfg, tokens);
const salesforce = new SalesforceClient(cfg, tokens);
const sync = new SyncEngine(procore, salesforce, dedup);

// One transport per MCP session, keyed by the mcp-session-id header.
const transports = new Map<string, StreamableHTTPServerTransport>();

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients omit Origin
  // Exact match only — prefix matching would allow http://127.0.0.1.evil.com to pass.
  return cfg.mcpAllowedOrigins.includes(origin);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  return raw.length === 0 ? undefined : JSON.parse(raw);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!originAllowed(req.headers.origin)) {
    res.writeHead(403).end("Forbidden: invalid Origin");
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;
  const body = req.method === "POST" ? await readBody(req) : undefined;

  if (!transport) {
    // New session: spin up a transport + MCP server and connect them.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedOrigins: cfg.mcpAllowedOrigins,
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };
    const server = buildMcpServer({ procore, salesforce, sync });
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, body);
}

/**
 * Procore webhook receiver. [VERIFIED] must return 2xx within 5s — so we ACK immediately
 * and process asynchronously (dedup happens inside the engine). Phase 4: replace the
 * fire-and-forget with a real queue enqueue.
 */
async function handleProcoreWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readRawBody(req);
  // Verify HMAC signature when a secret is configured (rejects forged events).
  if (cfg.webhookSecret) {
    const sig = (req.headers["x-procore-signature"] ?? req.headers["x-hub-signature-256"]) as string | undefined;
    if (!(await verifyWebhookSignature(raw, sig, cfg.webhookSecret))) {
      res.writeHead(401).end("invalid signature");
      return;
    }
  }
  let event: ProcoreWebhookEvent | undefined;
  try {
    event = raw.length ? (JSON.parse(raw) as ProcoreWebhookEvent) : undefined;
  } catch {
    res.writeHead(400).end("bad payload");
    return;
  }
  res.writeHead(202).end("accepted"); // ACK fast — do NOT await downstream work
  if (event?.id) {
    sync.handleProcoreWebhook(event).catch((err) => console.error("[webhook] sync failed", err));
  }
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/mcp") {
    handleMcp(req, res).catch((err) => {
      console.error("[mcp] error", err);
      if (!res.headersSent) res.writeHead(500).end("internal error");
    });
    return;
  }
  if (url.pathname === "/webhooks/procore" && req.method === "POST") {
    handleProcoreWebhook(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end("internal error");
    });
    return;
  }
  res.writeHead(404).end("not found");
});

httpServer.listen(cfg.port, () => {
  console.log(`procore-salesforce-mcp listening on :${cfg.port}`);
  console.log(`  MCP endpoint    POST/GET  /mcp`);
  console.log(`  Procore webhook POST      /webhooks/procore`);
  console.log(`  Health          GET       /healthz`);
});
