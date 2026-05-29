import { loadConfig, type Config } from "../../src/config.js";
import { InMemoryTokenStore } from "../../src/auth/tokenStore.js";
import { InMemoryDedupStore } from "../../src/sync/dedup.js";
import { ProcoreClient } from "../../src/clients/procore.js";
import { SalesforceClient } from "../../src/clients/salesforce.js";
import { SyncEngine } from "../../src/sync/engine.js";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    PORT: "8788",
    MCP_ALLOWED_ORIGINS: "http://localhost,https://claude.ai",
    PROCORE_CLIENT_ID: "pc-client",
    PROCORE_CLIENT_SECRET: "pc-secret",
    PROCORE_AUTH_BASE: "https://login.procore.test",
    PROCORE_API_BASE: "https://api.procore.test",
    PROCORE_COMPANY_ID: "777",
    SF_LOGIN_URL: "https://login.salesforce.test",
    SF_CLIENT_ID: "sf-client",
    SF_API_VERSION: "v62.0",
    ...overrides,
  });
}

/** Build a fully-wired stack with seeded, non-expired tokens for both providers. */
export async function buildTestStack(cfgOverrides: Record<string, string> = {}) {
  const cfg = testConfig(cfgOverrides);
  const tokens = new InMemoryTokenStore();
  const dedup = new InMemoryDedupStore();
  await tokens.set("default", "procore", {
    accessToken: "pc-access",
    refreshToken: "pc-refresh",
    expiresAt: Date.now() + 3_600_000,
  });
  await tokens.set("default", "salesforce", {
    accessToken: "sf-access",
    instanceUrl: "https://acme.my.salesforce.test",
    expiresAt: Date.now() + 3_600_000,
  });
  const procore = new ProcoreClient(cfg, tokens);
  const salesforce = new SalesforceClient(cfg, tokens);
  const sync = new SyncEngine(procore, salesforce, dedup);
  return { cfg, tokens, dedup, procore, salesforce, sync };
}
