import { describe, it, expect, afterEach } from "vitest";
import { fetchWithRetry, fetchJson, HttpError } from "../../src/clients/http.js";
import { installFetchMock } from "../helpers/fetchMock.js";

const fast = { baseDelayMs: 1, maxDelayMs: 5 };

describe("fetchWithRetry", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("returns immediately on 2xx", async () => {
    mock = installFetchMock([{ match: "/ok", responses: { status: 200, json: { a: 1 } } }]);
    const res = await fetchWithRetry("https://h/ok", {}, fast);
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
  });

  it("retries on 429 then succeeds, honoring Retry-After", async () => {
    mock = installFetchMock([
      {
        match: "/limited",
        responses: [{ status: 429, headers: { "retry-after": "0" } }, { status: 200, json: { ok: true } }],
      },
    ]);
    const res = await fetchWithRetry("https://h/limited", {}, fast);
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  it("honors an HTTP-date Retry-After then succeeds", async () => {
    const soon = new Date(Date.now() + 5).toUTCString();
    mock = installFetchMock([
      { match: "/dated", responses: [{ status: 429, headers: { "retry-after": soon } }, { status: 200, json: { ok: true } }] },
    ]);
    const res = await fetchWithRetry("https://h/dated", {}, { ...fast, maxDelayMs: 50 });
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  it("retries on 5xx", async () => {
    mock = installFetchMock([
      { match: "/flaky", responses: [{ status: 503 }, { status: 502 }, { status: 200, json: {} }] },
    ]);
    const res = await fetchWithRetry("https://h/flaky", {}, fast);
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(3);
  });

  it("gives up after maxRetries on persistent 429 and throws HttpError", async () => {
    mock = installFetchMock([{ match: "/nope", responses: { status: 429 } }]);
    await expect(fetchWithRetry("https://h/nope", {}, { ...fast, maxRetries: 2 })).rejects.toBeInstanceOf(HttpError);
    expect(mock.calls).toHaveLength(3); // initial + 2 retries
  });

  it("retries transient network errors then surfaces the last one", async () => {
    mock = installFetchMock([{ match: "/net", responses: { throw: new Error("ECONNRESET") } }]);
    await expect(fetchWithRetry("https://h/net", {}, { ...fast, maxRetries: 1 })).rejects.toThrow("ECONNRESET");
    expect(mock.calls).toHaveLength(2);
  });
});

describe("fetchJson", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("parses JSON on success", async () => {
    mock = installFetchMock([{ match: "/j", responses: { status: 200, json: { hello: "world" } } }]);
    expect(await fetchJson<{ hello: string }>("https://h/j", {}, fast)).toEqual({ hello: "world" });
  });

  it("throws HttpError with status + body on non-retryable 4xx", async () => {
    mock = installFetchMock([{ match: "/bad", responses: { status: 404, text: "missing" } }]);
    const err = await fetchJson("https://h/bad", {}, fast).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).body).toContain("missing");
  });
});
