# Items Stuck in SubstrateHolds / Recoverable Items Quota Exceeded

## Symptoms

- **Recoverable Items folder growing uncontrollably:** RI folder size steadily increasing despite no user action — retained content (Teams, Copilot, Viva Engage) accumulating in SubstrateHolds.
- **Items stuck in SubstrateHolds:** Items remain in the hidden `SubstrateHolds` folder beyond the configured retention period + 7-day cleanup window — competing holds preventing purge.
- **User unable to send/receive email:** Mailbox quota exceeded due to RI folder consuming the mailbox's total storage allocation.
- **"Mailbox is full" or quota warning:** User receives quota warnings even though their visible mailbox has free space — RI folder is consuming quota behind the scenes.
- **MFA not processing mailbox:** Managed Folder Assistant cannot run because the RI quota is exhausted — retention tags not being applied to visible folders.

---

## Background: Recoverable Items Architecture

The Recoverable Items (RI) folder contains hidden subfolders that store retained and deleted content:

| Subfolder | Purpose | Default Quota |
|---|---|---|
| **Deletions** | Items deleted by user (soft-delete) | Part of RI quota |
| **Purges** | Items purged from Deletions (hard-delete) | Part of RI quota |
| **DiscoveryHolds** | Items retained by eDiscovery holds | Part of RI quota |
| **SubstrateHolds** | Teams messages, Copilot interactions, Viva Engage content retained by Purview | Part of RI quota |
| **Versions** | Original copies of modified items (copy-on-write for holds) | Part of RI quota |

**Default quotas:** RI quota = 30 GB (E3/E5), 100 GB (with holds), 105GB (holds with auto-expanding). Warning at 20 GB / 90 GB respectively.

---

## Data Collection

Execute all commands below to gather the complete diagnostic dataset. Replace `<UPN>` with the affected user's email address.

### 1.1 Recoverable Items Folder Statistics

```powershell
Get-MailboxFolderStatistics <UPN> -FolderScope RecoverableItems | FL Name, FolderSize, ItemsInFolder, FolderPath
```

### 1.2 All Holds on Mailbox

```powershell
Get-Mailbox <UPN> | FL InPlaceHolds, LitigationHoldEnabled, LitigationHoldDuration, LitigationHoldDate, LitigationHoldOwner, ComplianceTagHoldApplied, DelayHoldApplied, DelayReleaseHoldApplied, RetentionHoldEnabled, StartDateForRetentionHold, EndDateForRetentionHold
```

### 1.3 Org-Level Holds

```powershell
(Get-OrganizationConfig).InPlaceHolds
```

### 1.4 Retention Policies Targeting Mailbox

```powershell
Get-RetentionCompliancePolicy | Where-Object {$_.ExchangeLocation -eq "All" -or $_.ExchangeLocation -contains "<UPN>"} | FL Name, RetentionDuration
```

### 1.5 Dumpster Expiration Status

```powershell
$logs = Export-MailboxDiagnosticLogs <UPN> -ExtendedProperties
$xmlprops = [xml]($logs.MailboxLog)
$xmlprops.Properties.MailboxTable.Property | Where-Object {$_.Name -eq "DumpsterExpirationLastSuccessRunTimestamp"} | Select-Object -ExpandProperty Value
```

```powershell
(Export-MailboxDiagnosticLogs <UPN> -ComponentName DumpsterExpiration).MailboxLog
```

### 1.6 Archive Dumpster Expiration (If Archive Exists)

```powershell
$archiveGuid = (Get-Mailbox <UPN>).ArchiveGuid
$archiveLogs = Export-MailboxDiagnosticLogs $archiveGuid -ExtendedProperties
$archiveXml = [xml]($archiveLogs.MailboxLog)
$archiveXml.Properties.MailboxTable.Property | Where-Object {$_.Name -eq "DumpsterExpirationLastSuccessRunTimestamp"} | Select-Object -ExpandProperty Value
```

### 1.7 Primary & Archive Quota Utilization

```powershell
$mbx = Get-Mailbox <UPN>
$stats = Get-MailboxStatistics <UPN>

Write-Host "Primary — TotalItemSize: $($stats.TotalItemSize) / ProhibitSendReceiveQuota: $($mbx.ProhibitSendReceiveQuota)"
Write-Host "Primary — TotalDeletedItemSize: $($stats.TotalDeletedItemSize) / RecoverableItemsQuota: $($mbx.RecoverableItemsQuota)"
```

### 1.8 Mailbox Holds & Configuration

```powershell
# ELC disabled or not at organization level
Get-OrganizationConfig | FL ElcProcessingDisabled
```

### 1.9 Teams Message Folders statistics

```powershell
# /TeamsMessagesData — contains active Teams chat messages stored in the primary mailbox
# /Recoverable Items/SubstrateHolds — contains deleted Teams chat messages retained by hold settings
Get-MailboxFolderStatistics <UPN> -FolderScope NonIPMRoot | Where-Object {
    $_.FolderPath -match "TeamsMessagesData|SubstrateHolds"
} | Format-Table FolderPath, FolderSize, ItemsInFolder
```

### 1.10 Recoverable Items Breakdown (Primary Mailbox)

```powershell
Get-MailboxFolderStatistics <UPN> -FolderScope RecoverableItems | Format-Table FolderPath, FolderSize, ItemsInFolder
```

---

## Diagnostic Analysis

Analyze the collected data against the following criteria. Flag each as ✅ (healthy) or ❌ (issue found).

**Hold GUID prefixes:** `mbx` = Purview retention (Exchange), `-mbx` = Purview retention exclusion (Exchange), `cld` = Purview retention (modern group), `UniH` = eDiscovery case hold, `skp` = SharePoint/OneDrive retention.

**Note:** `RetentionHoldEnabled` suspends expiration at **IPM level only** (visible folders — both deletions and archival). It has **no impact** on Dumpster/Recoverable Items expiration.

| # | Check | Condition for ❌ |
|---|---|---|
| 1 | **Dominant RI folder** | `SubstrateHolds` is largest → Teams/Copilot/Viva content retained. `DiscoveryHolds`/`Purges` largest → eDiscovery or Purview hold content |
| 2 | **Litigation hold** | `LitigationHoldEnabled` = True → ALL items retained indefinitely in RI |
| 3 | **Delay hold** | `DelayHoldApplied` = True → 30-day delay from recently removed hold |
| 4 | **Delay release hold** | `DelayReleaseHoldApplied` = True → additional delay hold variant active |
| 5 | **Org-level holds** | `InPlaceHolds` from `Get-OrganizationConfig` contains entries |
| 6 | **Multiple overlapping holds** | Multiple holds with different retention periods — longest wins; all must expire before cleanup |
| 7 | **SubstrateHolds retention expired** | Items in SubstrateHolds beyond retention period + 7 days (TBA cleanup runs every 3–7 days) |
| 8 | **Dumpster expiration** | `DumpsterExpirationLastSuccessRunTimestamp` not found or > 7 days old |
| 9 | **RI quota** | `TotalDeletedItemSize` within 5 GB of `RecoverableItemsQuota` |
| 10 | **Primary quota** | `TotalItemSize` within 5 GB of `ProhibitSendReceiveQuota` |
| 11 | **ComplianceTagHoldApplied** | `ComplianceTagHoldApplied` = True — a retention label with "retain" action is preserving items in Recoverable Items, preventing cleanup even after policy removal |

---

## Resolution & Remediation

> **⚠️ Do not offer to execute these steps.** The resolutions below contain mutating commands (`Set-*`, `New-*`, `Remove-*`, etc.) that cannot be run through the MCP server. Present these as recommendations for the admin to review and run manually in their own PowerShell session.

Based on flagged issues from the diagnostic report, apply the corresponding resolution:

| ❌ Check | Root Cause | Resolution |
|---|---|---|
| 1 (SubstrateHolds, within retention) | Items retained per policy — by design | No action needed |
| 2 | Litigation hold retaining all RI content | Remove if no longer needed; if needed, quota increase is the only relief |
| 3 | Delay hold from recently removed policy | Wait 30 days for auto-expiry, or: `Set-Mailbox <UPN> -RemoveDelayHoldApplied` |
| 4 | Additional delay hold variant | Wait for auto-expiry or **escalate** if persisting |
| 5 | Org-wide holds retaining RI content | Review org-level holds; remove if no longer required |
| 6 | Multiple overlapping holds | All holds must expire before cleanup — remove unnecessary holds |
| 7 | TBA cleanup stuck | **Escalate** — Timer-Based Assistant not processing SubstrateHolds |
| 8 | Dumpster expiration not running | Review DumpsterExpiration logs; **escalate** if stuck > 7 days |
| 9 | RI quota nearly exhausted | Temporary relief: `Set-Mailbox <UPN> -RecoverableItemsQuota 100GB -RecoverableItemsWarningQuota 90GB` — address underlying hold/retention config |
| 10 | Primary mailbox quota exhausted | Address RI bloat first (above); primary quota relief is secondary |
