import { describe, it, expect, afterEach } from "vitest";
import { ProcoreClient } from "../../src/clients/procore.js";
import { InMemoryTokenStore } from "../../src/auth/tokenStore.js";
import { testConfig } from "../helpers/fixtures.js";
import { installFetchMock } from "../helpers/fetchMock.js";

async function clientWithToken(token = { accessToken: "pc-access", expiresAt: Date.now() + 3_600_000 }) {
  const cfg = testConfig();
  const tokens = new InMemoryTokenStore();
  await tokens.set("default", "procore", token);
  return { client: new ProcoreClient(cfg, tokens), tokens, cfg };
}

describe("ProcoreClient auth", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("attaches bearer token and company id header", async () => {
    const { client } = await clientWithToken();
    mock = installFetchMock([{ match: "/rest/v1.0/companies", responses: { json: [{ id: 1 }] } }]);
    await client.listCompanies();
    const call = mock.callsFor("/companies")[0]!;
    expect(call.headers["authorization"]).toBe("Bearer pc-access");
    expect(call.headers["procore-company-id"]).toBe("777");
  });

  it("refreshes an expired token before the request and persists the new token", async () => {
    const { client, tokens } = await clientWithToken({
      accessToken: "old",
      refreshToken: "r1",
      expiresAt: Date.now() - 1000,
    } as never);
    mock = installFetchMock([
      { match: "/oauth/token", responses: { json: { access_token: "new", refresh_token: "r2", expires_in: 7200 } } },
      { match: "/rest/v1.0/companies", responses: { json: [] } },
    ]);
    await client.listCompanies();
    expect(mock.callsFor("/oauth/token")).toHaveLength(1);
    const companyCall = mock.callsFor("/companies")[0]!;
    expect(companyCall.headers["authorization"]).toBe("Bearer new");
    expect((await tokens.get("default", "procore"))?.accessToken).toBe("new");
  });

  it("throws when no token exists", async () => {
    const client = new ProcoreClient(testConfig(), new InMemoryTokenStore());
    await expect(client.listCompanies()).rejects.toThrow(/No Procore token/);
  });

  it("throws when expired and no refresh token is available", async () => {
    const { client } = await clientWithToken({ accessToken: "x", expiresAt: Date.now() - 1000 } as never);
    await expect(client.listCompanies()).rejects.toThrow(/no refresh token/);
  });

  it("surfaces an error when the refresh-token exchange itself fails (invalid_grant)", async () => {
    const { client } = await clientWithToken({ accessToken: "old", refreshToken: "r-bad", expiresAt: Date.now() - 1000 } as never);
    mock = installFetchMock([{ match: "/oauth/token", responses: { status: 401, text: '{"error":"invalid_grant"}' } }]);
    await expect(client.listCompanies()).rejects.toBeTruthy();
  });
});

describe("ProcoreClient resources", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("paginates listProjects across pages until a short page", async () => {
    const { client } = await clientWithToken();
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    mock = installFetchMock([
      { match: "/rest/v1.0/projects", responses: [{ json: fullPage }, { json: [{ id: 100 }] }] },
    ]);
    const projects = await client.listProjects();
    expect(projects).toHaveLength(101);
    const calls = mock.callsFor("/projects");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("page=1");
    expect(calls[1]!.url).toContain("page=2");
    expect(calls[0]!.url).toContain("company_id=777");
  });

  it("gets a single project by id", async () => {
    const { client } = await clientWithToken();
    mock = installFetchMock([{ match: "/rest/v1.0/projects/42", responses: { json: { id: 42, name: "X" } } }]);
    expect(await client.getProject(42)).toMatchObject({ id: 42 });
  });
});

describe("ProcoreClient webhooks (two-tier model)", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("creates a hook then attaches a trigger with path-param substitution", async () => {
    const { client } = await clientWithToken();
    mock = installFetchMock([
      { match: "/webhooks/hooks/9/triggers", responses: { json: { id: 1 } } },
      { match: "/webhooks/hooks", responses: { json: { id: 9 } } },
    ]);
    const hook = await client.createWebhookHook({ deliveryUrl: "https://cb/webhooks/procore", companyId: 777 });
    expect(hook.id).toBe(9);
    await client.addWebhookTrigger(hook.id, { resource_name: "Projects", event_type: "update" });

    const hookCall = mock.callsFor("/webhooks/hooks")[0]!;
    expect(hookCall.method).toBe("POST");
    expect(JSON.parse(hookCall.body!)).toMatchObject({ company_id: 777, hook: { destination_url: expect.any(String) } });

    const triggerCall = mock.callsFor("/triggers")[0]!;
    expect(triggerCall.url).toContain("/webhooks/hooks/9/triggers");
    expect(JSON.parse(triggerCall.body!)).toEqual({ trigger: { resource_name: "Projects", event_type: "update" } });
  });
});
