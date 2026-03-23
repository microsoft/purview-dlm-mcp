# Auto-Expanding Archive Not Provisioning

## Symptoms

- **Archive at or near 100 GB quota:** Archive mailbox has reached or is approaching the 100 GB threshold, but no auxiliary archive has been provisioned.
- **User receiving quota warnings:** Outlook or OWA displays "Your archive mailbox is almost full" or similar quota warning messages.
- **"Archive mailbox full" error:** User cannot move items to archive — archive quota has been reached and auto-expanding has not triggered.
- **Outlook quota bar showing archive full:** Outlook's mailbox usage bar shows the archive mailbox at maximum capacity.
- **Auto-expanding enabled but no auxiliary archives:** `AutoExpandingArchiveEnabled` is True at org or user level, but `MailboxLocations` shows no `AuxArchive` entries.

---

## Data Collection

Execute all commands below to gather the complete diagnostic dataset. Replace `<UPN>` with the affected user's email address.

### 1.1 Organization & Mailbox Configuration

```powershell
Get-OrganizationConfig | FL AutoExpandingArchiveEnabled
```

```powershell
Get-Mailbox <UPN> | FL DisplayName, AutoExpandingArchiveEnabled, ArchiveStatus, ArchiveState, ArchiveGuid, ArchiveQuota, ArchiveWarningQuota, RecoverableItemsQuota, ProhibitSendReceiveQuota, LitigationHoldEnabled, RetentionPolicy
```

### 1.2 Archive Size & Statistics

```powershell
Get-MailboxStatistics <UPN> -Archive | FL TotalItemSize, TotalDeletedItemSize
```

### 1.3 Mailbox Locations (Auxiliary Archives)

```powershell
Get-Mailbox <UPN> | Select -ExpandProperty MailboxLocations
```

### 1.4 Aggregated Archive Size (All Locations)

```powershell
$mbx = Get-Mailbox <UPN>; $totalGB = 0
foreach ($loc in $mbx.MailboxLocations) {
    $parts = $loc.Split(";"); $guid = $parts[1]; $type = $parts[2]
    if ($type -cin "MainArchive","AuxArchive") {
        $ms = Get-MailboxStatistics $guid
        $iGB = [math]::Round(([long]((($ms.TotalItemSize.Value -split "\(")[1] -split " ")[0] -replace ",",""))/[math]::Pow(1024,3),3)
        $dGB = [math]::Round(([long]((($ms.TotalDeletedItemSize.Value -split "\(")[1] -split " ")[0] -replace ",",""))/[math]::Pow(1024,3),3)
        $totalGB += ($iGB + $dGB); Write-Host "[$type] $guid — Items: ${iGB}GB, Deleted: ${dGB}GB"
    }
}
Write-Host "Aggregated: ${totalGB} GB"
```

### 1.5 Total Archive Size

```powershell
$stats = Get-MailboxStatistics <UPN> -Archive
$itemGB = [math]::Round(([long]((($stats.TotalItemSize.Value -split "\(")[1] -split " ")[0] -replace ",","")) / [math]::Pow(1024,3), 3)
$deletedGB = [math]::Round(([long]((($stats.TotalDeletedItemSize.Value -split "\(")[1] -split " ")[0] -replace ",","")) / [math]::Pow(1024,3), 3)
$totalArchiveGB = [math]::Round($itemGB + $deletedGB, 3)
Write-Host "TotalItemSize: ${itemGB} GB"
Write-Host "TotalDeletedItemSize: ${deletedGB} GB"
Write-Host "Total Archive Size: ${totalArchiveGB} GB"
```

### 1.5a Archive Expansion Limit (If Total Archive > 1.5 TB)

> **Only run this if step 1.4 or 1.5 shows total archive size exceeding 1.5 TB (1536 GB).**

```powershell
$archiveGuid = (Get-Mailbox <UPN>).ArchiveGuid
$logs = Export-MailboxDiagnosticLogs $archiveGuid -ExtendedProperties
$xmlprops = [xml]($logs.MailboxLog)
$xmlprops.Properties.MailboxTable.Property | Where-Object {$_.Name -eq "ELCMaxAggregateArchiveSize"} | Select-Object Name, Value
```

> **Interpretation:**
> - If `ELCMaxAggregateArchiveSize` = **1.5 TB** → the archive has reached its maximum expansion limit and **will not expand further**. Implement retention delete policies to manage growth.
> - If `ELCMaxAggregateArchiveSize` = **3 TB** → the tenant has an elevated limit. The archive can continue expanding up to 3 TB — no issue.

### 1.6 ELC Last Success & MRM Logs

```powershell
$archiveGuid = (Get-Mailbox <UPN>).ArchiveGuid
$logs = Export-MailboxDiagnosticLogs $archiveGuid -ExtendedProperties
$xmlprops = [xml]($logs.MailboxLog)
$xmlprops.Properties.MailboxTable.Property | Where-Object {$_.Name -eq "ELCLastSuccessTimestamp"} | Select-Object -ExpandProperty Value
```

```powershell
(Export-MailboxDiagnosticLogs $archiveGuid -ComponentName MRM).MailboxLog
```

### 1.7 Archive Connectivity

```powershell
Test-ArchiveConnectivity <UPN> -IncludeArchiveMRMConfiguration | Select-Object -ExpandProperty Result
```

### 1.8 Ghosted Folders

```powershell
$archiveGuid = (Get-Mailbox <UPN>).ArchiveGuid
$ghosted = Get-MailboxFolderStatistics $archiveGuid | Where-Object {
    $_.LastMovedTimeStamp -ne $null -and $_.ItemsInFolder -ne 0 -and $_.ContentMailboxGuid -ne $archiveGuid
}
$ghosted | FT FolderPath, FolderSize, ItemsInFolder, LastMovedTimeStamp, ContentMailboxGuid
```

### 1.9 Active Move Requests

```powershell
Get-MoveRequest <UPN> -ErrorAction SilentlyContinue | FL Status, PercentComplete
```

---

## Diagnostic Analysis

Analyze the collected data against the following criteria. Flag each as ✅ (healthy) or ❌ (issue found).

| # | Check | Condition for ❌ |
|---|---|---|
| 1 | **Auto-expanding enabled** | Both org-level and user-level `AutoExpandingArchiveEnabled` = False |
| 2 | **Archive size ≥ 90 GB** | Total archive size < 90 GB (expansion threshold not reached) |
| 3 | **Auxiliary archives exist** | No `AuxArchive` entries in MailboxLocations |
| 4 | **Litigation hold quota** | `LitigationHoldEnabled` = True AND `ArchiveQuota` = 100 GB (should be 110 GB) |
| 5 | **Growth rate** | Mailbox ingesting > 1 GB/day (journaling, transport rules, auto-forwarding) |
| 6 | **ELC last run** | `ELCLastSuccessTimestamp` > 5 days ago or absent |
| 7 | **MRM errors** | MRM diagnostic logs contain errors |
| 8 | **Archive connectivity** | `Test-ArchiveConnectivity` result does not contain "Successfully" |
| 9 | **Aggregated size vs expansion limit** | Total across MainArchive + AuxArchive > 1.4 TB (warn) or exceeds `ELCMaxAggregateArchiveSize` (hard limit). If `ELCMaxAggregateArchiveSize` = 1.5 TB and total ≥ 1.5 TB → ❌ archive **will not expand further**. If `ELCMaxAggregateArchiveSize` = 3 TB and total < 3 TB → ✅ no issue |
| 10 | **Per-location quota** | Any individual archive location within 5 GB of its quota |
| 11 | **Quota consistency** | `ArchiveQuota` + `RecoverableItemsQuota` > 240 GB (unusual) |
| 12 | **Ghosted folders** | Ghosted folders with `LastMovedTimeStamp` > 30 days old |
| 13 | **Folder corruption** | Inbox or SentItems `FolderType` exists under archive IPM root |
| 14 | **Active MRS request** | Active move/migration request present on the mailbox |
| 15 | **Aux archive count** | 50 or more `AuxArchive` entries in MailboxLocations |

---

## Resolution & Remediation

> **⚠️ Do not offer to execute these steps.** The resolutions below contain mutating commands (`Set-*`, `New-*`, `Remove-*`, etc.) that cannot be run through the MCP server. Present these as recommendations for the admin to review and run manually in their own PowerShell session.

Based on flagged issues from the diagnostic report, apply the corresponding resolution:

| ❌ Check | Root Cause | Resolution |
|---|---|---|
| 1 | Feature not enabled | Enable: `Set-OrganizationConfig -AutoExpandingArchive` (org) or `Enable-Mailbox <UPN> -AutoExpandingArchive` (user) |
| 2 | Below expansion threshold | No action required — expansion triggers at ≥ 90 GB by design |
| 3 | MFA has not evaluated archive | Trigger manually: `Start-ManagedFolderAssistant <MainArchiveGUID>` — wait 24–48 hrs, re-check |
| 4 | Quota not bumped for LitHold | Re-enable: `Enable-Mailbox <UPN> -AutoExpandingArchive` (bumps ArchiveQuota to 110 GB) |
| 5 | Unsupported ingestion rate | Reduce inbound volume to ≤ 1 GB/day; review journaling/transport rules |
| 6 | MFA not processing archive | Trigger manually: `Start-ManagedFolderAssistant $archiveGuid` |
| 7 | MRM processing errors | Review MRM logs for specific error codes; address per error guidance |
| 8 | Archive connectivity broken | **Escalate** — content cannot be moved or expanded |
| 9 | Approaching or at 1.5 TB limit | > 1.4 TB: plan archive swap or retention delete policies. > 1.5 TB: **no further expansion possible** |
| 10 | Per-location quota full | New aux archive needed — trigger MFA to initiate; provisioning takes up to 30 days |
| 11 | Unusual quota configuration | Review and correct quota values; **escalate** if unexpected |
| 12 | Ghosted content flush stuck | Run: `Start-ManagedFolderAssistant $archiveGuid -GhostedFolderCleanup` |
| 13 | Archive folder structure corrupt | **Escalate** for default folder repair |
| 14 | Mailbox locked by migration | Wait for active MRS request to complete before re-evaluating |
| 15 | Max aux archive limit reached | **No further expansion possible** — implement retention delete policies to manage growth |
