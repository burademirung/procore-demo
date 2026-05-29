/**
 * Shared HTTP helper with rate-limit-aware retry/backoff.
 *
 * Research [VERIFIED]: Procore webhooks retry with exponential backoff (1s→1hr). Both
 * Procore (per-hour rate limits) and Salesforce (daily governor limits) return 429s under
 * load, so every outbound call funnels through here to honor Retry-After and back off.
 *
 * [NEEDS LIVE VERIFICATION] exact limit headers/values differ per provider — confirm:
 *   - Procore: `Retry-After` + remaining-request headers on 429.
 *   - Salesforce: `Sforce-Limit-Info` header reports daily API usage.
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Decide how long to wait before a retry. Prefers the server's Retry-After header,
 * falling back to capped exponential backoff. Deterministic (no jitter) so it is unit
 * testable; add jitter in production to avoid thundering-herd on shared limits.
 */
function backoffMs(attempt: number, retryAfter: string | null, opts: Required<RetryOptions>): number {
  if (retryAfter) {
    // Retry-After is either delta-seconds or an HTTP-date (RFC 9110).
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, opts.maxDelayMs);
    const when = Date.parse(retryAfter);
    if (!Number.isNaN(when)) return Math.max(0, Math.min(when - Date.now(), opts.maxDelayMs));
  }
  return Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const cfg: Required<RetryOptions> = {
    maxRetries: opts.maxRetries ?? 4,
    baseDelayMs: opts.baseDelayMs ?? 500,
    maxDelayMs: opts.maxDelayMs ?? 60_000,
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      // Retry on rate limit (429) and transient server errors (5xx).
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt === cfg.maxRetries) {
          throw new HttpError(res.status, await safeBody(res), url);
        }
        await sleep(backoffMs(attempt, res.headers.get("retry-after"), cfg));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError) throw err;
      // Network error: back off and retry.
      if (attempt === cfg.maxRetries) break;
      await sleep(backoffMs(attempt, null, cfg));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`fetch failed for ${url}`);
}

async function safeBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}

/** Convenience: fetch + JSON parse, throwing HttpError on non-2xx. */
export async function fetchJson<T>(url: string, init: RequestInit, opts?: RetryOptions): Promise<T> {
  const res = await fetchWithRetry(url, init, opts);
  if (!res.ok) throw new HttpError(res.status, await safeBody(res), url);
  return (await res.json()) as T;
}
