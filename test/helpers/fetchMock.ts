import { vi } from "vitest";

/**
 * Test fetch mock. Records every call and lets a test decide the response per request,
 * including SEQUENCES (for retry/backoff testing) keyed by URL substring.
 *
 * The clients funnel all I/O through global `fetch`, so stubbing it here exercises the
 * real client + engine code paths without a network.
 */
export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface MockResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Throw a network-style error instead of responding. */
  throw?: Error;
}

type Responder = MockResponse | ((call: RecordedCall) => MockResponse);

export interface FetchMock {
  calls: RecordedCall[];
  /** Calls matching a URL substring. */
  callsFor(substr: string): RecordedCall[];
  restore(): void;
}

function toResponse(r: MockResponse): Response {
  const status = r.status ?? 200;
  const headers = new Headers(r.headers ?? {});
  if (r.json !== undefined) {
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(r.json), { status, headers });
  }
  return new Response(r.text ?? "", { status, headers });
}

/**
 * @param routes ordered matchers. The FIRST route whose `match` substring is contained in
 *   the URL handles the call. `responses` may be a single responder or an array consumed in
 *   order (subsequent calls reuse the last entry) — perfect for "429 then 200" retry tests.
 */
export function installFetchMock(
  routes: Array<{ match: string; responses: Responder | Responder[] }>,
): FetchMock {
  const calls: RecordedCall[] = [];
  const cursors = new Map<number, number>();

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
    const call: RecordedCall = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      ...(init?.body != null ? { body: String(init.body) } : {}),
    };
    calls.push(call);

    const idx = routes.findIndex((r) => url.includes(r.match));
    if (idx === -1) throw new Error(`fetchMock: no route for ${call.method} ${url}`);
    const route = routes[idx]!;

    let responder: Responder;
    if (Array.isArray(route.responses)) {
      const cur = cursors.get(idx) ?? 0;
      responder = route.responses[Math.min(cur, route.responses.length - 1)]!;
      cursors.set(idx, cur + 1);
    } else {
      responder = route.responses;
    }
    const result = typeof responder === "function" ? responder(call) : responder;
    if (result.throw) throw result.throw;
    return toResponse(result);
  });

  vi.stubGlobal("fetch", fn);
  return {
    calls,
    callsFor: (substr) => calls.filter((c) => c.url.includes(substr)),
    restore: () => vi.unstubAllGlobals(),
  };
}
