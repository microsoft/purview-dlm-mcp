# Design Document: Application Insights Telemetry for Purview DLM MCP Server

**Author:** Rishabh Kumar
**Date:** 2026-03-18
**Status:** Draft — Pending Review

---

## Problem

The Purview DLM MCP server has no observability beyond an in-memory execution log and stderr lifecycle messages. We cannot measure adoption, diagnose field failures (auth errors, timeouts, blocked-cmdlet rates), or assess which diagnostic guides are effective. We need structured telemetry that respects user privacy.

## Goals

1. Emit structured telemetry to Azure Application Insights for tool invocations, session lifecycle, and errors
2. Support user-owned App Insights instances via `APPLICATIONINSIGHTS_CONNECTION_STRING`
3. Provide opt-out controls aligned with the [Azure MCP Server pattern](https://github.com/microsoft/mcp/blob/main/servers/Azure.Mcp.Server/README.md)
4. Collect **zero PII** — no command text, no mailbox identities, no tenant names, no output content
5. Telemetry must be non-blocking — failures never degrade server operation

## Non-Goals

- Distributed tracing across MCP client/server boundary
- Real-time alerting or dashboards (consumers build their own)
- Instrumenting pure evaluator functions in `tsg-diagnostics.ts`

---

## Design

### New Module: `src/telemetry.ts`

A singleton `Telemetry` class wrapping the `applicationinsights` npm SDK (v3.x, ~2 MB, no native addons). Initialized from `index.ts` alongside existing singletons. When no connection string is provided and telemetry is not disabled, all methods become **no-ops** — call sites need no conditionals. The SDK's HTTP/dependency auto-collectors are disabled (the server uses stdio, not HTTP).

### Dual-Stream Architecture

Following the Azure MCP Server pattern, telemetry flows to two independent destinations:

| Stream | Purpose | Connection String | Default |
|--------|---------|-------------------|---------|
| **1P (Microsoft)** | Aggregated usage & error rates | Hardcoded constant in source | On |
| **User-owned** | User's own observability | `APPLICATIONINSIGHTS_CONNECTION_STRING` env var | Off |

The 1P connection string is a compile-time constant in `src/telemetry.ts`. App Insights instrumentation keys are not secrets — they identify a destination, not an authorization. For 1P, only custom events and metrics are emitted (no raw log forwarding). For user-owned, the full SDK surface is enabled.

### Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | User-owned App Insights instance | _(disabled)_ |
| `DLM_COLLECT_TELEMETRY` | Set `false` to disable **all** telemetry | `true` |
| `DLM_COLLECT_TELEMETRY_MICROSOFT` | Set `false` to disable 1P stream only | `true` |

On startup, the server logs to stderr: `[DLM Diagnostics MCP] Telemetry is enabled. Set DLM_COLLECT_TELEMETRY=false to opt out.`

### Event Schema

All events share a common envelope: `{ serverVersion, nodeVersion, os, sessionId }`. No PII fields.

| Event | Trigger | Key Properties/Metrics |
|-------|---------|----------------------|
| `ServerStarted` | Transport connected | `initDurationMs` |
| `SessionInitialized` | `executor.init()` succeeds | `durationMs`, `stage` |
| `SessionInitFailed` | `executor.init()` throws | `durationMs`, `stage`, `errorType` |
| `ToolInvoked` | Any tool handler returns | `toolName`, `success`, `durationMs` |
| `CommandValidationBlocked` | Allowlist rejects command | `blockedVerb` |
| `CommandTimeout` | Execution exceeds timeout | `timeoutMs` |
| `GitHubIssueCreated` | `create_issue` succeeds | `category`, `durationMs` |
| `TsgFeedback` | User rates a diagnostic | `tsgId`, `rating`, `feedbackCategory` |
| `UnhandledException` | Top-level `.catch()` | `errorType`, `errorMessage` |

**Explicitly excluded from all events:** command text, cmdlet names, output/error content, UPN, organization, tenant ID, free-text comments.

### New Tool: `submit_feedback`

A new MCP tool that collects structured user satisfaction signals. Parameters: `tsgId` (string), `rating` ("helpful" | "not-helpful"), `feedbackCategory` ("accuracy" | "completeness" | "relevance" | "other", optional). Emits a `TsgFeedback` event. The AI assistant mediates when to prompt — typically at session end — keeping it non-intrusive.

### Integration Points

| File | Change |
|------|--------|
| `src/telemetry.ts` | **New** — Telemetry class |
| `src/index.ts` | Initialize singleton, track `ServerStarted`, wrap tool handlers with `ToolInvoked`, register `submit_feedback`, flush on `SIGINT`/`SIGTERM` |
| `src/powershell/executor.ts` | Track `SessionInitialized` / `SessionInitFailed` / `CommandTimeout` |
| `src/powershell/allowlist.ts` | Track `CommandValidationBlocked` |
| `src/config.ts` | Parse `DLM_COLLECT_TELEMETRY` / `DLM_COLLECT_TELEMETRY_MICROSOFT` |

No changes to `logger.ts`, `asklearn.ts`, `tsg-diagnostics.ts`, or `github/`.

---

## Testing Strategy

| Layer | Scope | Approach |
|-------|-------|----------|
| Unit | Telemetry class init, no-op when disabled, event payload shaping | Mock `applicationinsights` — verify `trackEvent`/`trackException` calls |
| Unit | Config parsing for new env vars | Same pattern as existing `COMMAND_TIMEOUT_MS` |
| Integration | Tool handlers emit telemetry | Spy on `Telemetry.trackEvent` in existing E2E fixture |

No live App Insights instance required for CI — all tests mock the SDK.

## Privacy & Compliance

- **No PII by design** — event schemas are fixed; free-text fields never attached
- **Opt-out model** — `DLM_COLLECT_TELEMETRY=false` disables everything; `DLM_COLLECT_TELEMETRY_MICROSOFT=false` disables 1P only
- **Transparency** — stderr notice on startup
- **Data minimization** — only structured enums and numeric metrics

## Open Questions

1. Should `ask_learn` topic matches be tracked (topic name only) for documentation prioritization?
2. Sampling (e.g., 50%) on 1P stream, or 100% given low per-instance volume?
3. Retention period for the 1P App Insights resource (90 days default vs. extended)?
4. Gate 1P behind `NODE_ENV === 'production'`, or rely solely on `DLM_COLLECT_TELEMETRY_MICROSOFT`?
