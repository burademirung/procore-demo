import { describe, it, expect, afterEach } from "vitest";
import { buildTestStack } from "../helpers/fixtures.js";
import { installFetchMock } from "../helpers/fetchMock.js";
import type { ProcoreWebhookEvent } from "../../src/sync/engine.js";

/**
 * Inbound real-time path, end to end: Procore webhook event → dedup → fetch full record →
 * field-map → Salesforce upsert. Mirrors what the Node/Worker HTTP handlers feed the engine
 * after ACKing 2xx. Covers a second mapping (Companies → Account) for breadth.
 */
describe("inbound webhook → Salesforce reconciliation", () => {
  let mock: ReturnType<typeof installFetchMock>;
  afterEach(() => mock?.restore());

  it("maps a Companies event into a Salesforce Account upsert", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      // A Companies event must fetch the COMPANY endpoint, not projects (regression guard for the
      // resource-aware fetch dispatcher).
      { match: "/rest/v1.0/companies/55", responses: { json: { id: 55, name: "Acme Builders", city: "Austin" } } },
      { match: "/sobjects/Account/Procore_Company_Id__c/", responses: { json: { id: "001", success: true, created: true } } },
    ]);

    const event: ProcoreWebhookEvent = {
      id: "wh-company-1",
      resource_name: "Companies",
      event_type: "create",
      resource_id: 55,
    };
    const result = await sync.handleProcoreWebhook(event);

    expect(result.status).toBe("synced");
    const upsert = mock.callsFor("/sobjects/Account/Procore_Company_Id__c/")[0]!;
    expect(upsert.url).toContain("/Procore_Company_Id__c/55");
    expect(JSON.parse(upsert.body!)).toMatchObject({ Name: "Acme Builders", BillingCity: "Austin" });
  });

  it("survives replay storms — only the first of N identical deliveries does work", async () => {
    const { sync } = await buildTestStack();
    mock = installFetchMock([
      { match: "/rest/v1.0/companies/55", responses: { json: { id: 55, name: "Acme" } } },
      { match: "/sobjects/Account/Procore_Company_Id__c/", responses: { json: { id: "001", success: true } } },
    ]);
    const event: ProcoreWebhookEvent = { id: "storm", resource_name: "Companies", event_type: "update", resource_id: 55 };

    const results = await Promise.all([
      sync.handleProcoreWebhook({ ...event }),
      sync.handleProcoreWebhook({ ...event }),
      sync.handleProcoreWebhook({ ...event }),
    ]);
    const synced = results.filter((r) => r.status === "synced").length;
    const duped = results.filter((r) => r.status === "skipped_duplicate").length;
    expect(synced).toBe(1);
    expect(duped).toBe(2);
  });
});
