import { describe, it, expect, afterEach } from "vitest";
import { ProcoreClient } from "../../src/clients/procore.js";
import { InMemoryTokenStore } from "../../src/auth/tokenStore.js";
import { HttpError } from "../../src/clients/http.js";
import { testConfig } from "../helpers/fixtures.js";
import { installFetchMock } from "../helpers/fetchMock.js";

async function clientWithToken(token = { accessToken: "pc-access", expiresAt: Date.now() + 3_600_000 }, cfgOverrides = {}) {
  const cfg = testConfig(cfgOverrides);
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

  it("percent-encodes path components in getById / getProjectResource", async () => {
    const { client } = await clientWithToken();
    mock = installFetchMock([{ match: "/rest/v1.0/", responses: { json: { id: 1 } } }]);
    await client.getById("companies", "a/b");
    await client.getProjectResource("rfis", 7, "x/y");
    expect(mock.calls[0]!.url).toContain("/rest/v1.0/companies/a%2Fb");
    expect(mock.calls[1]!.url).toContain("/rest/v1.0/projects/7/rfis/x%2Fy");
  });

  it("throws HttpError when a paginated page returns an error status", async () => {
    const { client } = await clientWithToken();
    mock = installFetchMock([{ match: "/rest/v1.0/projects", responses: { status: 403, text: "Forbidden" } }]);
    await expect(client.listProjects()).rejects.toBeInstanceOf(HttpError);
  });

  it("omits the company-id header when no company is configured", async () => {
    const { client } = await clientWithToken({ accessToken: "pc-access", expiresAt: Date.now() + 3_600_000 }, { PROCORE_COMPANY_ID: "" });
    mock = installFetchMock([{ match: "/rest/v1.0/companies", responses: { json: [] } }]);
    await client.listCompanies();
    expect(mock.calls[0]!.headers["procore-company-id"]).toBeUndefined();
  });
});

describe("ProcoreClient write-back (SF → Procore)", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("creates a project-scoped record (POST under the project)", async () => {
    const { client } = await clientWithToken();
    mock = installFetchMock([{ match: "/rest/v1.0/projects/7/contract_documents", responses: { json: { id: 555 } } }]);
    const r = await client.createProjectResource("contract_documents", 7, { title: "MA", status: "Draft" });
    expect(r.id).toBe(555);
    const call = mock.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("/rest/v1.0/projects/7/contract_documents");
    expect(JSON.parse(call.body!)).toMatchObject({ title: "MA", status: "Draft" });
  });

  it("updates a project-scoped record by id (PATCH) with encoded path", async () => {
    const { client } = await clientWithToken();
    mock = installFetchMock([{ match: "/rest/v1.0/projects/7/contract_documents/55", responses: { json: { id: 55 } } }]);
    await client.updateProjectResource("contract_documents", 7, 55, { status: "Executed" });
    const call = mock.calls[0]!;
    expect(call.method).toBe("PATCH");
    expect(call.url).toContain("/rest/v1.0/projects/7/contract_documents/55");
    expect(JSON.parse(call.body!)).toEqual({ status: "Executed" });
  });

  it("deletes a project-scoped record without parsing a body", async () => {
    const { client } = await clientWithToken();
    mock = installFetchMock([{ match: "/rest/v1.0/projects/7/lien_waivers/88", responses: { text: "" } }]);
    await client.deleteProjectResource("lien_waivers", 7, 88);
    expect(mock.calls[0]!.method).toBe("DELETE");
  });

  it("updates and deletes top-level records", async () => {
    const { client } = await clientWithToken();
    mock = installFetchMock([{ match: "/rest/v1.0/projects/42", responses: { json: { id: 42 } } }]);
    await client.update("projects", 42, { name: "Renamed" });
    await client.delete("projects", 42);
    expect(mock.calls[0]!.method).toBe("PATCH");
    expect(mock.calls[1]!.method).toBe("DELETE");
  });

  it("throws HttpError when a delete is rejected", async () => {
    const { client } = await clientWithToken();
    mock = installFetchMock([{ match: "/rest/v1.0/projects/7/lien_waivers/88", responses: { status: 403, text: "Forbidden" } }]);
    await expect(client.deleteProjectResource("lien_waivers", 7, 88)).rejects.toBeInstanceOf(HttpError);
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
