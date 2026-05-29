/**
 * Webhook signature verification (HMAC-SHA256), timing-safe.
 *
 * Inbound webhooks are unauthenticated by default — anyone who learns the delivery URL could POST
 * forged events and inject data into Salesforce. When a shared secret is configured, the receiver
 * verifies an HMAC of the raw body before processing.
 *
 * Uses Web Crypto (`crypto.subtle`) so the same code runs on Node 20+ and Cloudflare Workers.
 *
 * [NEEDS LIVE VERIFICATION] Confirm Procore's exact signing scheme (header name + algorithm) and
 * adjust `extractSignature` / the digest encoding accordingly before production.
 */

const encoder = new TextEncoder();

function hexFromBuffer(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare (avoids leaking match length/position via timing). */
export function timingSafeEqual(a: string, b: string): boolean {
  // Process the full length regardless of mismatch so the comparison is genuinely constant-time
  // (a length difference seeds a non-zero diff but does not short-circuit the loop).
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Compute the lowercase hex HMAC-SHA256 of `rawBody` with `secret`. */
export async function computeHmacSha256(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return hexFromBuffer(sig);
}

/**
 * Verify a webhook signature. Tolerates an optional `sha256=` prefix on the provided signature.
 * Returns false on any mismatch or missing input.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const provided = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : signatureHeader;
  const expected = await computeHmacSha256(rawBody, secret);
  return timingSafeEqual(provided.toLowerCase(), expected);
}
