import { describe, it, expect } from "vitest";
import { computeHmacSha256, verifyWebhookSignature, timingSafeEqual } from "../../src/security/webhookSignature.js";

const body = JSON.stringify({ id: "evt-1", resource_name: "Projects" });
const secret = "s3cr3t-key";

describe("timingSafeEqual", () => {
  it("matches identical strings and rejects others (incl. length differences)", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a correct signature (round-trip)", async () => {
    const sig = await computeHmacSha256(body, secret);
    expect(await verifyWebhookSignature(body, sig, secret)).toBe(true);
  });

  it("tolerates a sha256= prefix and uppercase hex", async () => {
    const sig = (await computeHmacSha256(body, secret)).toUpperCase();
    expect(await verifyWebhookSignature(body, `sha256=${sig}`, secret)).toBe(true);
  });

  it("rejects a wrong signature, wrong secret, tampered body, or missing inputs", async () => {
    const sig = await computeHmacSha256(body, secret);
    expect(await verifyWebhookSignature(body, sig, "other-secret")).toBe(false);
    expect(await verifyWebhookSignature(body + "x", sig, secret)).toBe(false);
    expect(await verifyWebhookSignature(body, "deadbeef", secret)).toBe(false);
    expect(await verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(await verifyWebhookSignature(body, sig, "")).toBe(false);
  });
});
