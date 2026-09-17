# Items Not Moving from Primary Mailbox to Archive

## Symptoms

- **Items not moving to archive:** User's primary mailbox is full or near quota, but items are not moving to the archive mailbox despite MRM archive policies being in place.
- **Archive not yet enabled:** Admin expects items to auto-archive, but the archive mailbox has never been enabled for the user — `ArchiveStatus` = None.
- **Archive requires license:** User does not have the required license (E3/E5 or Exchange Online Archiving add-on) to enable or use the archive mailbox.
- **Archive disabled — content at risk:** Admin disabled the archive mailbox and needs to re-enable it. If more than 30 days have passed since disabling, original archive content is permanently lost.
- **MFA not processing the mailbox:** Managed Folder Assistant has not run on the mailbox — `ELCLastSuccessTimestamp` is absent or stale (> 5 days).

---

## Data Collection

Execute all commands below to gather the complete diagnostic dataset. Replace `<UPN>` with the affected user's email address.

### 1.1 Mailbox & Archive Configuration

```powershell
Get-Mailbox <UPN> | FL DisplayName, ArchiveStatus, ArchiveGuid, ArchiveName, ArchiveState, RetentionPolicy, RetentionHoldEnabled, ElcProcessingDisabled, StartDateForRetentionHold, EndDateForRetentionHold, IsShared, AccountDisabled, InPlaceHolds, LitigationHoldEnabled, ComplianceTagHoldApplied, MaxSendSize, MaxReceiveSize, AutoExpandingArchiveEnabled, ArchiveQuota, ArchiveWarningQuota, RecoverableItemsQuota
```

### 1.2 Retention Policy Tags

```powershell
$policy = (Get-Mailbox <UPN>).RetentionPolicy
Get-RetentionPolicy $policy | Select -ExpandProperty RetentionPolicyTagLinks
Get-RetentionPolicyTag -Mailbox <UPN> | FL Name, Type, RetentionAction, AgeLimitForRetention, RetentionEnabled, MessageClass
```

### 1.3 License Validation

```powershell
$plan = Get-MailboxPlan (Get-Mailbox <UPN>).MailboxPlan
$plan.PersistedCapabilities
```

### 1.4 Org-Level ELC Processing

```powershell
Get-OrganizationConfig | FL ElcProcessingDisabled
```

### 1.5 ELC Last Success & MRM Logs (Primary + Archive)

```powershell
$mbx = Get-Mailbox <UPN>
$primaryGuid = $mbx.ExchangeGuid
$archiveGuid = $mbx.ArchiveGuid

# ELC on primary
$logs = Export-MailboxDiagnosticLogs <UPN> -ExtendedProperties
$xmlprops = [xml]($logs.MailboxLog)
$xmlprops.Properties.MailboxTable.Property | Where-Object {$_.Name -eq "ELCLastSuccessTimestamp"} | Select-Object -ExpandProperty Value

# ELC on archive
$archiveLogs = Export-MailboxDiagnosticLogs $archiveGuid -ExtendedProperties
$archiveXml = [xml]($archiveLogs.MailboxLog)
$archiveXml.Properties.MailboxTable.Property | Where-Object {$_.Name -eq "ELCLastSuccessTimestamp"} | Select-Object -ExpandProperty Value

# MRM error logs
(Export-MailboxDiagnosticLogs <UPN> -ComponentName MRM).MailboxLog
```

### 1.6 Archive Connectivity & MRM Configuration (FAI)

```powershell
Test-ArchiveConnectivity <UPN> -IncludeArchiveMRMConfiguration | Select-Object -ExpandProperty Result
```

### 1.7 TracingFAI Errors

```powershell
$tracingFai = Export-MailboxDiagnosticLogs <UPN> -ComponentName TracingFai
$tracingFai.MailboxLog | ConvertFrom-Json
```

### 1.8 FAI Tag Consistency

```powershell
$config = Test-ArchiveConnectivity <UPN> -IncludeArchiveMRMConfiguration
([xml]$config.PrimaryMRMConfiguration).UserConfiguration.Info.Data | FL PolicyTag, ArchiveTag

Write-Host "`nPolicy Tags:" -ForegroundColor Cyan
([xml]$config.PrimaryMRMConfiguration).UserConfiguration.Info.Data.PolicyTag | Format-Table Name, ObjectGuid, Guid, IsVisible, OptedInto, Type, IsRemovedFromPolicy, @{ Label = "Expiry Age"; Expression = { ([xml]$_.InnerXml).ChildNodes.ExpiryAgeLimit } }

Write-Host "`nArchive Tags:" -ForegroundColor Cyan
([xml]$config.PrimaryMRMConfiguration).UserConfiguration.Info.Data.ArchiveTag | Format-Table Name, ObjectGuid, Guid, IsVisible, OptedInto, Type, IsRemovedFromPolicy, @{ Label = "Expiry Age"; Expression = { ([xml]$_.InnerXml).ChildNodes.ExpiryAgeLimit } }

Write-Host "`nDefault Archive Tags:" -ForegroundColor Cyan
([xml]$config.PrimaryMRMConfiguration).UserConfiguration.Info.Data.DefaultArchiveTag | Format-Table Name, ObjectGuid, Guid, IsVisible, OptedInto, Type, IsRemovedFromPolicy, @{ Label = "Expiry Age"; Expression = { ([xml]$_.InnerXml).ChildNodes.ExpiryAgeLimit } }
```

### 1.9 Active Move Requests

```powershell
Get-MoveRequest <UPN> -ErrorAction SilentlyContinue | FL Status, PercentComplete
```

### 1.10 Oversized Items Check

```powershell
Get-MailboxFolderStatistics <UPN> | Where-Object {$_.FolderSize -gt "150 MB"} | FL FolderPath, FolderSize, ItemsInFolder
```

### 1.11 Mailbox Size

```powershell
Get-MailboxStatistics <UPN> | FL DisplayName, TotalItemSize, ItemCount
```

### 1.12 Archive Shard Provisioning Dates

```powershell
Get-MailboxLocation -User <UPN> | Where-Object {$_.MailboxLocationType -Match "MainArchive|AuxArchive"} | ForEach-Object {Get-MailboxFolderStatistics $($_.MailboxGuid) -Folderscope All | Where-Object {$_.FolderType -eq "Root"} | Select-Object ContentMailboxGuid, CreationTime} | Format-Table -Wrap -AutoSize
```

### 1.13 EWS Protocol Status

```powershell
Get-CasMailbox <UPN> | FL EwsEnabled, EwsAllowOutlook, EwsApplicationAccessPolicy, EwsAllowList, EwsBlockList
```

### 1.14 IsCloudCache / Shadow Mailbox

```powershell
Get-User <UPN> | FL IsCloudCache, CloudCacheAccountType
```

### 1.15 Folder Item Limits

```powershell
# Check for folders approaching 1,000,000 items (user data) or 3,000,000 (dumpster)
Get-MailboxFolderStatistics <UPN> | Where-Object { $_.ItemsInFolder -ge 900000 } | Format-Table FolderPath, FolderType, ItemsInFolder, FolderSize

# Check dumpster/Recoverable Items folders
Get-MailboxFolderStatistics <UPN> -FolderScope RecoverableItems | Format-Table FolderPath, FolderType, ItemsInFolder, FolderSize
```

### 1.16 Archive Quota & Shard Quota

```powershell
# Archive quota settings
Get-Mailbox <UPN> | FL ArchiveQuota, ArchiveWarningQuota, RecoverableItemsQuota, RecoverableItemsWarningQuota

# Current archive size
Get-MailboxStatistics <UPN> -Archive | FL TotalItemSize, TotalDeletedItemSize, ItemCount

# Check per-shard quota usage (for auto-expanded archives)
Get-MailboxLocation -User <UPN> | Where-Object { $_.MailboxLocationType -in @("MainArchive","AuxArchive") } | ForEach-Object {
    Get-MailboxStatistics -Identity $_.MailboxGuid.ToString() | Select-Object DisplayName, TotalItemSize, ItemCount
}

# Check ContentMailboxGuid per folder in archive to identify which shard owns each folder
$archiveGuid = (Get-Mailbox <UPN>).ArchiveGuid
Get-MailboxFolderStatistics $archiveGuid -Archive | Format-Table FolderPath, FolderType, ItemsInFolder, FolderSize, ContentMailboxGuid
```

### 1.17 Folder-Level Tag Overrides

```powershell
# Check folder-level tags — look for tags NOT in the assigned retention policy
Get-MailboxFolderStatistics <UPN> | Format-Table FolderPath, DeletePolicy, ArchivePolicy
```

### 1.18 Oldest Item Dates (Age Verification)

```powershell
# Check folder statistics with oldest/newest item dates
Get-MailboxFolderStatistics <UPN> -IncludeOldestAndNewestItems | Format-Table FolderPath, FolderType, ItemsInFolder, ArchivePolicy, DeletePolicy, OldestItemReceivedDate, NewestItemReceivedDate, OldestItemLastModifiedDate

# Check RetainDeletedItemsFor value
Get-Mailbox <UPN> | FL RetainDeletedItemsFor

# Check Recoverable Items folder statistics
Get-MailboxFolderStatistics <UPN> -FolderScope RecoverableItems -IncludeOldestAndNewestItems | Format-Table FolderPath, ItemsInFolder, FolderSize, OldestItemLastModifiedDate
```

### 1.19 PendingRescan / NeedsRescan Flags

```powershell
# Check for folders needing rescan — indicates FullCrawl is in progress or needed
Get-MailboxFolderStatistics <UPN> | Format-List *
# Look for "PendingRescan" (FullCrawl in progress) or "NeedsRescan" (FullCrawl needed)
```

---

## Diagnostic Analysis

Analyze the collected data against the following criteria. Flag each as ✅ (healthy) or ❌ (issue found).

| # | Check | Condition for ❌ |
|---|---|---|
| 1 | **Archive enabled** | `ArchiveStatus` = None |
| 2 | **MoveToArchive tag in policy** | No `RetentionPolicy` assigned, or policy has no tag with `RetentionAction` = MoveToArchive |
| 3 | **Retention hold** | `RetentionHoldEnabled` = True (MRM paused) |
| 4 | **ELC processing (mailbox)** | `ElcProcessingDisabled` = True |
| 5 | **ELC processing (org)** | Org-level `ElcProcessingDisabled` = True |
| 6 | **License** | `PersistedCapabilities` lacks `BPOS_S_Enterprise` (E3/E5) or `BPOS_S_Archive`/`BPOS_S_ArchiveAddOn` |
| 7 | **ELC last run (primary)** | `ELCLastSuccessTimestamp` > 5 days ago or absent |
| 8 | **ELC last run (archive)** | `ELCLastSuccessTimestamp` > 5 days ago or absent |
| 9 | **MRM errors** | MRM diagnostic logs contain errors (e.g., `MapiExceptionInvalidRecipients`) |
| 10 | **Account status** | `AccountDisabled` = True AND `IsShared` = False |
| 11 | **Archive connectivity** | `Test-ArchiveConnectivity` result does not contain "Successfully" |
| 12 | **TracingFAI errors** | Non-zero `Fs` entries (DumpsterQuotaTooSmall, RecipientCorrupt, CorruptComplianceEntry, etc.) |
| 13 | **FAI tag consistency** | FAI tags don't match `RetentionPolicyTagLinks` (stale/corrupt MRM config) |
| 14 | **Active MRS request** | Active move request with status ≠ Completed |
| 15 | **Oversized items** | Items larger than `MaxSendSize`/`MaxReceiveSize` present (MRM cannot auto-archive these) |
| 16 | **Mailbox size** | `TotalItemSize` < 10 MB — MRM does not process very small mailboxes |
| 17 | **Archive recently provisioned** | Archive shard Root folder `CreationTime` < 7 days ago — MFA has a 7-day SLA to run |
| 18 | **EWS enabled** | `EwsEnabled` = False — archiving requires EWS protocol |
| 19 | **IsCloudCache (shadow mailbox)** | `IsCloudCache` = True — ELC does not process shadow mailboxes by design |
| 20 | **Folder item limit** | Any user data folder has ≥ 1,000,000 items or dumpster folder has ≥ 3,000,000 items |
| 21 | **Archive/shard quota** | Archive quota reached, or specific `ContentMailboxGUID` shard quota exhausted (blocks archiving for folders owned by that shard even if other shards have space) |
| 22 | **Personal tag not in policy** | Folder has `ArchivePolicy` or `DeletePolicy` tag that does not appear in `RetentionPolicyTagLinks` |
| 23 | **PendingRescan / NeedsRescan** | `NeedsRescan` present without `PendingRescan` — FullCrawl must be triggered |
| 24 | **RetentionEnabled = False on tags** | A tag in the assigned policy has `RetentionEnabled` = False — the tag is effectively disabled |

---

## Resolution & Remediation

> **⚠️ Do not offer to execute these steps.** The resolutions below contain mutating commands (`Set-*`, `New-*`, `Remove-*`, etc.) that cannot be run through the MCP server. Present these as recommendations for the admin to review and run manually in their own PowerShell session.

Based on flagged issues from the diagnostic report, apply the corresponding resolution:

| ❌ Check | Root Cause | Resolution |
|---|---|---|
| 1 | Archive not enabled | `Enable-Mailbox <UPN> -Archive` |
| 2 | Missing archive tag | Assign policy: `Set-Mailbox <UPN> -RetentionPolicy "Default MRM Policy"` or add a MoveToArchive DPT to existing policy |
| 3 | MRM paused by retention hold | `Set-Mailbox <UPN> -RetentionHoldEnabled $false` |
| 4 | MFA disabled on mailbox | `Set-Mailbox <UPN> -ElcProcessingDisabled $false` |
| 5 | MFA disabled org-wide | `Set-OrganizationConfig -ElcProcessingDisabled $false` |
| 6 | Missing required license | Assign E3/E5 or Exchange Online Archiving add-on license |
| 7–8 | MFA not processing mailbox | Trigger manually: `Start-ManagedFolderAssistant <UPN>` — wait 24–48 hrs |
| 9 | MRM processing errors | Review MRM logs for specific error codes; address per error guidance |
| 10 | Disabled account blocking MRM | Re-enable the account or investigate disabled state |
| 11 | Archive connectivity broken | **Escalate** — content cannot be moved |
| 12 | Corrupted MRM configuration | Suggest customer run: `Remove-MailboxUserConfiguration -Mailbox <UPN> -Identity "Inbox\IPM.Configuration.MRM"` then `Start-ManagedFolderAssistant <UPN>` |
| 13 | Stale FAI tags | Suggest customer run: `Remove-MailboxUserConfiguration -Mailbox <UPN> -Identity "Inbox\IPM.Configuration.MRM"` then `Start-ManagedFolderAssistant <UPN>` |
| 14 | Mailbox locked by migration | Wait for active MRS request to complete |
| 15 | Oversized items | Advise user to manually move or split items exceeding `MaxSendSize`/`MaxReceiveSize` |
| 16 | Mailbox too small (< 10 MB) | MRM does not process mailboxes smaller than 10 MB — wait for mailbox to grow or investigate |
| 17 | Archive recently provisioned | MFA has a 7-day SLA — wait for initial processing or trigger manually: `Start-ManagedFolderAssistant <UPN>` |
| 18 | EWS disabled | Enable EWS: `Set-CasMailbox <UPN> -EwsEnabled $true` |
| 19 | Shadow mailbox (IsCloudCache) | ELC does not process shadow mailboxes by design. **Escalate** to Exchange Store team via DfM Collaborations to clear cloud cache properties |
| 20 | Folder item limit reached | Reduce items in affected folder below 1,000,000 (user data) or 3,000,000 (dumpster) |
| 21 | Archive/shard quota exhausted | If auto-expanding is enabled, wait for new shard provisioning. If 50-shard or 1.5 TB limit reached, manual cleanup is required. Check per-shard quota via `ContentMailboxGUID` |
| 22 | Personal tag not in policy | Re-add missing tag to policy: `Set-RetentionPolicy "<PolicyName>" -RetentionPolicyTagLinks @{Add="<TagName>"}`, then trigger `Start-ManagedFolderAssistant <UPN> -FullCrawl` |
| 23 | NeedsRescan without PendingRescan | Trigger FullCrawl: `Start-ManagedFolderAssistant <UPN> -FullCrawl` |
| 24 | RetentionEnabled = False on tag | Enable the tag: `Set-RetentionPolicyTag "<TagName>" -RetentionEnabled $true` |

---

## Additional Scenarios

### Archive Not Yet Enabled (#16a)

This guide assumes the archive mailbox exists. If `ArchiveStatus` = None, the archive must be enabled before MRM archive tags can function.

**Pre-requisites for enabling archive:**
1. User must have an E3/E5 license or Exchange Online Archiving add-on (`BPOS_S_Archive` or `BPOS_S_ArchiveAddOn` in `PersistedCapabilities`).
2. In hybrid environments, the archive must be enabled in the cloud (not on-premises) for Exchange Online mailboxes.

**Enable archive:**
```powershell
Enable-Mailbox <UPN> -Archive
```

**Verify:**
```powershell
Get-Mailbox <UPN> | FL ArchiveStatus, ArchiveGuid
```

### Archive Disabled — Content Loss Risk (#16d)

When an admin disables an archive mailbox, the contents are retained for only **30 days**. After 30 days, the original archive content is **permanently deleted** and cannot be recovered. Re-enabling after 30 days creates a brand-new, empty archive.

**Detection:**
```powershell
# Check if archive was recently disabled
Get-Mailbox <UPN> | FL ArchiveStatus, ArchiveGuid
# ArchiveStatus = None AND ArchiveGuid = 00000000-0000-0000-0000-000000000000 → archive never enabled or disabled
```

**Resolution:**
- **Within 30 days of disabling:** Re-enable the archive immediately to reconnect to original content: `Enable-Mailbox <UPN> -Archive`
- **Beyond 30 days:** Content is permanently lost. No recovery is possible.
- **Preventive:** Communicate to admins never to disable archive mailboxes unless absolutely intended.

### MRM Archive Policies Ignored on Inactive Mailboxes (#17g)

MRM retention tags with the `MoveToArchive` action are **ignored** on inactive mailboxes by design. Items tagged with archive policies remain in the primary mailbox and are retained indefinitely. However, MRM **deletion** policies continue to be processed on inactive mailboxes.

### Root Folder Items Not Processed (#18a)

Items stored directly in the **Top of Information Store** folder (which has `FolderType` = Root) are **not processed by MFA** by design. This folder should not hold items.

**Detection:**
```powershell
Get-MailboxFolderStatistics <UPN> | Where-Object { $_.FolderType -eq "Root" } | Format-Table FolderPath, FolderType, ItemsInFolder, FolderSize
```

**Resolution:** Advise user to move items out of the Root folder into a standard folder (e.g., Inbox) where MRM tags will apply.

### Outbox Items Not Processed (#18b)

Items in the **Outbox** that are marked to be sent are **not processed by MRM**. These are typically stuck messages from mail-generating tools.

**Detection:**
```powershell
Get-MailboxFolderStatistics <UPN> | Where-Object { $_.FolderType -eq "Outbox" } | Format-Table FolderPath, ItemsInFolder, FolderSize
```

**Resolution:** Customer should manually move/delete these items or address them from the tool used to generate and send them.

### NeverDelete System Tag (#18c)

The `NeverDelete` retention tag is a **system tag** that should not be removed. If deleted, it will be automatically recreated as it is required to be present. This is expected behavior.

### MRM Config Rebuild Precautions (#18d)

When suggesting a customer rebuild the MRM configuration using `Remove-MailboxUserConfiguration -Mailbox <UPN> -Identity "Inbox\IPM.Configuration.MRM"`, verify the following preconditions first:

1. **Mailbox size must be > 10 MB** — MRM will not process small mailboxes after rebuild.
2. **A legacy retention policy must be assigned** — otherwise there is nothing to rebuild against.
3. **Note any opt-in (Personal) tags** — these will be lost during rebuild and the end-user will need to manually re-apply them afterward.

**Verification before rebuild:**
```powershell
Get-MailboxStatistics <UPN> | FL TotalItemSize
Get-Mailbox <UPN> | FL RetentionPolicy

# Check for opt-in Personal tags
$config = Test-ArchiveConnectivity <UPN> -IncludeArchiveMRMConfiguration
([xml]$config.PrimaryMRMConfiguration).UserConfiguration.Info.Data.PolicyTag | Format-Table Name, IsVisible, OptedInto, Type, IsRemovedFromPolicy
([xml]$config.PrimaryMRMConfiguration).UserConfiguration.Info.Data.ArchiveTag | Format-Table Name, IsVisible, OptedInto, Type, IsRemovedFromPolicy
```

### Hybrid Scenario — On-Premises Primary with Cloud Archive (#18e)

In hybrid environments (primary mailbox on-premises, archive in Exchange Online), archiving requires working **Federation and/or OAuth** authentication between on-premises Exchange and Exchange Online.

**Manual verification (run from on-premises Exchange Management Shell — not available via MCP):**
```powershell
# Test OAuth connectivity
Test-OAuthConnectivity -Service EWS -TargetUri https://outlook.office365.com/ews/exchange.asmx -Mailbox <OnPremSMTP> -Verbose

# Check federation trust
Get-FederationTrust | FL *
Test-FederationTrust -UserIdentity <OnPremSMTP>

# Check organization relationship
Get-OrganizationRelationship | FL Name, DomainNames, ArchiveAccessEnabled, Enabled
```

**Note:** These commands run from on-premises Exchange and are outside the scope of this MCP server. Document results manually in the escalation.

### Recoverable Items Archiving Behavior (#18f)

Archiving from Recoverable Items folders works **only from Purges, DiscoveryHolds, and Versions** folders based on `ItemLastModifiedDate`. Items in the **Deletions** folder are **not archived directly** — they must first move to Purges or DiscoveryHolds after the duration configured in `RetainDeletedItemsFor`.

**Key rules for retention age calculation:**
- **User data items:** Age is based on `ReceivedDate` (with some exceptions — see [How retention age is calculated](https://learn.microsoft.com/exchange/security-and-compliance/messaging-records-management/retention-age#determining-the-age-of-different-types-of-items)).
- **Recoverable Items:** Age is based on `ItemLastModifiedDate`.
- **Items in Deleted Items folder:** When tagged for the first time, the StartDate may differ from `ReceivedDate`.

### Personal Tag on Folder Not in Policy (#18g)

If a Personal tag is stamped on a folder's `DeletePolicy` or `ArchivePolicy` but that tag is **not present in the assigned retention policy** and is not opt-in, the end-user cannot see it in their email client — yet MRM will still use it. This causes unexpected archiving behavior.

**Resolution flow:**
1. Administrator re-adds the missing tag to the policy: `Set-RetentionPolicy "<PolicyName>" -RetentionPolicyTagLinks @{Add="<TagName>"}`
2. Trigger MFA: `Start-ManagedFolderAssistant <UPN>`
3. After processing, end-user will see the Personal tag on the folder and can remove or change it
4. Trigger MFA with FullCrawl to re-tag items: `Start-ManagedFolderAssistant <UPN> -FullCrawl`

---

## Useful Articles

- [Messaging records management in Exchange Online](https://learn.microsoft.com/exchange/security-and-compliance/messaging-records-management/messaging-records-management)
- [Retention tags and retention policies in Exchange Online](https://learn.microsoft.com/exchange/security-and-compliance/messaging-records-management/retention-tags-and-policies)
- [Default Retention Policy in Exchange Online](https://learn.microsoft.com/exchange/security-and-compliance/messaging-records-management/default-retention-policy)
- [Default folders that support Retention Policy Tags](https://learn.microsoft.com/exchange/security-and-compliance/messaging-records-management/default-folders)
- [Difference between ElcProcessingDisabled and RetentionHoldEnabled](https://learn.microsoft.com/exchange/security-and-compliance/messaging-records-management/mailbox-retention-hold#difference-between-elcprocessingdisabled-and-retentionholdenabled)
- [How retention age is calculated in Exchange Online](https://learn.microsoft.com/exchange/security-and-compliance/messaging-records-management/retention-age#determining-the-age-of-different-types-of-items)
- [Resolve email archive and deletion issues when using retention policies](https://learn.microsoft.com/microsoft-365/troubleshoot/retention/troubleshoot-mrm-email-archive-deletion)
- [Configure OAuth authentication between Exchange and Exchange Online organizations](https://learn.microsoft.com/exchange/configure-oauth-authentication-between-exchange-and-exchange-online-organizations-exchange-2013-help)

---

## Cross-References

- [auto-expanding-archive.md](auto-expanding-archive.md) — Auto-expanding archive provisioning issues
- [mrm-purview-conflict.md](mrm-purview-conflict.md) — MRM and Purview retention conflicts
- [retention-policy-not-applying.md](retention-policy-not-applying.md) — Purview retention policy application issues
