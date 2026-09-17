# MRM and Purview Retention Conflict — Unexpected Deletion or Retention

## Symptoms

- **Items unexpectedly deleted:** MRM delete tag is deleting content that a Purview retention policy should be retaining — admin expected Purview to override MRM deletion.
- **Items unexpectedly retained:** Purview hold is preventing MRM cleanup — items remain in the mailbox past the MRM tag's configured retention period.
- **Confusion about precedence:** Admin is unsure which system (MRM vs. Purview) takes priority and how they interact on the same mailbox.
- **Default MRM Policy not assigned to new mailboxes:** New mailboxes are not getting the Default MRM Policy automatically — provisioning scripts or templates may be overriding the default assignment.
- **RPT (Retention Policy Tag) not processing default folders:** An RPT assigned to Inbox, Sent Items, or Deleted Items is not being applied — may be a duplicate RPT or unsupported action type.
- **NeverDelete tag cannot be removed:** Admin attempts to delete the `NeverDelete` retention tag but it keeps reappearing — this is a system tag that is automatically recreated.

---

## Data Collection

Execute all commands below to gather the complete diagnostic dataset. Replace `<UPN>` with the affected user's email address.

### 1.1 All Active Retention Mechanisms on Mailbox

```powershell
Get-Mailbox <UPN> | FL RetentionPolicy, RetentionHoldEnabled, InPlaceHolds, LitigationHoldEnabled, ComplianceTagHoldApplied, DelayHoldApplied, DelayReleaseHoldApplied
```

### 1.2 MRM Tags and Actions

```powershell
$policy = (Get-Mailbox <UPN>).RetentionPolicy
Get-RetentionPolicy $policy | Select -ExpandProperty RetentionPolicyTagLinks
Get-RetentionPolicyTag | Where-Object {$_.RetentionAction -ne "MoveToArchive"} | FL Name, Type, AgeLimitForRetention, RetentionAction, RetentionEnabled
```

### 1.3 Purview Retention Policies Affecting Mailbox

```powershell
Get-RetentionCompliancePolicy | Where-Object {$_.ExchangeLocation -eq "All" -or $_.ExchangeLocation -contains "<UPN>"} | FL Name, Guid
```

```powershell
# For each policy found above:
Get-RetentionComplianceRule -Policy "<PolicyName>" | FL RetentionDuration, RetentionComplianceAction
```

### 1.4 Recoverable Items (Current State)

```powershell
Get-MailboxFolderStatistics <UPN> -FolderScope RecoverableItems | FL Name, ItemsInFolder, FolderSize
```

### 1.5 TracingFAI Errors

```powershell
$tracingFai = Export-MailboxDiagnosticLogs <UPN> -ComponentName TracingFai
$faiData = $tracingFai.MailboxLog | ConvertFrom-Json

$faiData | Where-Object {$_.Fs.Count -ne 0} | ForEach-Object {
    Write-Host "Errors in folder: $($_.P)" -ForegroundColor Red
    $_.Fs | Group-Object -Property F | ForEach-Object {
        switch ($_.Name) {
            1 { "DumpsterQuotaTooSmall" }
            2 { "RecipientCorrupt" }
            3 { "IPMOversizeMessage" }
            4 { "DumpsterOversizeMessage" }
            5 { "TagUnexpectedActionChanged" }
            6 { "TooManyTagsAgeLimitChanged" }
            7 { "TagMultipleContentSettings" }
            8 { "CorruptRecipients" }
            9 { "CorruptComplianceEntry" }
            10 { "ResetComplianceEntry" }
            11 { "FolderItemCountLimit" }
        }
    }
}
```

### 1.6 FAI Tag Consistency (FAI vs. Policy)

```powershell
$config = Test-ArchiveConnectivity <UPN> -IncludeArchiveMRMConfiguration

# Tags stamped on mailbox (FAI)
$policyTags = ([xml]$config.PrimaryMRMConfiguration).UserConfiguration.Info.Data.PolicyTag
$archiveTags = ([xml]$config.PrimaryMRMConfiguration).UserConfiguration.Info.Data.ArchiveTag

# Tags defined in assigned retention policy
$mbx = Get-Mailbox <UPN>
$policyLinks = (Get-RetentionPolicy $mbx.RetentionPolicy).RetentionPolicyTagLinks
$definedTags = Get-RetentionPolicyTag | Where-Object {$_.Identity -in $policyLinks}

$definedTags | Format-Table Name, RetentionAction, AgeLimitForRetention, Type
$policyTags | Format-Table Name, Guid, IsVisible, Type
```

---

## Diagnostic Analysis

### Principles of Retention (Precedence Rules)

| Priority | Principle |
|----------|-----------|
| 1 | **Retention wins over deletion.** If any policy says "retain," the item is kept regardless of delete policies. |
| 2 | **Longest retention period wins.** If multiple retain policies apply, the longest duration governs. |
| 3 | **Explicit inclusion wins over implicit.** A policy targeting a specific user overrides an org-wide policy. |
| 4 | **Shortest deletion period wins.** If only delete policies apply (no retain), the shortest delete period fires first. |

**MRM vs. Purview interaction:** MRM can delete items from user's visible mailbox, but if a Purview hold exists, deleted items are **preserved in Recoverable Items**. MRM deletion from user view ≠ permanent deletion when Purview holds exist.

### Diagnostic Checklist

Analyze the collected data against the following criteria. Flag each as ✅ (healthy) or ❌ (issue found).

| # | Check | Condition for ❌ |
|---|---|---|
| 1 | **MRM delete + no Purview retain** | MRM delete tag active AND no Purview retain policy covering the mailbox — items permanently deleted after RI period |
| 2 | **MRM delete + Purview retain** | Items deleted from user view but preserved in RI — **expected behavior**, not an issue unless user reports missing items |
| 3 | **Old MRM policy post-migration** | MRM policy still assigned after org migrated to Purview |
| 4 | **Multiple conflicting Purview policies** | Multiple policies with different retain/delete durations — precedence rules creating unexpected outcomes |
| 5 | **TracingFAI errors** | Non-zero `Fs` entries (TagUnexpectedActionChanged, CorruptComplianceEntry, RecipientCorrupt, etc.) |
| 6 | **FAI tag mismatch** | FAI tags don't match `RetentionPolicyTagLinks` — stale/corrupt MRM config |

---

## Resolution & Remediation

> **⚠️ Do not offer to execute these steps.** The resolutions below contain mutating commands (`Set-*`, `New-*`, `Remove-*`, etc.) that cannot be run through the MCP server. Present these as recommendations for the admin to review and run manually in their own PowerShell session.

Based on flagged issues from the diagnostic report, apply the corresponding resolution:

| ❌ Check | Root Cause | Resolution |
|---|---|---|
| 1 | MRM deleting without compliance safety net | Apply a Purview retain policy immediately; recover content from RI via Content Search/eDiscovery if within RI retention (14 days default) |
| 2 | Expected behavior — user perceives deletion | Communicate: items are preserved in RI by Purview hold; use eDiscovery to surface if needed |
| 3 | Legacy MRM not cleaned up | Remove MRM policy: `Set-Mailbox <UPN> -RetentionPolicy $null`; or disable specific delete tags: `Set-RetentionPolicyTag "<TagName>" -RetentionEnabled $false` |
| 4 | Conflicting Purview policies | Consolidate policies; apply Principles of Retention to predict outcomes |
| 5 | Corrupted MRM processing state | Suggest customer run: `Remove-MailboxUserConfiguration -Mailbox <UPN> -Identity "Inbox\IPM.Configuration.MRM"` then `Start-ManagedFolderAssistant <UPN>` |
| 6 | Stale FAI configuration | Suggest customer run: `Remove-MailboxUserConfiguration -Mailbox <UPN> -Identity "Inbox\IPM.Configuration.MRM"` then `Start-ManagedFolderAssistant <UPN>` |

**General recommendation:** Migrate fully to Purview retention policies and deprecate MRM delete/retain tags.

---

## Additional Scenarios

### Default MRM Policy Not Assigned to New Mailboxes (#18b)

In Exchange Online, the **Default MRM Policy** is automatically assigned to all new mailboxes. However, if a custom retention policy is assigned at creation time (via provisioning scripts, templates, or MailboxPlan), the default is overridden. Additionally, the Default MRM Policy moves items to archive only if an **archive mailbox is enabled** — if no archive exists, the MoveToArchive action is silently skipped.

**Detection:**
```powershell
Get-Mailbox <UPN> | FL RetentionPolicy, ArchiveStatus
# RetentionPolicy should be "Default MRM Policy" (or a custom MRM policy with archive tags)
# ArchiveStatus should be "Active" for archive tags to function
```

**Resolution:**
1. Assign the Default MRM Policy: `Set-Mailbox <UPN> -RetentionPolicy "Default MRM Policy"`
2. Enable archive if missing: `Enable-Mailbox <UPN> -Archive`
3. Check MailboxPlan if new mailboxes consistently miss the default policy:
   ```powershell
   Get-MailboxPlan | FL DisplayName, RetentionPolicy
   ```

### RPT (Retention Policy Tag) Not Processing Default Folders (#18c)

Retention Policy Tags (RPTs) apply to specific default folders (Inbox, Sent Items, Deleted Items, etc.). Key limitations:

1. **One RPT per default folder:** If multiple RPTs for the same folder type are linked to a retention policy, only the first is applied.
2. **Supported actions only:** RPTs support only `DeleteAndAllowRecovery` or `PermanentlyDelete` — NOT `MoveToArchive`.
3. **Users cannot change RPTs:** Unlike personal tags, users cannot override or change RPTs applied to default folders.

**Detection:**
```powershell
# Check for duplicate RPTs for the same folder type
$policy = (Get-Mailbox <UPN>).RetentionPolicy
Get-RetentionPolicy $policy | Select -ExpandProperty RetentionPolicyTagLinks | ForEach-Object {
    Get-RetentionPolicyTag $_ | Where-Object {$_.Type -ne "All" -and $_.Type -ne "Personal"} | FL Name, Type, RetentionAction, RetentionEnabled
}
```

### NeverDelete System Tag Cannot Be Removed (#18i)

The `NeverDelete` retention tag is a **system tag** created automatically by Exchange Online. It **cannot be permanently removed** from the tenant — if deleted, it will be automatically recreated.

**Resolution:** This is by design. Do not attempt to delete this tag. If you need to restrict user access, use RBAC (Role-Based Access Control) to control which personal tags users can opt-in to.

### Recoverable Items Growing in Hybrid/Hold Scenario (#18g)

In hybrid environments, when a retention hold is configured in Microsoft 365, the hold GUID is written to the `msExchUserHoldPolicies` attribute and synced back to on-premises AD. The on-premises MFA finds the hold attribute but **cannot retrieve the hold details** (they exist only in Exchange Online), so it skips purging items from `DiscoveryHolds`, causing indefinite growth.

**Detection:**
```powershell
Get-MailboxFolderStatistics <UPN> -FolderScope RecoverableItems | FL Name, ItemsInFolder, FolderSize
```

**Resolution:** Follow the steps in [Recoverable Items folder not emptied for mailbox on litigation or retention hold](https://learn.microsoft.com/en-us/troubleshoot/exchange/antispam-and-protection/recoverable-items-folder-full).

---

## Cross-References

- [items-not-moving-to-archive.md](items-not-moving-to-archive.md) — Archive mailbox and MRM archive tag issues
- [substrateholds-quota.md](substrateholds-quota.md) — SubstrateHolds and Recoverable Items quota issues
- [retention-policy-not-applying.md](retention-policy-not-applying.md) — Purview retention policy application issues
