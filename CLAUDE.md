# CLAUDE.md — Purview DLM Diagnostics MCP Server

## Project Purpose

This is an MCP (Model Context Protocol) server that enables AI assistants to diagnose Microsoft Purview Data Lifecycle Management (DLM) issues in Exchange Online. It provides five tools—`run_powershell`, `get_execution_log`, `ask_learn`, `create_issue`, and `submit_feedback`—that let an AI run read-only PowerShell commands against Exchange Online and Security & Compliance sessions, review the diagnostic trail, look up Microsoft Learn documentation, report issues with the MCP server to GitHub, and collect structured diagnostic session feedback.

## Architecture

Built with **TypeScript** and the **official MCP SDK** (`@modelcontextprotocol/sdk`). Distributed via **npm** as `@microsoft/purview-dlm-mcp`, installable via `npx`.

```
src/
├── index.ts                        # Entry point: main(), MCP server, stdio transport, inline tool registration
├── config.ts                       # Exports COMMAND_TIMEOUT_MS, COLLECT_TELEMETRY, COLLECT_TELEMETRY_MICROSOFT
├── powershell/
│   ├── allowlist.ts                # Regex-based command validation (Set<string>)
│   └── executor.ts                 # PsExecutor: child_process.spawn('pwsh'), MSAL auth via subprocess, marker-based polling
├── tsg-diagnostics.ts              # All diagnostics: Severity enum, parsers, 10 evaluators (~1700 lines), report renderer
├── asklearn.ts                     # Topic map (11 topics) + keyword lookup + markdown formatting
├── github/
│   ├── auth.ts                     # GitHubAuth: DLM_GITHUB_TOKEN env var → gh CLI fallback, in-memory token cache
│   └── issues.ts                   # buildIssueBody, categoryToLabels, createGitHubIssue via REST API
├── telemetry.ts                    # Telemetry singleton: Application Insights wrapper (1P, no PII, opt-out)
├── logger.ts                       # In-memory LogEntry[] + toMarkdown()
└── utils.ts                        # escapeForPs, tryParseJson, truncate
tests/
├── unit/
│   ├── cmdletAllowlist.test.ts     # ~23 tests
│   ├── outputParsers.test.ts       # ~29 tests
│   ├── askLearn.test.ts            # ~10 tests
│   ├── executionLog.test.ts        # ~5 tests
│   ├── githubAuth.test.ts          # ~8 tests
│   ├── githubIssues.test.ts        # ~10 tests
│   └── telemetry.test.ts           # ~17 tests
└── e2e/
    ├── endToEnd.test.ts            # ~30 tests (requires EXO)
    ├── tsgEvaluators.test.ts       # ~14 tests (requires EXO)
    └── fixtures/
        └── mcpServerFixture.ts     # Spawns server, polls readiness, provides MCP client
```

### Key Components

- **`index.ts`** — `main()` wrapper with `.catch()`. Creates singletons (ExecutionLog, PsExecutor), registers MCP tools inline, connects stdio transport BEFORE background PS init.
- **`executor.ts`** — Spawns a single long-lived `pwsh` process via `child_process.spawn`. Acquires MSAL access token by spawning a separate short-lived pwsh process that uses the MSAL DLL bundled with ExchangeOnlineManagement. Includes `executeJson<T>()` convenience method.
- **`allowlist.ts`** — Defines the explicit set of allowed cmdlets (`Get-*`, `Test-*`, `Export-*`) and blocked verb prefixes. Every command is validated before execution.
- **`tsg-diagnostics.ts`** — Combined module: types/enums, output parsers, 10 pure evaluator functions, and markdown report renderer. No external imports.
- **`github/auth.ts`** — `GitHubAuth` class: resolves a GitHub token from `DLM_GITHUB_TOKEN` env var or `gh auth token` CLI, caches in-memory.
- **`github/issues.ts`** — Builds structured issue bodies with session diagnostic context (no PII), maps categories to labels, creates issues via GitHub REST API.
- **`telemetry.ts`** — `Telemetry` class: wraps `applicationinsights` TelemetryClient. No-op when disabled. Tracks tool invocations, session lifecycle, and errors. 1P only, no PII.

## Skills

Skills are self-contained diagnostic guides used by AI assistants:

- **Location:** `.github/skills/` (for GitHub Copilot) and `.claude/skills/` (for Claude Code)
- **Current skills:**
  - `dlm-diagnostics` — 11 troubleshooting guides for DLM issues (retention policies, archive, inactive mailboxes, etc.)
  - `asklearn` — Fallback skill that surfaces Microsoft Learn documentation for Purview topics
  - `skill-creator` — Meta-skill for authoring new skills following project conventions

## Security Model

1. **Read-only allowlist** — Only `Get-*`, `Test-*`, `Export-*` cmdlets may be executed. All `Set-*`, `New-*`, `Remove-*`, `Enable-*`, `Start-*`, `Invoke-*` are blocked at the validation layer (`allowlist.ts`).
2. **No stored credentials** — Authentication uses MSAL interactive browser flow via a subprocess that loads the MSAL DLL from ExchangeOnlineManagement; tokens are in-memory only.
3. **Session isolation** — Each MCP server instance runs its own PowerShell process with its own session.
4. **Audit trail** — Every command and result is logged via `ExecutionLog` and retrievable through `get_execution_log`.
5. **GitHub authentication** — `create_issue` authenticates via `DLM_GITHUB_TOKEN` env var or `gh auth token` CLI; no credentials are stored.
6. **Telemetry** — 1P Application Insights only, no PII collected. Opt-out via `DLM_COLLECT_TELEMETRY=false` or `DLM_COLLECT_TELEMETRY_MICROSOFT=false`.

## Development Commands

```bash
npm install                          # Install dependencies
npm run build                        # Build TypeScript
npm test                             # Run unit tests (Vitest, no EXO needed)
npm run test:e2e                     # Run E2E + TSG tests (requires EXO)
npm run lint                         # Run ESLint
npm run format                       # Check Prettier formatting
node dist/index.js                   # Start the MCP server
```

## Testing

- **Test runner:** Vitest
- **Unit tests (no EXO):** `cmdletAllowlist.test.ts`, `outputParsers.test.ts`, `askLearn.test.ts`, `executionLog.test.ts`, `githubAuth.test.ts`, `githubIssues.test.ts`, `telemetry.test.ts` — 107 tests
- **E2E tests (live EXO):** `endToEnd.test.ts` — 30 tests
- **TSG integration tests (live EXO):** `tsgEvaluators.test.ts` — ~14 tests
- **Environment variables:** Tests require `DLM_UPN` and `DLM_ORGANIZATION` for Exchange Online connectivity. `DLM_COMMAND_TIMEOUT_MS` optionally overrides the default command timeout (180 000 ms). `DLM_COLLECT_TELEMETRY` and `DLM_COLLECT_TELEMETRY_MICROSOFT` control telemetry (default: `true`).
- **Known gotchas:**
  1. E2E and TSG tests require a live PowerShell 7 (`pwsh`) installation and Exchange Online access.
  2. Unit tests (allowlist, parser, ask-learn, execution-log) run without external dependencies.
  3. The `mcpServerFixture` starts a single MCP server process shared across E2E/TSG tests.
  4. The build must succeed (`npm run build`) before E2E tests can run.

## Coding Conventions

- **Copyright headers:** Every `.ts` file starts with:
  ```
  // Copyright (c) Microsoft Corporation.
  // Licensed under the MIT License.
  ```
- **Language:** TypeScript 5 / Node.js 18+, strict mode enabled
- **Module system:** ESM (`"type": "module"` in package.json), `NodeNext` module resolution
- **MCP tools:** Zod schemas for parameter validation, registered inline in `index.ts` via `server.tool()`
- **DI:** Manual singletons (no framework — only 2 services: PsExecutor, ExecutionLog)
- **Pure evaluators:** Diagnostic evaluation functions in `tsg-diagnostics.ts` are pure (no I/O, no side effects) — they take parsed data and return structured results
- **Naming:** camelCase for files/functions/variables, PascalCase for types/classes/enums

## Key File Paths

| Purpose | Path |
|---------|------|
| MCP server entry point | `src/index.ts` |
| Runtime configuration | `src/config.ts` |
| PowerShell executor | `src/powershell/executor.ts` |
| Cmdlet allowlist | `src/powershell/allowlist.ts` |
| TSG diagnostics (types + parsers + evaluators + renderer) | `src/tsg-diagnostics.ts` |
| Ask Learn topic lookup | `src/asklearn.ts` |
| Execution logger | `src/logger.ts` |
| Utility functions | `src/utils.ts` |
| GitHub authentication | `src/github/auth.ts` |
| GitHub issue creation | `src/github/issues.ts` |
| Telemetry (App Insights) | `src/telemetry.ts` |
| DLM diagnostics skill | `.github/skills/dlm-diagnostics/SKILL.md` |
| Skill creator guide | `.github/skills/skill-creator/SKILL.md` |
| CI/CD pipeline | `azure-pipelines.yml` |
| Unit tests | `tests/unit/` |
| E2E tests | `tests/e2e/` |
