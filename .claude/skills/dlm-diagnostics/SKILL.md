---
name: dlm-diagnostics
description: "Diagnose Microsoft Purview Data Lifecycle Management (DLM) issues in Exchange Online. Use this skill when a user reports: retention policy not applying to workloads, retention policy stuck in Error or PendingDeletion, items not moving from primary mailbox to archive, auto-expanding archive not provisioning additional storage, inactive mailbox not created after user deletion, Recoverable Items or SubstrateHolds folder growing uncontrollably, Teams messages not being deleted after retention period expires, MRM and Purview retention conflicting causing unexpected deletion or retention, adaptive scope including wrong members or not populating, or auto-apply retention labels not labeling content or showing Off Error status. Requires Exchange Online and Security & Compliance PowerShell sessions."
---

# DLM Diagnostics

Investigate and resolve Microsoft Purview Data Lifecycle Management issues in Exchange Online. Follow the decision tree below to identify the correct troubleshooting guide, then load the matching reference file for step-by-step diagnostic instructions.

## Prerequisites

Before running any diagnostic commands, ensure both PowerShell sessions are connected:

```powershell
Connect-ExchangeOnline -UserPrincipalName '<admin@contoso.com>' -ShowBanner:$false
Connect-IPPSSession -UserPrincipalName '<admin@contoso.com>' -ShowBanner:$false
```

## Safety Rules

**Only execute read-only commands.** Allowed cmdlet verbs: `Get-*`, `Test-*`, `Export-*`.

**Never execute mutating commands** — `Set-*`, `New-*`, `Remove-*`, `Enable-*`, `Start-*`, `Invoke-*` cmdlets must only be returned as text recommendations for the admin to review and run manually.

**Never offer to automatically apply remediation steps** — the MCP server enforces a read-only allowlist. All resolution steps that involve mutating cmdlets must be presented as manual guidance only. Do not ask the user if they want you to run them.

## Decision Tree

Identify the reported symptom and load the matching reference:

| Symptom | Reference |
|---------|-----------|
| Policy shows Success but content is not retained or deleted on target workloads | [retention-policy-not-applying.md](references/retention-policy-not-applying.md) |
| Policy status shows Error, PolicySyncTimeout, or PendingDeletion | [policy-stuck-error.md](references/policy-stuck-error.md) |
| Archive mailbox exists but items stay in the primary mailbox | [items-not-moving-to-archive.md](references/items-not-moving-to-archive.md) |
| Archive is near 100 GB but no auxiliary archive is being created | [auto-expanding-archive.md](references/auto-expanding-archive.md) |
| User was deleted but mailbox was purged instead of becoming inactive | [inactive-mailbox.md](references/inactive-mailbox.md) |
| Recoverable Items folder growing uncontrollably or SubstrateHolds is large | [substrateholds-quota.md](references/substrateholds-quota.md) |
| Teams retention policy exists but messages remain visible past retention period | [teams-messages-not-deleting.md](references/teams-messages-not-deleting.md) |
| Both MRM and Purview retention on a mailbox causing unexpected behavior | [mrm-purview-conflict.md](references/mrm-purview-conflict.md) |
| Adaptive scope includes wrong members, shows no members, or scope query not targeting correct users/sites | [adaptive-scope.md](references/adaptive-scope.md) |
| Auto-apply retention label policy not labeling content, stuck in simulation, or shows "Off (Error)" | [auto-apply-labels.md](references/auto-apply-labels.md) |
| SharePoint site cannot be deleted because a retention policy or hold is blocking it | [sharepoint-site-deletion-blocked.md](references/sharepoint-site-deletion-blocked.md) |

If the issue does not match a specific symptom above, or for ad-hoc investigations, see [diagnostic-commands.md](references/diagnostic-commands.md) for a quick-reference of common diagnostic commands. For adaptive scope validation commands, see [adaptive-scope.md](references/adaptive-scope.md).

## Workflow

1. **Identify the symptom** from the user's description using the decision tree above.
2. **Load the matching reference file** — read it fully before starting the investigation.
3. **Execute diagnostic commands** step by step using the `run_powershell` MCP tool, following the reference guide's sequence.
4. **Interpret results** at each step — the reference guide explains what to look for and how each finding maps to a root cause.
5. **Cross-reference** — some guides link to sibling references (e.g., policy distribution failures link to [policy-stuck-error.md](references/policy-stuck-error.md)). Load those when directed.
6. **Report findings** — summarize the root cause, present the root-cause confirmation table, and provide the recommended remediation actions as **manual-only guidance** for the admin to review and run outside of this tool.
7. **Review the execution log** — use the `get_execution_log` MCP tool to include a full audit trail of all commands run during the investigation.

## Output Format

Present findings to the user in this structure:

```
## Investigation Summary

**Symptom:** <what was reported>
**Mailbox/Policy:** <target>

## Diagnostic Steps

✅/❌ Step N — <step name>
   Finding: <what was found>
   Command: <command that was run>

## Root Cause

<identified root cause from the reference guide's root-cause table>

## Recommended Actions

> ⚠️ **Manual action required.** The commands below contain mutating operations that
> cannot be executed through this MCP server. Copy and run them manually in your
> own PowerShell session after reviewing each one.

- <remediation command 1>
- <remediation command 2>
```
