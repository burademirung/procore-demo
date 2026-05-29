/// <reference types="@cloudflare/workers-types" />
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import OAuthProvider, { type TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import { loadConfig } from "../config.js";
import { ProcoreClient } from "../clients/procore.js";
import { SalesforceClient } from "../clients/salesforce.js";
import { SyncEngine, type ProcoreWebhookEvent } from "../sync/engine.js";
import { buildMcpServer } from "../mcp/server.js";
import { PropsTokenStore, DODedupStore, DOLinkStore, type OAuthProps } from "./stores.js";
import { SyncStateDO } from "./syncStateDO.js";
import { verifyWebhookSignature } from "../security/webhookSignature.js";
import { withSecurityHeaders } from "../security/headers.js";

export { SyncStateDO }; // Durable Object class must be exported from the Worker entry (see wrangler.toml)

/**
 * Cloudflare Workers deploy target (PRIMARY) — the architecture the verified research
 * recommends: McpAgent (Durable Object per session) + workers-oauth-provider for OAuth
 * 2.1 + PKCE, brokering BOTH downstream providers via tokenExchangeCallback. [VERIFIED]
 */

export interface Env {
  // Static assets (the GUI demo landing page). Unmatched paths fall through to this Worker.
  ASSETS: Fetcher;
  // Durable Object binding backing McpAgent (declared in wrangler.toml).
  MCP_OBJECT: DurableObjectNamespace;
  // Durable Object holding strongly-consistent sync state (dedup + link/hash).
  SYNC_STATE: DurableObjectNamespace<SyncStateDO>;
  // KV namespaces.
  OAUTH_KV: KVNamespace; // used by workers-oauth-provider for grants/tokens
  DEDUP_KV: KVNamespace; // legacy webhook dedup (superseded by SYNC_STATE DO)
  // Secrets / vars (wrangler secret put ...). Mirror of .env.example.
  PROCORE_CLIENT_ID?: string;
  PROCORE_CLIENT_SECRET?: string;
  PROCORE_AUTH_BASE?: string;
  PROCORE_API_BASE?: string;
  PROCORE_COMPANY_ID?: string;
  SF_LOGIN_URL?: string;
  SF_CLIENT_ID?: string;
  SF_CLIENT_SECRET?: string;
  SF_USERNAME?: string;
  SF_JWT_PRIVATE_KEY?: string;
  SF_API_VERSION?: string;
  MCP_ALLOWED_ORIGINS?: string;
  WEBHOOK_SECRET?: string;
}

/**
 * The MCP agent. Tokens for Procore + Salesforce arrive in `this.props` from the OAuth
 * grant (populated by tokenExchangeCallback below). We rebuild the shared MCP server with
 * Worker-native stores in init().
 */
export class ProcoreSalesforceMCP extends McpAgent<Env, unknown, OAuthProps> {
  server!: McpServer;

  async init(): Promise<void> {
    const props = (this.props ?? {}) as OAuthProps;
    const tenantId = props.tenantId ?? "default";

    const cfg = loadConfig(this.env as unknown as Record<string, string | undefined>);
    const tokens = new PropsTokenStore(tenantId, props);
    const syncStub = this.env.SYNC_STATE.get(this.env.SYNC_STATE.idFromName("global"));
    const dedup = new DODedupStore(syncStub);
    const links = new DOLinkStore(syncStub);
    const procore = new ProcoreClient(cfg, tokens);
    const salesforce = new SalesforceClient(cfg, tokens);
    const sync = new SyncEngine(procore, salesforce, dedup, { links });

    this.server = buildMcpServer({ procore, salesforce, sync });
  }
}

/**
 * Default (non-MCP) handler: hosts the webhook receiver and a health check. The OAuth
 * provider routes /authorize, /token, /register itself; everything else falls here.
 *
 * [VERIFIED] Procore webhooks need a 2xx within 5s → ACK then process via waitUntil.
 */
const defaultHandler: ExportedHandler<Env> = {
  async fetch(req, env, ctx): Promise<Response> {
    return withSecurityHeaders(await handleDefault(req, env, ctx));
  },
};

async function handleDefault(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/webhooks/procore" && req.method === "POST") {
      const raw = await req.text();
      // Fail closed: never process an unauthenticated webhook. The handler triggers sync writes,
      // so without a configured secret a forged POST could drive Salesforce writes — reject instead.
      if (!env.WEBHOOK_SECRET) {
        console.error("[webhook] rejected: WEBHOOK_SECRET not configured (set it to enable webhooks)");
        return new Response("webhook secret not configured", { status: 401 });
      }
      const sig = req.headers.get("x-procore-signature") ?? req.headers.get("x-hub-signature-256");
      if (!(await verifyWebhookSignature(raw, sig, env.WEBHOOK_SECRET))) {
        return new Response("invalid signature", { status: 401 });
      }
      let parsed: ProcoreWebhookEvent | null = null;
      try {
        parsed = raw ? (JSON.parse(raw) as ProcoreWebhookEvent) : null;
      } catch {
        return new Response("bad payload", { status: 400 });
      }
      if (!parsed?.id) return new Response("bad payload", { status: 400 });
      const event = parsed; // const → TypeScript narrows it inside the waitUntil closure
      // ACK fast; reconcile in the background.
      ctx.waitUntil(
        (async () => {
          const cfg = loadConfig(env as unknown as Record<string, string | undefined>);
          const tokens = new PropsTokenStore("default", {}); // TODO Phase 1: resolve tenant tokens from KV
          const syncStub = env.SYNC_STATE.get(env.SYNC_STATE.idFromName("global"));
          const sync = new SyncEngine(
            new ProcoreClient(cfg, tokens),
            new SalesforceClient(cfg, tokens),
            new DODedupStore(syncStub),
            { links: new DOLinkStore(syncStub), log: (level, message, data) => console.log(`[sync:${level}] ${message}`, data ?? "") },
          );
          // Background failure can't be returned to Procore (already ACKed); log with context so it's
          // findable. Durable retry via Cloudflare Queues is the Phase-4 upgrade (see SPEC §5).
          await sync
            .handleProcoreWebhook(event)
            .catch((e) => console.error("[webhook] sync failed", { eventId: event.id, resource: event.resource_name, error: e instanceof Error ? e.message : String(e) }));
        })(),
      );
      return new Response("accepted", { status: 202 });
    }

    return new Response("not found", { status: 404 });
}

/**
 * tokenExchangeCallback — the keystone [VERIFIED]. Runs when the OAuth provider issues/
 * refreshes the MCP server's own bound token; here we exchange for the UPSTREAM Procore and
 * Salesforce tokens and stash them in props so every tool call can act on the user's behalf.
 *
 * [NEEDS LIVE VERIFICATION] the exact upstream token endpoints/payloads — wire real calls
 * to Procore (login.procore.com/oauth/token) and Salesforce (JWT/web-server flow) in Phase 1.
 */
async function tokenExchangeCallback(options: TokenExchangeCallbackOptions) {
  // options.props carries whatever the authorize step stored (e.g. upstream auth codes).
  const incoming = (options.props ?? {}) as OAuthProps;
  // TODO Phase 1: perform the two upstream exchanges and populate these.
  const newProps: OAuthProps = {
    tenantId: incoming.tenantId ?? "default",
    ...(incoming.procore ? { procore: incoming.procore } : {}),
    ...(incoming.salesforce ? { salesforce: incoming.salesforce } : {}),
  };
  return { newProps };
}

export default new OAuthProvider({
  apiRoute: "/mcp",
  // McpAgent.serve returns a fetch handler for the Streamable HTTP endpoint.
  apiHandler: ProcoreSalesforceMCP.serve("/mcp") as never,
  defaultHandler: defaultHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  tokenExchangeCallback,
});
