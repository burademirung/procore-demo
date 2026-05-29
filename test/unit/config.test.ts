import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("config", () => {
  it("applies defaults when env is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(8788);
    expect(cfg.procore.authBase).toBe("https://login.procore.com");
    expect(cfg.procore.apiBase).toBe("https://api.procore.com");
    expect(cfg.salesforce.loginUrl).toBe("https://login.salesforce.com");
    expect(cfg.salesforce.apiVersion).toBe("v62.0");
  });

  it("parses and trims the origin allowlist into an array", () => {
    const cfg = loadConfig({ MCP_ALLOWED_ORIGINS: "http://a , https://b ,, http://c" });
    expect(cfg.mcpAllowedOrigins).toEqual(["http://a", "https://b", "http://c"]);
  });

  it("coerces the port from a string", () => {
    expect(loadConfig({ PORT: "9000" }).port).toBe(9000);
  });

  it("passes through provider credentials", () => {
    const cfg = loadConfig({ PROCORE_CLIENT_ID: "x", SF_USERNAME: "u@e.com" });
    expect(cfg.procore.clientId).toBe("x");
    expect(cfg.salesforce.username).toBe("u@e.com");
  });

  it("accepts a non-empty webhook secret but rejects an empty one (fail loud)", () => {
    expect(loadConfig({ WEBHOOK_SECRET: "s3cret" }).webhookSecret).toBe("s3cret");
    expect(loadConfig({}).webhookSecret).toBeUndefined();
    expect(() => loadConfig({ WEBHOOK_SECRET: "" })).toThrow();
  });
});
