# Microsoft Purview DLM Diagnostics MCP

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=purview-dlm-mcp&inputs=%5B%7B%22id%22%3A%22upn%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22Your+Exchange+Online+UPN%2C+e.g.+admin%40tenant.onmicrosoft.com%22%7D%2C%7B%22id%22%3A%22organization%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22Your+Exchange+Online+organization%2C+e.g.+tenant.onmicrosoft.com%22%7D%5D&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40microsoft%2Fpurview-dlm-mcp%22%5D%2C%22env%22%3A%7B%22DLM_UPN%22%3A%22%24%7Binput%3Aupn%7D%22%2C%22DLM_ORGANIZATION%22%3A%22%24%7Binput%3Aorganization%7D%22%7D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=purview-dlm-mcp&inputs=%5B%7B%22id%22%3A%22upn%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22Your+Exchange+Online+UPN%2C+e.g.+admin%40tenant.onmicrosoft.com%22%7D%2C%7B%22id%22%3A%22organization%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22Your+Exchange+Online+organization%2C+e.g.+tenant.onmicrosoft.com%22%7D%5D&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40microsoft%2Fpurview-dlm-mcp%22%5D%2C%22env%22%3A%7B%22DLM_UPN%22%3A%22%24%7Binput%3Aupn%7D%22%2C%22DLM_ORGANIZATION%22%3A%22%24%7Binput%3Aorganization%7D%22%7D%7D&quality=insiders)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE.txt)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for diagnosing Microsoft Purview Data Lifecycle Management issues via Exchange Online PowerShell.

## Features

- **5 MCP tools** — `run_powershell` for executing read-only Exchange Online commands, `get_execution_log` for retrieving a full audit trail, `ask_learn` for Microsoft Learn documentation lookup, `create_issue` for reporting issues with the MCP server to GitHub, and `submit_feedback` for collecting structured diagnostic session feedback
- **11 TSG reference guides** — step-by-step diagnostic workflows aligned to common DLM symptoms
- **72 diagnostic checks** — automated evaluation engine that parses PowerShell output and produces structured findings with remediation
- **Cmdlet allowlist** — only pre-approved read-only cmdlets can be executed; mutating commands are blocked

## Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [PowerShell 7](https://github.com/PowerShell/PowerShell)
- [ExchangeOnlineManagement](https://www.powershellgallery.com/packages/ExchangeOnlineManagement) PowerShell module (v3.4+)
- An admin account with the required permissions (see [Required Permissions](#required-permissions) below)

## Required Permissions

The authenticating user (`DLM_UPN`) needs read access to **both** Exchange Online and Security & Compliance PowerShell sessions.

### Recommended Role Combinations

| Option | Roles | Notes |
|--------|-------|-------|
| **Least-privilege** | **Global Reader** + **Compliance Administrator** | Recommended — covers both EXO and S&C read access |
| **Single role group** | **Organization Management** | Covers both workloads but broader than necessary |
| **Full admin** | **Global Administrator** | Works but overly broad — not recommended |

### Why Both Workloads?

The server connects to two PowerShell sessions:

- **Exchange Online** (`Connect-ExchangeOnline`) — cmdlets like `Get-Mailbox`, `Get-MailboxStatistics`, `Export-MailboxDiagnosticLogs`, `Get-OrganizationConfig`
- **Security & Compliance** (`Connect-IPPSSession`) — cmdlets like `Get-RetentionCompliancePolicy`, `Get-RetentionComplianceRule`, `Get-AdaptiveScope`, `Get-ComplianceTag`

Exchange cmdlets require EXO roles; compliance cmdlets require S&C roles. Without both, some diagnostics will fail with permission errors.

### Authentication

The server uses **MSAL interactive browser sign-in** — a browser window opens for the user to authenticate. No credentials are stored or passed via environment variables.

### Licensing Requirements

Some diagnostics require specific licensing on target mailboxes:

| Feature | Required License |
|---------|-----------------|
| Archive diagnostics | Exchange Online Archiving or E3/E5 |
| Adaptive scopes | E5 Compliance or E5 Information Protection & Governance |
| Teams retention | Microsoft 365 E3+ |

## Quick Start

```bash
npx -y @microsoft/purview-dlm-mcp
```

Set `DLM_UPN` and `DLM_ORGANIZATION` in your MCP client config (see below).

## MCP Client Configuration

### Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dlm-diagnostics": {
      "command": "npx",
      "args": ["-y", "@microsoft/purview-dlm-mcp"],
      "env": {
        "DLM_UPN": "admin@yourtenant.onmicrosoft.com",
        "DLM_ORGANIZATION": "yourtenant.onmicrosoft.com",
        "DLM_COMMAND_TIMEOUT_MS": "180000"
      }
    }
  }
}
```

### VS Code

Add this to your `.vscode/settings.json` or user settings:

```json
{
  "mcp": {
    "servers": {
      "dlm-diagnostics": {
        "command": "npx",
        "args": ["-y", "@microsoft/purview-dlm-mcp"],
        "env": {
          "DLM_UPN": "admin@yourtenant.onmicrosoft.com",
          "DLM_ORGANIZATION": "yourtenant.onmicrosoft.com",
          "DLM_COMMAND_TIMEOUT_MS": "180000"
        }
      }
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `run_powershell` | Execute a read-only Exchange Online PowerShell command against the allowlist |
| `get_execution_log` | Retrieve the log of all commands executed during the current session |
| `ask_learn` | Look up Microsoft Purview documentation on Microsoft Learn (fallback when no TSG matches) |
| `create_issue` | Report an issue with the MCP server to GitHub, attaching session diagnostic context |
| `submit_feedback` | Submit structured feedback about a diagnostic session (emits telemetry, no PII) |

### Tool Examples

#### `run_powershell`

> **User:** "Archiving is not working on john.doe@contoso.com"

The AI uses `run_powershell` to investigate step by step:

```
✅ Step 1 — Check mailbox archive status
   Command: Get-Mailbox -Identity john.doe@contoso.com | FL ArchiveStatus, ArchiveState, RetentionPolicy
   Finding: ArchiveStatus = Active, ArchiveState = Local

✅ Step 2 — Check archive mailbox size
   Command: Get-MailboxStatistics -Identity john.doe@contoso.com -Archive | FL DisplayName, TotalItemSize, ItemCount
   Finding: TotalItemSize = 98.5 GB (4,231 items)

⚠️ Step 3 — Check auto-expanding archive
   Command: Get-Mailbox -Identity john.doe@contoso.com | FL AutoExpandingArchiveEnabled
   Finding: AutoExpandingArchiveEnabled = False — archive is near 100 GB limit

Root Cause: Archive is near quota and auto-expanding archive is not enabled.
Recommended Action: Enable auto-expanding archive at the org level.
```

#### `get_execution_log`

> **User:** "Show me all the commands that were run during this investigation"

Returns a Markdown-formatted audit trail:

```
## Execution Log (3 entries)

| # | Time | Command | Duration | Status |
|---|------|---------|----------|--------|
| 1 | 14:23:01 | Get-Mailbox -Identity john.doe@contoso.com | 2.1s | ✅ |
| 2 | 14:23:04 | Get-MailboxStatistics -Identity john.doe@contoso.com -Archive | 1.8s | ✅ |
| 3 | 14:23:06 | Get-Mailbox -Identity john.doe@contoso.com \| FL AutoExpandingArchiveEnabled | 1.5s | ✅ |
```

#### `ask_learn`

> **User:** "How do I create a retention policy in Purview?"

The AI uses `ask_learn` to find relevant documentation:

```
## Retention Policies

Create and configure retention policies to automatically retain or delete content.

### Key Steps
1. Go to Microsoft Purview compliance portal → Data lifecycle management → Retention policies
2. Select "New retention policy" and configure locations (Exchange, SharePoint, OneDrive, Teams, etc.)
3. Choose whether to retain content, delete it, or both
4. Set the retention period and what triggers it (creation date or last modified date)

### Learn More
- [Create and configure retention policies](https://learn.microsoft.com/purview/create-retention-policies)
- [Retention policies for Exchange Online](https://learn.microsoft.com/purview/retention-policies-exchange)
```

#### `create_issue`

> **User:** "The allowlist is rejecting Get-ComplianceTag even though it should be allowed — file a bug"

The AI uses `create_issue` to report the bug to the MCP server's GitHub repo:

```
✅ Created GitHub issue #42
   Title: Allowlist incorrectly blocks Get-ComplianceTag cmdlet
   Category: bug
   Labels: bug
   URL: https://github.com/microsoft/purview-dlm-mcp/issues/42

   Session context included: 3 commands executed, 1 failure
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DLM_UPN` | Yes | Admin UPN for Exchange Online (e.g., `admin@contoso.onmicrosoft.com`) |
| `DLM_ORGANIZATION` | Yes | Tenant organization (e.g., `contoso.onmicrosoft.com`) |
| `DLM_COMMAND_TIMEOUT_MS` | No | Command execution timeout in ms (default: `180000`) |
| `DLM_COLLECT_TELEMETRY` | No | Set to `false` to disable all telemetry (default: `true`) |
| `DLM_COLLECT_TELEMETRY_MICROSOFT` | No | Set to `false` to disable Microsoft 1P telemetry (default: `true`) |

## Supported TSGs

| Symptom | Reference Guide |
|---------|----------------|
| Policy shows Success but content is not retained/deleted on target workloads | [`retention-policy-not-applying.md`](.github/skills/dlm-diagnostics/references/retention-policy-not-applying.md) |
| Policy status shows Error, PolicySyncTimeout, or PendingDeletion | [`policy-stuck-error.md`](.github/skills/dlm-diagnostics/references/policy-stuck-error.md) |
| Archive mailbox exists but items stay in the primary mailbox | [`items-not-moving-to-archive.md`](.github/skills/dlm-diagnostics/references/items-not-moving-to-archive.md) |
| Archive is near 100 GB but no auxiliary archive is being created | [`auto-expanding-archive.md`](.github/skills/dlm-diagnostics/references/auto-expanding-archive.md) |
| User was deleted but mailbox was purged instead of becoming inactive | [`inactive-mailbox.md`](.github/skills/dlm-diagnostics/references/inactive-mailbox.md) |
| Recoverable Items folder growing uncontrollably or SubstrateHolds is large | [`substrateholds-quota.md`](.github/skills/dlm-diagnostics/references/substrateholds-quota.md) |
| Teams retention policy exists but messages remain visible past retention period | [`teams-messages-not-deleting.md`](.github/skills/dlm-diagnostics/references/teams-messages-not-deleting.md) |
| Both MRM and Purview retention on a mailbox causing unexpected behavior | [`mrm-purview-conflict.md`](.github/skills/dlm-diagnostics/references/mrm-purview-conflict.md) |
| Adaptive scope includes wrong members or scope query not targeting correct users/sites | [`adaptive-scope.md`](.github/skills/dlm-diagnostics/references/adaptive-scope.md) |
| Auto-apply retention label policy not labeling content or shows "Off (Error)" | [`auto-apply-labels.md`](.github/skills/dlm-diagnostics/references/auto-apply-labels.md) |
| SharePoint site cannot be deleted due to retention policy or hold | [`sharepoint-site-deletion-blocked.md`](.github/skills/dlm-diagnostics/references/sharepoint-site-deletion-blocked.md) |

## Architecture

The server is a TypeScript/Node.js application built with the `@modelcontextprotocol/sdk`. The server runs a persistent PowerShell 7 session that authenticates to Exchange Online using MSAL interactive auth. Commands flow through:

1. **MCP Server** (`src/index.ts`) — entry point, receives tool calls from the MCP client
2. **Configuration** (`src/config.ts`) — exports `COMMAND_TIMEOUT_MS`
3. **PowerShell Executor** (`src/powershell/executor.ts`) — manages the PowerShell child process lifecycle and auth
4. **Cmdlet Allowlist** (`src/powershell/allowlist.ts`) — validates every command against the approved cmdlet list before execution
5. **TSG Diagnostics Engine** (`src/tsg-diagnostics.ts`) — evaluates command output against reference guide checklists
6. **GitHub Integration** (`src/github/auth.ts`, `src/github/issues.ts`) — authenticates via `DLM_GITHUB_TOKEN` or `gh auth token` and creates structured GitHub issues
7. **Telemetry** (`src/telemetry.ts`) — optional Application Insights telemetry for tool invocations, session lifecycle, and errors (1P only, no PII, opt-out via env var)

## Security Model

- **Read-only allowlist** — only `Get-*`, `Test-*`, and `Export-*` cmdlets are permitted; mutating commands are rejected before reaching PowerShell
- **No stored credentials** — authentication uses MSAL interactive flow; no passwords or tokens are persisted
- **Session isolation** — each server instance runs its own PowerShell process with independent session state
- **Telemetry** — 1P Application Insights only, no PII collected, opt-out via `DLM_COLLECT_TELEMETRY=false`

## Skills

Diagnostic skills are self-contained reference guides used by AI assistants. Each skill has a `SKILL.md` and a `references/` directory with per-symptom troubleshooting guides.

| Skill | Description | Location |
|-------|-------------|----------|
| `dlm-diagnostics` | 11 troubleshooting guides for DLM issues | [`.github/skills/dlm-diagnostics/`](.github/skills/dlm-diagnostics/SKILL.md) |
| `asklearn` | Fallback: Microsoft Learn docs for Purview topics | [`.github/skills/asklearn/`](.github/skills/asklearn/SKILL.md) |
| `skill-creator` | Meta-skill for authoring new diagnostic skills | [`.github/skills/skill-creator/`](.github/skills/skill-creator/SKILL.md) |

Skills are mirrored in both `.github/skills/` (GitHub Copilot) and `.claude/skills/` (Claude Code).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing instructions, and pull request guidelines.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.

## License

[MIT](LICENSE.txt)
