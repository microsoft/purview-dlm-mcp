# Design Document: Application Insights Telemetry for Purview DLM MCP Server

**Author:** Rishabh Kumar
**Date:** 2026-03-18
**Status:** Draft — Pending Review

---

## 1. Problem Statement

The Purview DLM MCP server (`@microsoft/purview-dlm-mcp`) currently has no observability beyond an in-memory execution log and `stderr` lifecycle messages. We have no visibility into:

- How often the server is used, which tools are invoked, or how long operations take
- Authentication or session initialization failures in the field
- Command timeout rates or blocked-cmdlet hit rates
- Whether users encounter errors and what categories those errors fall into

Without telemetry, we cannot measure adoption, diagnose field issues, or prioritize improvements.

## 2. Goals

| # | Goal |
|---|------|
| G1 | Emit structured telemetry to Azure Application Insights for tool invocations, session lifecycle, and errors |
| G2 | Provide opt-out controls aligned with the [Azure MCP Server pattern](https://github.com/microsoft/mcp/blob/main/servers/Azure.Mcp.Server/README.md) |
| G3 | Collect **zero PII** — no command text, no mailbox identities, no tenant names, no output content |
| G4 | Telemetry must be non-blocking — failures must never degrade server operation |

## 3. Design

### 3.1 New Module: `src/telemetry.ts`

A singleton `Telemetry` class that wraps the `applicationinsights` SDK. Initialized from `index.ts` alongside existing singletons.

```
Telemetry
├── initialize()                            // called once at startup
├── trackEvent(name, properties, metrics)   // custom events
├── trackException(error, properties)       // exception telemetry
├── flush(): Promise<void>                  // graceful shutdown
└── enabled: boolean                        // runtime check
```

**Key behaviors:**
- If telemetry is disabled via environment variable, the module becomes a **no-op** (all methods return immediately). This keeps call sites clean with no conditionals.
- The SDK's auto-collectors for HTTP requests, dependencies, and console are **disabled** — we only emit explicit custom events. The server uses stdio, not HTTP, so auto-collection adds noise.
- `flush()` is called on `SIGINT`/`SIGTERM` to ensure in-flight telemetry is delivered before exit.

### 3.2 1P Telemetry Architecture

Following the [Azure MCP Server pattern](https://github.com/microsoft/mcp/blob/main/servers/Azure.Mcp.Server/README.md), the server emits telemetry to a Microsoft-owned Application Insights resource for product improvement (aggregated usage, error rates, TSG effectiveness).

The 1P App Insights connection string is a hardcoded compile-time constant in `src/telemetry.ts`. Only custom events and metrics are emitted — no raw log or console forwarding.

**Reference implementation — how the Azure MCP Server does it (`OpenTelemetryExtensions.cs`):**

The Azure MCP Server (C#/.NET) implements this pattern as follows:

1. **Hardcoded 1P connection string:** A `private const string` holds the full Microsoft-owned App Insights connection string (instrumentation key + ingestion endpoint) directly in source code. This is a public repo — the key is intentionally visible, as App Insights instrumentation keys are not secrets (they identify where to send data, not who can read it).

2. **Release-build gate (`#if RELEASE`):** The 1P exporter is only wired up inside a `#if RELEASE` preprocessor block. During local development (`DEBUG` builds), no data flows to Microsoft — this prevents polluting production telemetry with dev noise.

3. **Selective data streams for 1P:** The Microsoft endpoint receives **only metrics and traces** — NOT logs. The code comments: *"We don't configure logging for Microsoft telemetry to avoid sending potentially sensitive log data to Microsoft."* This is a deliberate privacy boundary.

4. **Opt-out check:** Before wiring the 1P exporter, the code reads `AZURE_MCP_COLLECT_TELEMETRY_MICROSOFT`. If set to `false`, the 1P exporter is skipped entirely.

5. **OpenTelemetry SDK as the backbone:** Streams are configured via the standard `OpenTelemetryBuilder` — `.WithMetrics()`, `.WithTracing()`. Azure Monitor exporters route data to App Insights.

**Our adaptation for Node.js/TypeScript:**

Since our server is TypeScript/Node.js (not .NET), we adapt this pattern:
- The `applicationinsights` npm SDK replaces the .NET Azure Monitor exporters
- Instead of `#if RELEASE`, we gate 1P telemetry behind `NODE_ENV !== 'development'` or an equivalent check
- The 1P connection string is a `const` in `src/telemetry.ts` (same public-key-in-source approach)
- We emit only custom events and metrics (no raw log/console forwarding)

### 3.3 Configuration (Environment Variables)

| Variable | Purpose | Default |
|----------|---------|---------|
| `DLM_COLLECT_TELEMETRY` | **Opt-out** — set to `false` to disable all telemetry | `true` |
| `DLM_COLLECT_TELEMETRY_MICROSOFT` | Disable only the 1P Microsoft stream | `true` |

**Telemetry is on by default (opt-out model).** The 1P stream always emits unless explicitly disabled. This follows the [Azure MCP Server pattern](https://github.com/microsoft/mcp/blob/main/servers/Azure.Mcp.Server/README.md).

**Startup notice:** On first run, the server logs a one-time notice to stderr:
```
[DLM Diagnostics MCP] Telemetry is enabled. Set DLM_COLLECT_TELEMETRY=false to opt out.
```

### 3.4 Telemetry Events

All events share a common envelope: `{ serverVersion, nodeVersion, sessionId }`. No PII fields.

| Event Name | Trigger | Custom Metrics | Custom Properties |
|------------|---------|---------------|-------------------|
| `ServerStarted` | MCP transport connected | — | `initDurationMs` |
| `SessionInitialized` | `executor.init()` completes | `durationMs` | `success`, `stage` (module-import / token-acquire / exo-connect) |
| `SessionInitFailed` | `executor.init()` throws | `durationMs` | `stage`, `errorType` |
| `ToolInvoked` | Any tool handler returns | `durationMs` | `toolName`, `success` |
| `CommandValidationBlocked` | `validateCommand` returns invalid | — | `blockedVerb` |
| `CommandTimeout` | Execution exceeds timeout | `timeoutMs` | — |
| `GitHubIssueCreated` | `create_issue` succeeds | `durationMs` | `category` |
| `TsgUsed` | A TSG diagnostic skill is invoked | — | `tsgId` |
| `TsgFeedback` | User rates a diagnostic session | — | `tsgId`, `rating` (helpful / not-helpful), `feedbackCategory` (accuracy / completeness / relevance / other) |
| `UnhandledException` | Top-level `.catch()` | — | `errorType`, `errorMessage` |

**Explicitly excluded:** command text, cmdlet names, output/error content, UPN, organization, tenant ID, free-text feedback comments.

### 3.5 TSG Feedback Collection

A new MCP tool `submit_feedback` allows the AI assistant to collect user satisfaction signals at the end of a diagnostic session.

**Tool: `submit_feedback`**
```
Parameters:
  tsgId:              string   — identifier of the TSG/diagnostic guide used (e.g., "retention-policy-not-applying")
  rating:             enum     — "helpful" | "not-helpful"
  feedbackCategory:   enum     — "accuracy" | "completeness" | "relevance" | "other" (optional)
```

**How it works:**
1. After a diagnostic session completes, the AI assistant asks the user: *"Was this investigation helpful?"*
2. The assistant calls `submit_feedback` with the structured rating — no free-text is sent to telemetry.
3. The tool emits a `TsgFeedback` event to Application Insights and returns a confirmation to the assistant.

**Design decisions:**
- **Structured, not free-text:** Only enum values are emitted — this avoids PII leakage in feedback and keeps the data easily aggregatable.
- **Assistant-mediated:** The AI assistant decides when to prompt for feedback (typically at session end). This avoids intrusive UX since the feedback prompt is part of the natural conversation flow.
- **TSG identification:** The `tsgId` maps to the diagnostic skill used (from `.github/skills/dlm-diagnostics/`), enabling per-guide effectiveness tracking.
- **Aggregation queries:** App Insights users can query `TsgFeedback | summarize helpfulRate=countif(rating=="helpful") / count() by tsgId` to identify which guides need improvement.

### 3.6 Integration Points

```
src/index.ts          → initialize Telemetry singleton, track ServerStarted,
                        wrap each tool handler with trackEvent(ToolInvoked),
                        register submit_feedback tool, flush on shutdown
src/powershell/
  executor.ts         → track SessionInitialized / SessionInitFailed with stage breakdown
  allowlist.ts        → track CommandValidationBlocked (verb only, no command text)
src/config.ts         → add DLM_COLLECT_TELEMETRY / DLM_COLLECT_TELEMETRY_MICROSOFT parsing
src/telemetry.ts      → NEW: Telemetry class (singleton)
```

No changes to `logger.ts`, `asklearn.ts`, `tsg-diagnostics.ts`, or `github/`.

### 3.7 Dependency

Add `applicationinsights` (latest v3.x) as a **production dependency**. The package is ~2 MB and has no native addons. It is the official Microsoft SDK for Node.js App Insights telemetry.

## 4. Security Considerations

### 4.1 1P Connection String Exposure

The 1P App Insights connection string (instrumentation key + ingestion endpoint) is embedded as a compile-time constant in `src/telemetry.ts`. This repo is public, so the key is visible to anyone.

**Why this is acceptable:**
- App Insights instrumentation keys are **write-only ingestion identifiers**, not secrets. They grant the ability to *send* telemetry but never to *read* existing data. This is [Microsoft's documented position](https://learn.microsoft.com/en-us/azure/azure-monitor/app/sdk-connection-string) and the same approach used by the Azure MCP Server in its public repo.
- Read access to the 1P App Insights resource is governed by Azure RBAC on the resource — the ikey plays no role.

### 4.2 Data Poisoning Risk

An actor with the public ikey could send fabricated events to the 1P App Insights resource, polluting adoption metrics and error rates.

**Mitigations (server-side controls on the App Insights resource):**

| Control | Purpose |
|---------|---------|
| **Daily ingestion cap** | Hard GB limit — excess data is dropped, bounding cost and noise |
| **Automatic throttling** | App Insights rate-limits high-volume senders at the ingestion layer |
| **Anomaly alerting** | Azure Monitor alert rule on ingestion volume spikes to detect abuse early |
| **Schema validation (app-side)** | Only fixed-schema events with enum properties are emitted; anomalous payloads are identifiable via Kusto queries on unexpected property values |

**AAD-based ingestion was evaluated and rejected for 1P.** AAD auth to App Insights requires the caller to hold the "Monitoring Metrics Publisher" RBAC role on the target resource. Since the MCP server runs on arbitrary user machines via `npx`:

| AAD Path | Blocker |
|----------|---------|
| User's AAD identity | Microsoft cannot grant every npm user a role on an internal resource |
| Multi-tenant app (delegated) | Delegated tokens still require the user to hold the role |
| Multi-tenant app (client credentials) | Requires embedding a client secret — a real secret, strictly worse than an ikey |
| Proxy relay service | Viable (relay holds managed identity + role, accepts unauthenticated writes) but adds infrastructure, latency, and operational overhead |

The proxy relay remains a future option if data poisoning becomes a real problem. For now, server-side controls (daily cap, throttling, anomaly alerts) provide sufficient mitigation — this matches the Azure MCP Server's approach for its own 1P telemetry.

## 5. Privacy & Compliance (No PII)

- **No PII by design:** Event schemas are fixed; free-text fields (command, output, UPN, tenant) are never attached to telemetry.
- **Opt-out model:** Telemetry is on by default but can be disabled via `DLM_COLLECT_TELEMETRY=false` or `DLM_COLLECT_TELEMETRY_MICROSOFT=false`.
- **Transparency:** Startup stderr notice informs users that telemetry is active and how to opt out.
- **Data minimization:** Only structured enum values and numeric metrics are emitted. No command text, no mailbox identities, no output content, no free-text feedback.

## 6. Testing Strategy

| Layer | What | How |
|-------|------|-----|
| Unit | `Telemetry` class init, no-op when disabled, event shaping | Mock `applicationinsights` — verify `trackEvent`/`trackException` calls and payloads |
| Unit | Config parsing for `DLM_COLLECT_TELEMETRY` | Existing pattern from `config.ts` |
| Integration | Tool handlers emit telemetry | Spy on `Telemetry.trackEvent` in existing E2E fixture |

No live App Insights instance needed for CI — all tests mock the SDK.

## 7. Rollout

1. Ship with 1P telemetry **on by default** (opt-out via `DLM_COLLECT_TELEMETRY=false`) in the next minor version bump
2. Document the environment variables in README and CLAUDE.md
3. Provide a sample Kusto query set for common analyses (tool usage, error rates, latency percentiles)

## 8. Open Questions

| # | Question |
|---|----------|
| Q1 | Should `ask_learn` topic matches be tracked (topic name only) to understand which documentation areas are most queried? |
| Q2 | Do we want sampling (e.g., 50% of events) on the 1P stream to control cost at scale, or keep 100% given the expected low event volume per MCP server instance? |
| Q3 | What is the retention period for the 1P App Insights resource? (Default 90 days vs. extended for trend analysis) |
| Q4 | Should we gate 1P telemetry behind a `NODE_ENV === 'production'` check (mirroring the Azure MCP `#if !DEBUG` pattern), or emit in all environments? |
