# Inactive Mailbox Not Created After User Deletion

## Symptoms

- **Mailbox permanently deleted instead of becoming inactive:** A user was deleted from Entra ID, but the mailbox was permanently purged after 30 days instead of converting to an inactive mailbox — no hold was applied before deletion.
- **Soft-deleted mailbox approaching 30-day window:** Mailbox is in soft-deleted state and the 30-day recovery window is expiring — urgent action needed to apply a hold before permanent deletion.
- **Cannot recover inactive mailbox with auto-expanding archive:** Recovery or restore operation fails because the inactive mailbox has auto-expanding archive enabled —  `New-MailboxRestoreRequest` is not supported.
- **Cannot delete inactive mailbox — multiple holds:** Admin wants to permanently delete an inactive mailbox but multiple holds (retention policies, Litigation Hold, eDiscovery) prevent removal.
- **Inactive mailbox has same SMTP as active mailbox:** Two mailboxes share the same primary SMTP address (active user + inactive mailbox), causing ambiguity in PowerShell commands and policy operations.
- **UPN/SMTP changed before deletion:** Admin changed the UPN or primary SMTP address before deleting the user, making the inactive mailbox unmanageable via the original policy reference.

---

## Data Collection

Execute all commands below to gather the complete diagnostic dataset. Replace `<UPN>` with the affected user's email address.

### 1.1 Check Inactive Mailbox Status

```powershell
Get-Mailbox -InactiveMailboxOnly -Identity <UPN> -ErrorAction SilentlyContinue | FL UserPrincipalName, IsInactiveMailbox, WasInactiveMailbox, InPlaceHolds, LitigationHoldEnabled, DelayHoldApplied, DelayReleaseHoldApplied, InactiveMailboxRetireTime, ComplianceTagHoldApplied
```

### 1.2 Check Soft-Deleted Mailbox Status

```powershell
Get-Mailbox -SoftDeletedMailbox -Identity <UPN> -ErrorAction SilentlyContinue | FL UserPrincipalName, IsInactiveMailbox, WasInactiveMailbox, IsSoftDeletedByRemove, IsSoftDeletedByDisable, WhenSoftDeleted, InPlaceHolds, LitigationHoldEnabled, DelayHoldApplied, DelayReleaseHoldApplied, InactiveMailboxRetireTime, ComplianceTagHoldApplied
```

### 1.3 Soft-Deleted Mailbox Recovery Window

```powershell
Get-Mailbox -SoftDeletedMailbox | Where-Object {$_.UserPrincipalName -eq "<UPN>"} | FL UserPrincipalName, WhenSoftDeleted, IsSoftDeletedByRemove, IsSoftDeletedByDisable, ExchangeGuid, ArchiveGuid
```

### 1.4 Retention Policies Covering Exchange

```powershell
# -DistributionDetail is required to populate location fields
Get-RetentionCompliancePolicy -DistributionDetail | FL Name, ExchangeLocation, ExchangeLocationException, AdaptiveScopeLocation, Enabled, Mode, DistributionStatus
```

### 1.5 App Retention Policies Covering Exchange

```powershell
# -DistributionDetail is required to populate location fields
Get-AppRetentionCompliancePolicy -DistributionDetail | FL Name, ExchangeLocation,ExchangeLocationException, AdaptiveScopeLocation, Enabled, Mode
```

### 1.6 Organization-Level In-Place Holds

```powershell
Get-OrganizationConfig | FL InPlaceHolds
```

---

## Diagnostic Analysis

Analyze the collected data against the following criteria. Flag each as ✅ (healthy) or ❌ (issue found).

| # | Check | Condition for ❌ |
|---|---|---|
| 1 | **Inactive mailbox exists** | No results from `Get-Mailbox -InactiveMailboxOnly` |
| 2 | **Soft-deleted mailbox exists** | No results from `Get-Mailbox -SoftDeletedMailbox` (permanently purged) |
| 3 | **Soft-delete within 30-day window** | `WhenSoftDeleted` > 30 days ago (recovery window expired) |
| 4 | **Hold/retention at time of deletion** | No `InPlaceHolds`, `LitigationHoldEnabled` = False on soft-deleted mailbox |
| 5 | **Retention policy coverage** | No retention policy with `ExchangeLocation` covering the user, or policy `Enabled` = False / `Mode` = PendingDeletion |
| 6 | **App retention policy coverage** | No app retention policy with `ExchangeLocation` covering the user, or policy `Enabled` = False / `Mode` = PendingDeletion |
| 7 | **Org-level In-Place Holds** | `InPlaceHolds` from `Get-OrganizationConfig` is empty — no org-wide hold applied |
| 8 | **Delay hold applied** | `DelayHoldApplied` or `DelayReleaseHoldApplied` = True — hold removal is pending; mailbox is temporarily retained for 30 days while the hold is being released |
| 9 | **Soft-delete reason** | `IsSoftDeletedByRemove` = True (user deleted from Entra ID) vs. `IsSoftDeletedByDisable` = True (mailbox disabled) — identifies the deletion method |
| 10 | **Inactive mailbox retire time** | `InactiveMailboxRetireTime` is populated — the inactive mailbox is scheduled for permanent deletion after all holds are removed |

---

## Resolution & Remediation

> **⚠️ Do not offer to execute these steps.** The resolutions below contain mutating commands (`Set-*`, `New-*`, `Remove-*`, etc.) that cannot be run through the MCP server. Present these as recommendations for the admin to review and run manually in their own PowerShell session.

Based on flagged issues from the diagnostic report, apply the corresponding resolution:

| ❌ Check | Root Cause | Resolution |
|---|---|---|
| 1 (but 2 ✅) | Mailbox soft-deleted, not yet inactive — hold was missing | **Within 30 days:** Restore user in Entra ID → apply hold → re-delete. Or: `Set-Mailbox <UPN> -LitigationHoldEnabled $true -InactiveMailbox` |
| 1 and 2 | Mailbox permanently purged (past 30-day window) | **Data loss — no recovery possible** |
| 4 | No hold/retention policy on mailbox at deletion time | Root cause confirmed — mailbox deleted without compliance hold |
| 5 | Policy existed but was disabled or pending deletion | Policy was not effectively applied at time of deletion |

**Recovery Procedures (within 30-day window):**

1. **Restore user in Entra ID** → apply hold → re-delete user (mailbox becomes inactive)
2. **Restore mailbox content:** `New-MailboxRestoreRequest -SourceMailbox <ExchangeGuid> -TargetMailbox <TargetUPN> -AllowLegacyDNMismatch`
3. **Undo soft-delete (if applicable):** `Undo-SoftDeletedMailbox -SoftDeletedObject <ExchangeGuid>` (requires reconnecting with a new user account)

---

## Prevention Checklist

1. Ensure **all mailboxes** are covered by an org-wide retention policy with "retain" action **before** user deletion
2. Verify policy distribution: `Get-RetentionCompliancePolicy "<name>" -DistributionDetail | FL DistributionStatus, DistributionDetail`
3. Check hold stamp on mailbox before user deletion: `Get-Mailbox <UPN> | FL InPlaceHolds, LitigationHoldEnabled`

---

## Additional Scenarios

### Recovery with Auto-Expanding Archive (#17b)

Inactive mailboxes configured with auto-expanding archive **cannot** be recovered or restored using `New-Mailbox -InactiveMailbox` or `New-MailboxRestoreRequest`. This is a known platform limitation.

**Detection:**
```powershell
Get-Mailbox -InactiveMailboxOnly -Identity <UPN> | FL AutoExpandingArchiveEnabled
```

**Resolution:** If `AutoExpandingArchiveEnabled` is True, the only supported recovery method is **Content Search** (eDiscovery) to export data from the inactive mailbox. Use the Purview portal → eDiscovery → Content Search to create a search targeting the inactive mailbox, then export the results.

### Multiple Holds Blocking Deletion (#17d)

An inactive mailbox can have multiple holds applied simultaneously: org-wide retention policies, specific-inclusion policies, retention labels, eDiscovery holds, Litigation Hold, and legacy In-Place Holds. **All** holds must be removed before the mailbox transitions to soft-deleted and is permanently deleted after 30 days.

**Detection:**
```powershell
Get-Mailbox -InactiveMailboxOnly -Identity <UPN> | FL Name, ExchangeGuid, LitigationHoldEnabled, InPlaceHolds, ComplianceTagHoldApplied
```

**Resolution steps:**
1. Remove Litigation Hold: `Set-Mailbox -InactiveMailbox -Identity <UPN> -LitigationHoldEnabled $false`
2. Exclude from org-wide holds: `Set-Mailbox <UPN> -ExcludeFromAllOrgHolds`
3. Remove from specific-inclusion policies: `Set-RetentionCompliancePolicy "<PolicyGUID>" -RemoveExchangeLocation <UPN>`
4. Remove legacy In-Place Holds: `Invoke-HoldRemovalAction -Action RemoveHold -ExchangeLocation <UPN> -HoldId <holdID>`
5. Force recalculation: `Set-Mailbox -Identity <UPN> -RecalculateInactiveMailbox`

**Note:** If a retention policy uses **Preservation Lock**, the inactive mailbox **cannot** be removed from that policy — contact Microsoft Support.

### Same SMTP Address as Active Mailbox (#17e)

When a new user is created with the same email address as a former employee whose mailbox was made inactive, both mailboxes share the SMTP address. This causes ambiguity in `Get-Mailbox`, policy targeting, and administrative operations.

**Resolution:** Use `DistinguishedName` or `ExchangeGuid` to uniquely identify the inactive mailbox:
```powershell
Get-Mailbox -InactiveMailboxOnly -ResultSize Unlimited | Select DisplayName, PrimarySmtpAddress, DistinguishedName, ExchangeGuid
Get-Mailbox -InactiveMailboxOnly -Identity <ExchangeGuid>
```

### UPN/SMTP Change Before Deletion (#17f)

If a UPN or primary SMTP address is changed **before** the user account is deleted, the inactive mailbox cannot be removed from the retention policy because the identity no longer matches what the policy recorded.

**Resolution:** This is a **preventive** scenario — do NOT change UPN/SMTP before making a mailbox inactive. If already in this state, contact Microsoft Support for backend operations.
Consider Litigation Hold as a safety net for high-value mailboxes: `Set-Mailbox <UPN> -LitigationHoldEnabled $true`
