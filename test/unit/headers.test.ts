import { describe, it, expect } from "vitest";
import { SECURITY_HEADERS, withSecurityHeaders } from "../../src/security/headers.js";

describe("withSecurityHeaders", () => {
  it("sets every required security header", () => {
    const out = withSecurityHeaders(new Response("ok", { status: 200 }));
    for (const name of [
      "Strict-Transport-Security",
      "Content-Security-Policy",
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Resource-Policy",
    ]) {
      expect(out.headers.get(name), name).toBe(SECURITY_HEADERS[name]);
    }
    expect(out.headers.get("Strict-Transport-Security")).toContain("max-age=63072000");
    expect(out.headers.get("X-Frame-Options")).toBe("DENY");
    expect(out.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("preserves status and existing headers", async () => {
    const out = withSecurityHeaders(new Response('{"ok":true}', { status: 202, headers: { "content-type": "application/json" } }));
    expect(out.status).toBe(202);
    expect(out.headers.get("content-type")).toBe("application/json");
    expect(await out.text()).toBe('{"ok":true}');
  });
});
