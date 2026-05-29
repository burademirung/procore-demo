# Conduit Documentation

Complete documentation for **Conduit** — a Model Context Protocol (MCP) server that brokers
bidirectional sync between **Procore** (construction management) and **Salesforce** (CRM).

> **Live demo & landing page:** https://procore-salesforce-mcp.burademirung.workers.dev
> **Repository:** https://github.com/burademirung/procore-demo

## Start here
| Doc | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, the two-plane model, request/data flows, diagrams |
| [API.md](API.md) | HTTP endpoints + every MCP tool, resource, and prompt (schemas, examples) |
| [MCP_CAPABILITIES.md](MCP_CAPABILITIES.md) | **The full MCP protocol surface** — each capability → demo scenario → real artifact → spec |
| [AUTHENTICATION.md](AUTHENTICATION.md) | The three OAuth relationships, dual-token brokering, PKCE, JWT |
| [CONFIGURATION.md](CONFIGURATION.md) | Every environment variable / secret and what it does |
| [DATA_MAPPING.md](DATA_MAPPING.md) | Object/field maps, direction, idempotency, conflict & delete handling |
| [SYNC_ENGINE.md](SYNC_ENGINE.md) | Webhook ingestion, dedup, reconciliation, sequence diagrams |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Cloudflare deploy: Workers, Durable Objects, KV, Cron, secrets |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Local setup, project layout, build targets, workflows |
| [MODULE_REFERENCE.md](MODULE_REFERENCE.md) | File-by-file, export-by-export reference (lowest level) |
| [TESTING.md](TESTING.md) | Test strategy, the 143-test suite, coverage gates, helpers |
| [SECURITY.md](SECURITY.md) | Threat model, SAST/SCA/lint, secrets, best practices |
| [FOR_AI_AGENTS.md](FOR_AI_AGENTS.md) | **For AI agents that connect to Conduit** — capabilities, how to call tools, behavior guidance |

## Also in the repo root
- [`../README.md`](../README.md) — project overview & quickstart
- [`../AGENTS.md`](../AGENTS.md) — guidance for AI agents working **in** this repo
- [`../SPEC.md`](../SPEC.md) — the original research-grounded build spec
- [`../CHANGELOG.md`](../CHANGELOG.md) — version history
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — contributor guide

## Status
**Phase 0 (Foundation)** is complete and deployed. Phases 1–6 (live OAuth token exchange, verified
API contracts, Bulk API 2.0 jobs, Salesforce CDC, hardening) are described in [`../SPEC.md`](../SPEC.md) §8.
Contracts tagged `[NEEDS LIVE VERIFICATION]` must be confirmed against live Procore/Salesforce
docs before production traffic.
