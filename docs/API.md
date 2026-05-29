# API Reference

Two surfaces: **HTTP endpoints** (operational) and the **MCP surface** (tools/resources/prompts an
agent uses).

## HTTP endpoints
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/healthz` | none | Liveness probe → `{"ok":true}`. |
| `POST`/`GET` | `/mcp` | OAuth (bound token) | Streamable HTTP MCP transport. 401 without a valid token. |
| `POST` | `/webhooks/procore` | (webhook) | Inbound Procore events. ACKs `202` in <5s, processes async. |
| `GET` | `/.well-known/oauth-authorization-server` | none | OAuth 2.1 discovery (RFC 8414). |
| `GET` | `/authorize` · `POST /token` · `POST /register` | OAuth | Authorization, token, and Dynamic Client Registration endpoints. |
| `GET` | `/` and static paths | none | The GUI demo / docs landing page (served from `public/`). |

## MCP surface

The MCP feature model (verified): **Tools** = actions with side effects, **Resources** = read-only
context, **Prompts** = templated workflows. Defined in `src/mcp/server.ts`.

### Tools

#### `sync_procore_project_to_salesforce`
Fetch a Procore project and upsert it into Salesforce by external id.
- **Input:** `{ projectId: string | number }`
- **Returns (text):** sync result, e.g. `{ "status": "synced", "detail": "Projects#4821" }`
- **Statuses:** `synced` · `skipped_duplicate` · `deleted` · `no_mapping` · `ignored`

#### `run_reconciliation`
Delta-sweep Procore projects into Salesforce to catch missed webhooks.
- **Input:** `{ scope: "projects" }` (default `"projects"`)
- **Returns (text):** `{ "scanned": <n>, "upserted": <n> }`

#### `create_procore_webhook`
Provision a Procore webhook using the two-tier hook + triggers model.
- **Input:**
  ```jsonc
  {
    "deliveryUrl": "https://…/webhooks/procore",   // required, URL
    "companyId":  777,                              // optional (company scope)
    "projectId":  123,                              // optional (project scope)
    "triggers": [                                   // required, ≥1
      { "resource_name": "Projects", "event_type": "update" }
    ]
  }
  ```
  `event_type` ∈ `create | update | delete`.
- **Returns (text):** `{ "hookId": <n>, "triggers": <count> }`
- **Errors:** invalid input returns an MCP result with `isError: true` (validation is in-band, not a throw).

### Featured tool — legal documents (0.4.0)
| Tool | Input | Output | MCP feature |
|---|---|---|---|
| **`sync_project_legal_documents`** ★ | `{ projectId }` | `{ synced, byObject }` | structured output · idempotent upsert |

★ The headline capability. Upserts a project's **contracts, insurance certificates, lien waivers
and compliance records** into Salesforce custom objects (`Procore_Contract_Document__c`,
`Procore_Insurance_Certificate__c`, `Procore_Lien_Waiver__c`, `Procore_Compliance_Document__c`) by
External ID. `byObject` reports the per-object upsert count. Honors `AbortSignal`.

### Salesforce-native legal-document operations (0.5.0 · Tier 1)
All six run on the **`api` OAuth scope** Conduit already uses — no add-on. Grounded in primary
Salesforce docs (ContentVersion multipart blob-insert, Process Approvals REST resource, Contract SOQL).

| Tool | Input | Output | API used |
|---|---|---|---|
| **`upload_contract_file`** | `{ recordId, fileName, contentBase64, title? }` | `{ contentVersionId, linkedTo }` | REST **multipart** → `ContentVersion`, linked via `FirstPublishLocationId`. Practical limit **~20 MB** (buffered in the Worker; Salesforce itself allows 2 GB) |
| `get_contract` | `{ contractId }` | `{ contract }` | `GET /sobjects/Contract/{id}` |
| `list_contracts_by_status` | `{ status, limit? }` | `{ records, count }` | SOQL on `Contract` (status escaped) |
| `submit_for_approval` | `{ recordId, comments?, nextApproverIds?, processDefinitionNameOrId? }` | `{ result }` | `POST /process/approvals/` |
| `list_approval_processes` | `{}` | `{ approvals }` | `GET /process/approvals/` |
| `check_signature_status` | `{ envelopeId }` | `{ available, records, detail? }` | SOQL on `dsfs__DocuSign_Status__c` (graceful if package absent) |

> Binary file content arrives as **base64** over MCP's JSON transport; `upload_contract_file` decodes
> it and POSTs **multipart/form-data** to `ContentVersion` (avoiding the ~37.5 MB base64 path).
> `check_signature_status` depends on the DocuSign managed package (newer installs use `dfsle__`).

### Tools added in 0.2.0
| Tool | Input | Output | MCP feature |
|---|---|---|---|
| `sync_procore_financials` | `{ projectId }` | `{ synced, byObject }` | structured output |
| `create_salesforce_case_from_rfi` | `{ projectId, rfiId }` | `{ caseId, rfiId }` | tool |
| `sync_salesforce_to_procore` | `{ sobject, changeType, recordId, fields }` | `{ status, detail? }` | reverse sync (CDC) |
| `dedupe_contacts` | `{ contacts: [{id,name?,email?,source}] }` | `{ duplicateGroups, merges }` | **elicitation** (canonical email) |
| `resolve_sync_conflict` | `{ objectKey, field, procoreValue, salesforceValue }` | `{ resolved, decision?, winner? }` | **elicitation** (enum) |
| `summarize_project` | `{ projectId }` | `{ projectId, summary, model? }` | **sampling** |
| `list_procore_projects` | `{ cursor?, limit? }` | `{ items, nextCursor? }` | **pagination** (cursor) |
| `authorize_salesforce` | `{ scope? }` | `{ action }` | **URL-mode elicitation** (SEP-1036) |

Additional protocol features in use: **logging** (`run_reconciliation` streams `notifications/message`),
**cancellation** (reconcile/legal-docs/financials honor `AbortSignal`), and **`resources/list_changed`** (fired when a
reverse create introduces a new resource).

All tools carry annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`). Tools that need
client capabilities (sampling/elicitation) return an `isError` result if the client lacks support.

### Resources

#### `config://mappings`
The configured Procore↔Salesforce object mappings (the `MAPPINGS` registry) as JSON. Read-only.

#### Resource templates (with completion / id parameters)
- `conduit://search/{query}` — cross-system search (Procore + Salesforce); `{query}` autocompletes.
- `procore://project/{id}` — read a Procore project record.
- `salesforce://account/{id}` — read a Salesforce Account record.

Subscribers receive `notifications/resources/updated` when a record syncs.

### Prompts

#### `audit_unmapped_records`
Guided workflow to find records present in one system but missing in the other.
- **Arguments:** `{ objectKey: string }` (a mapping key, e.g. `"project"`)
- **Returns:** a user message templating the audit steps for that object pair.

## Calling a tool (TypeScript MCP client)
```ts
const res = await client.callTool({
  name: "sync_procore_project_to_salesforce",
  arguments: { projectId: 4821 },
});
// res.content[0].text → '{ "status": "synced", "detail": "Projects#4821" }'
```

## Webhook payload (inbound)  — `[NEEDS LIVE VERIFICATION]`
```jsonc
{
  "id": "01J8…ZK",          // event id / ULID — the dedup anchor
  "resource_name": "Projects",
  "event_type": "update",   // create | update | delete
  "resource_id": 4821,
  "company_id": 777,
  "project_id": 4821,
  "timestamp": "2026-05-28T18:42:11Z"
}
```
Conduit ACKs `202` immediately, then deduplicates by `id` and reconciles out of band.
