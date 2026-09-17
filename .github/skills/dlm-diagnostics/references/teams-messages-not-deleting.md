# Teams Messages Not Being Deleted After Retention Period

## Symptoms

- **Messages remain visible beyond retention period:** A "delete-only" or "retain then delete" retention policy targets Teams, but messages are still visible to users past the expected expiration.
- **Admin expectation vs. user report:** Admin expects messages to be deleted based on policy configuration, but users report messages are still visible — may be within the normal 16-day async processing window.
- **Channel messages not deleting:** Messages in standard or private channels are not being deleted — different from chat messages, channel messages are stored in the team's group mailbox.
- **Chat messages not deleting:** 1:1 or group chat messages remain visible — stored in user mailboxes, subject to different hold/policy evaluation.
- **Shared channel messages not covered:** Shared channel messages are not being retained or deleted — the parent team may not be included in the `Teams channel messages` retention policy.
- **User-deleted messages still discoverable after 21+ days:** A user deletes a Teams message, but it remains recoverable for 21 days before entering `SubstrateHolds` — this is by design.
- **"When Last Modified" setting appears to be ignored:** Policy configured with "When items were last modified" but retention operates on creation date — known Teams behavior.

---

## Data Collection

Execute all commands below to gather the complete diagnostic dataset. Replace `<PolicyName>` with the policy name and `<UPN>` with the affected user.

### 1.1 Policy Configuration & Status

```powershell
Get-RetentionCompliancePolicy "<PolicyName>" -DistributionDetail | FL TeamsChannelLocation, TeamsChannelLocationException, TeamsChatLocation, TeamsChatLocationException, Enabled, Mode, DistributionStatus
Get-RetentionComplianceRule -Policy "<PolicyName>" | FL RetentionDuration, RetentionComplianceAction

Get-AppRetentionCompliancePolicy "<PolicyName>" -DistributionDetail | FL ExchangeLocation, ExchangeLocationException, Enabled, Mode
Get-AppRetentionComplianceRule -Policy "<PolicyName>" | FL RetentionDuration, RetentionComplianceAction
```

### 1.2 SubstrateHolds Content

```powershell
Get-MailboxFolderStatistics <UPN> -FolderScope RecoverableItems | Where-Object {$_.Name -eq "SubstrateHolds"} | FL FolderSize, ItemsInFolder
```

### 1.3 Holds on User Mailbox

```powershell
Get-Mailbox <UPN> | FL InPlaceHolds, LitigationHoldEnabled, ComplianceTagHoldApplied
```

### 1.4 Private Channel Migration Status

```powershell
# Post-2025 migration: private channel messages move from user mailboxes to group mailboxes
Get-Mailbox -GroupMailbox | Where-Object {$_.DisplayName -like "*<TeamName>*"} | FL DisplayName, ExchangeGuid, WhenCreated
```

### 1.5 Shared/Private Channel Coverage

```powershell
Get-UnifiedGroup -Identity "<TeamName>" | FL InPlaceHolds
Get-Mailbox -GroupMailbox | Where-Object {$_.DisplayName -like "*<TeamName>*"} | FL InPlaceHolds
```

### 1.6 Teams Message Folders statistics

```powershell
# /TeamsMessagesData — contains active Teams chat messages stored in the primary mailbox
# /Recoverable Items/SubstrateHolds — contains deleted Teams chat messages retained by hold settings
Get-MailboxFolderStatistics <UPN> -FolderScope NonIPMRoot | Where-Object {
    $_.FolderPath -match "TeamsMessagesData|SubstrateHolds"
} | Format-Table FolderPath, FolderSize, ItemsInFolder
```

---

## Diagnostic Analysis

### Prerequisites / Licensing

**Prerequisites:** Teams retention policies require Microsoft 365 E3/E5 or equivalent. Teams Channel and Chat locations in retention policies require the user to have a license that includes Teams.

### Expected Deletion Timeline

Teams message deletion follows a multi-step async process:

| Phase | Duration | What Happens |
|-------|----------|-------------|
| Retention period expires | As configured | Timer starts from message creation/modification |
| MFA processes the mailbox | Up to **7 days** | SubstrateHolds copy marked for deletion |
| TBA cleanup runs | Up to **7 days** | Backend removes the substrate copy |
| Teams client cache refresh | Up to **2 days** | Message disappears from Teams UI |
| **Total maximum lag** | **Up to 16 days** | After retention period expiry |

### Diagnostic Checklist

Analyze the collected data against the following criteria. Flag each as ✅ (healthy) or ❌ (issue found).

| # | Check | Condition for ❌ |
|---|---|---|
| 1 | **Policy targets Teams** | Both `TeamsChannelLocation` and `TeamsChatLocation` are empty |
| 2 | **Distribution status** | `DistributionStatus` ≠ Success → switch to [Policy Stuck in Error](policy-stuck-error.md) |
| 3 | **Within 16-day lag** | Message age < retention period + 16 days — still within expected async window |
| 4 | **Litigation hold** | `LitigationHoldEnabled` = True — overrides retention deletion |
| 5 | **Competing longer retain policy** | Another retention policy with longer retain period exists — longest wins |
| 6 | **Compliance tag hold** | `ComplianceTagHoldApplied` = True — retention label with "retain" overrides delete-only policies |
| 7 | **Shared channel coverage** | Retention policy doesn't include the Team's group mailbox — shared channel messages not covered |
| 8 | **Private channel migration conflict** | Post-2025 migration: existing `Teams private channel messages` policies may conflict with `Teams channel messages` policies applied to the same parent team. Both policies enforce but may overlap |

---

## Resolution & Remediation

> **⚠️ Do not offer to execute these steps.** The resolutions below contain mutating commands (`Set-*`, `New-*`, `Remove-*`, etc.) that cannot be run through the MCP server. Present these as recommendations for the admin to review and run manually in their own PowerShell session.

Based on flagged issues from the diagnostic report, apply the corresponding resolution:

| ❌ Check | Root Cause | Resolution |
|---|---|---|
| 1 | Policy doesn't target Teams | Update policy to include `TeamsChannelLocation` and/or `TeamsChatLocation` |
| 2 | Distribution failure | Switch to [Policy Stuck in Error](policy-stuck-error.md) TSG |
| 3 | Normal async processing | Wait up to 16 days past retention expiry — no action needed |
| 4 | Litigation hold overriding deletion | Remove litigation hold if no longer required |
| 5 | Longer competing retention policy | Remove or shorten competing policy; see [Principles of Retention](mrm-purview-conflict.md) |
| 6 | Retention label overriding deletion | Remove or modify the applied compliance tag |
| 7 | Shared/private channels not covered | Include M365 Groups in policy scope to cover shared channel messages |
| 8 | Private channel migration policy conflict | Post-2025: create new `Teams channel messages` policies for parent teams with private channels. Old `Teams private channel messages` policies continue to work but can't be edited post-migration. Remove overlapping policies to prevent confusion |

For detailed SubstrateHolds investigation, see [SubstrateHolds / Recoverable Items Quota](substrateholds-quota.md).

---

## Additional Scenarios

### Shared Channel Messages — Retention Policy Not Applying (#21a)

Shared channels **inherit retention settings from the parent team**. Messages are stored in `SubstrateGroup` mailboxes (not standard `GroupMailbox`). If the parent team is not included in a `Teams channel messages` retention policy, shared channel messages will not be covered.

**Key points:**
- Shared channels cannot be targeted independently — they always follow the parent team.
- For org-wide policies ("All" teams selected), shared channels are automatically included.
- If using specific inclusions, add the **parent team** — not the shared channel itself.

**Detection:**
```powershell
Get-RetentionCompliancePolicy "<PolicyName>" | FL TeamsChannelLocation
# Verify the parent team is listed
```

### User-Deleted Messages — 21-Day Delay (#21c)

When a user deletes a Teams message, the message **disappears from the Teams app** but does NOT go into the `SubstrateHolds` folder for **21 days**. This is by design — the 21-day delay allows for potential message recovery via the Teams client.

**Timeline for user-deleted messages:**
| Phase | Duration |
|-------|----------|
| Message deleted by user — hidden from Teams UI | Immediate |
| Message enters SubstrateHolds | After **21 days** |
| SubstrateHolds retention (minimum) | **1 day** |
| Timer job purge | **1–7 days** |
| **Total: user deletion to permanent deletion** | **Up to 29 days** |

**Note:** This is different from admin-initiated retention deletion (which follows the standard 16-day timeline). eDiscovery can still find user-deleted messages during the 21-day window.

### "When Last Modified" Setting Ignored for Teams (#21d)

Although the Purview portal allows selecting "Start the retention period based on: When items were last modified," the value of **"When items were created"** is always used for Teams messages. This is a **known configuration issue** documented by Microsoft.

For edited messages, a copy of the original is saved with the original timestamp, and the post-edited message gets a newer timestamp.

**Resolution:** This is by design. Inform stakeholders that Teams retention always operates on **creation date**, regardless of the UI selection. Plan retention periods accordingly.

---

## Cross-References

- [substrateholds-quota.md](substrateholds-quota.md) — SubstrateHolds investigation and RI quota
- [adaptive-scope.md](adaptive-scope.md) — Adaptive scope issues affecting Teams policy targeting
- [policy-stuck-error.md](policy-stuck-error.md) — Policy distribution failures
