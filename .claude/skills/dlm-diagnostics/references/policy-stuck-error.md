# Retention Policy Stuck in Error / PendingDeletion

## Symptoms

- **Policy shows "Error" or "Off (Error)":** Policy status in the Purview portal displays "Error" and cannot be edited or re-distributed. Auto-apply label policies show "Off (Error)".
- **Policy shows "PolicySyncTimeout":** Policy stuck in pending state with "We're still processing your policy" — sync did not complete within the expected timeframe.
- **Policy shows "PendingDeletion":** Deletion was initiated but backend cleanup is incomplete — policy cannot be removed or re-created with the same name.
- **Specific error strings in policy details pane:** "Settings not found", "Something went wrong", "The location is ambiguous", "The location is out of storage", "The site is locked", "We couldn't find this location", "We can't process your policy", or "You can't apply a hold here".
- **Cannot edit or delete the policy:** Policy is in a stuck state preventing any administrative actions.

---

## Data Collection

Execute all commands below to gather the complete diagnostic dataset. Replace `<PolicyName>` with the affected policy name.

### 1.1 Policy Status & Distribution Detail

```powershell
Get-RetentionCompliancePolicy "<PolicyName>" | FL Name, Guid, Enabled, WhenChanged
Get-RetentionCompliancePolicy "<PolicyName>" -DistributionDetail | FL DistributionStatus, DistributionDetail
```

### 1.1b App Retention Policy Status (if applicable)

```powershell
# Use if the policy is an App Retention Compliance Policy (e.g., Teams, Viva Engage, Copilot)
# -DistributionDetail is required to populate location fields
Get-AppRetentionCompliancePolicy "<PolicyName>" -DistributionDetail | FL Name, Guid, Enabled, Mode, WhenCreated, WhenChanged, ExchangeLocation, ExchangeLocationException, AdaptiveScopeLocation
```

### 1.2 Policy Mode & Type

```powershell
Get-RetentionCompliancePolicy "<PolicyName>" | FL Mode, Type, WhenCreated, WhenChanged
```

### 1.3 Adaptive Scope Check

```powershell
Get-RetentionCompliancePolicy "<PolicyName>" -DistributionDetail | FL AdaptiveScopeLocation
# If AdaptiveScopeLocation is populated:
Get-AdaptiveScope "<ScopeName>" | FL Name, WhenCreated, RawQuery, FilterConditions
```

### 1.4 Workload-Specific Distribution

```powershell
# -DistributionDetail is required to populate location fields
Get-RetentionCompliancePolicy "<PolicyName>" -DistributionDetail | FL ExchangeLocation, ExchangeLocationException, SharePointLocation, SharePointLocationException, OneDriveLocation, OneDriveLocationException, TeamsChannelLocation, TeamsChatLocation
```

### 1.5 Duplicate Object Check

```powershell
Get-Recipient -Filter "EmailAddresses -eq 'smtp:<affectedAddress>'" | FL Name, RecipientType, Guid
```

---

## Diagnostic Analysis

Analyze the collected data against the following criteria. Flag each as ✅ (healthy) or ❌ (issue found).

| # | Check | Condition for ❌ |
|---|---|---|
| 1 | **Distribution status** | `DistributionStatus` = Error or PolicySyncTimeout |
| 2 | **Pending deletion** | `DistributionStatus` = PendingDeletion (deletion initiated but backend cleanup incomplete) |
| 3 | **Distribution detail errors** | `DistributionDetail` contains datacenter/sync error messages |
| 4 | **Duplicate AD/EXO objects** | Multiple recipients with same proxy address found |
| 5 | **Policy age < 48 hrs** | `WhenCreated` < 48 hours ago — policy may still be distributing (normal for large tenants) |
| 6 | **Adaptive scope < 5 days** | Associated adaptive scope `WhenCreated` < 5 days ago — scope may not be fully populated, causing distribution to target 0 locations |
| 7 | **Multiple failed retries** | `WhenChanged` shows multiple recent retry attempts without status change — indicates persistent backend failure |
| 8 | **Auto-apply simulation error** | `Type` = ApplyTag AND `Mode` = Simulate AND `DistributionStatus` = Error — simulation failed to start. May be caused by adaptive scope exceeding 20,000 simulation locations |

---

## Resolution & Remediation

> **⚠️ Do not offer to execute these steps.** The resolutions below contain mutating commands (`Set-*`, `New-*`, `Remove-*`, etc.) that cannot be run through the MCP server. Present these as recommendations for the admin to review and run manually in their own PowerShell session.

Based on flagged issues from the diagnostic analysis, apply the corresponding resolution:

| ❌ Check | Root Cause | Resolution |
|---|---|---|
| 1 | Transient backend distribution failure | Retry: `Set-RetentionCompliancePolicy "<PolicyName>" -RetryDistribution` — wait 24–48 hrs, re-check status |
| 2 | Backend cleanup incomplete | Force-delete: `Remove-RetentionCompliancePolicy "<PolicyName>" -ForceDeletion` — verify removal afterward |
| 3 | Datacenter/sync errors | Retry distribution first; if still failing after 48 hrs → **escalate** (requires backend binding cleanup) |
| 4 | AD conflict blocking distribution | Remove duplicate object, resync directory, then retry distribution |
| 5 | Policy still distributing | Wait up to 48 hours for initial distribution to complete before retrying |
| 6 | Adaptive scope not yet populated | Wait at least 5 days for adaptive scope to populate, then retry distribution → see [adaptive-scope.md](adaptive-scope.md) |
| 7 | Persistent backend failure | **Escalate** — multiple retry attempts have failed, indicating a backend binding issue requiring engineering cleanup |
| 8 | Auto-apply simulation failure | Reduce adaptive scope membership below 20,000 locations, or switch to Enable mode. See [auto-apply-labels.md](auto-apply-labels.md) |

---

## Escalation Decision Tree

```
Retry distribution
│
├── Success after 24–48 hrs → Resolved
│
├── Still in Error after 48 hrs
│   ├── Duplicate AD objects found → Remove duplicates, retry
│   └── No duplicates → Escalate (backend binding cleanup)
│
├── PendingDeletion
│   ├── Force-delete succeeds → Resolved
│   └── Force-delete fails → Escalate (orphaned policy bindings)
│
└── Adaptive scope related
    ├── Scope < 5 days old → Wait for population
    └── Scope populated but still failing → Escalate
```

**If both retry and force-delete fail → escalate** (orphaned policy bindings require engineering cleanup).

---

## Distribution Error Code Reference

The following table maps specific error strings visible in the Purview portal or PowerShell `DistributionDetail` to their root cause and remediation:

| Error String (Portal) | Error Code (PowerShell) | Root Cause | Remediation |
|---|---|---|---|
| "Settings not found" | — | Policy has no retention rules configured. Created via PowerShell without adding a rule, or rule was inadvertently removed. | Add a retention rule: `New-RetentionComplianceRule -Name "<rule>" -Policy "<policy>" -RetentionDuration Unlimited` |
| "Something went wrong" | `PolicyNotifyError` | Unspecified error in the notification pipeline of the policy sync/distribution process. Transient. | Retry: `Set-RetentionCompliancePolicy "<policy>" -RetryDistribution` |
| "The location is ambiguous" | `MultipleInactiveRecipientsError` | Multiple recipients with the same proxy address found (e.g., duplicate mailboxes including inactive ones). | Remove duplicate location from policy, then retry distribution |
| "The location is out of storage" | `SiteOutOfQuota` | SharePoint/OneDrive site does not have enough storage for the Preservation Hold Library to function. | Increase site storage quota, delete unnecessary items, then retry distribution |
| "The site is locked" | `SiteInReadOnlyOrNotAccessible` | Admin locked the site (`NoAccess` or `ReadOnly`), or system temporarily locked it during an automated process (e.g., site move). | Unlock site: `Set-SPOSite "<SiteURL>" -LockState Unlock`, then retry distribution |
| "We couldn't find this location" | `FailedToOpenContainer` | Location (mailbox, site, or group) no longer exists — deleted after policy was created. | Remove non-existent location from policy: `Set-RetentionCompliancePolicy "<policy>" -RemoveSharePointLocation "<url>"` |
| "We can't process your policy" | `ActiveDirectorySyncError` | Policy did not sync with Microsoft Entra ID. Commonly a transient synchronization issue. | Retry: `Set-RetentionCompliancePolicy "<policy>" -RetryDistribution` |
| "We're still processing your policy" | `PolicySyncTimeout` | Policy sync did not finish within expected timeframe. Common in large tenants or during service incidents. | Retry: `Set-RetentionCompliancePolicy "<policy>" -RetryDistribution` |
| "You can't apply a hold here" | `RecipientTypeNotAllowed` | Unsupported mailbox type added to policy (e.g., `RoomMailbox`, `DiscoveryMailbox`). | Remove the unsupported mailbox from the policy locations and retry |

---

## Cross-References

- [adaptive-scope.md](adaptive-scope.md) — Adaptive scope population and query issues
- [auto-apply-labels.md](auto-apply-labels.md) — Auto-apply label "Off (Error)" status
- [retention-policy-not-applying.md](retention-policy-not-applying.md) — Policy not applying to workloads
