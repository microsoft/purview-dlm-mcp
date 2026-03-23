# Auto-Apply Retention Labels Not Working

## Symptoms

- **Content not being labeled:** Auto-apply policy is enabled and distributed, but target content does not receive the expected retention label.
- **Content already labeled — auto-apply skips:** Target items already have a retention label applied (manually, via default label, or another auto-apply policy) — auto-apply **never overwrites** existing labels.
- **Stuck in simulation mode:** Policy remains in Simulate mode and is not actively labeling content. Admin may have forgotten to switch to Enable.
- **Policy shows "Off (Error)":** Auto-apply policy status displays "Off (Error)" in the Purview portal — distribution failed.
- **Trainable classifier not labeling old content:** Classifier-based auto-apply policy only evaluates content created within the last 6 months (180 days) — older content is skipped.
- **SIT-based policy not labeling existing Exchange mail:** Sensitive info type auto-apply for Exchange only processes newly sent/received mail — items already stored in mailboxes are not evaluated.
- **Custom SIT not labeling existing SharePoint/OneDrive content:** Custom sensitive info types can only auto-label new or modified content in SP/OD, not already-stored items.

---

## Data Collection

Execute all commands below to gather the complete diagnostic dataset. Replace `<PolicyName>` with the auto-apply policy name.

### 1.1 Policy Status & Type

```powershell
Get-RetentionCompliancePolicy "<PolicyName>" | FL Name, Guid, Enabled, Mode, Type, DistributionStatus, WhenCreated, WhenChanged
```

### 1.2 Distribution Detail

```powershell
Get-RetentionCompliancePolicy "<PolicyName>" -DistributionDetail | FL DistributionDetail
```

### 1.3 Auto-Apply Rule Configuration

```powershell
Get-RetentionComplianceRule -Policy "<PolicyName>" | FL Name, ContentMatchQuery, ContentContainsSensitiveInformation, RetentionComplianceAction, RetentionDuration, PublishComplianceTag, Mode
```

### 1.4 Linked Retention Label

```powershell
Get-ComplianceTag | FL Name, Guid, RetentionDuration, RetentionAction, IsRecordLabel
```

### 1.5 Policy Scope (Workload Locations & Adaptive Scope)

```powershell
Get-RetentionCompliancePolicy "<PolicyName>" -DistributionDetail | FL ExchangeLocation, ExchangeLocationException, SharePointLocation, SharePointLocationException, OneDriveLocation, OneDriveLocationException, AdaptiveScopeLocation
```

### 1.6 Adaptive Scope Validation (If Applicable)

```powershell
# Only if AdaptiveScopeLocation is populated
Get-AdaptiveScope "<ScopeName>" | FL Name, LocationType, RawQuery, FilterConditions, WhenCreated
Get-Recipient -Filter "<same filter from RawQuery or FilterConditions>" -ResultSize 10 | FL Name, RecipientType
```

### 1.7 Count of All Auto-Apply Policies (Limit Check)

```powershell
Get-RetentionCompliancePolicy | Where-Object {$_.Type -eq "ApplyTag"} | Measure-Object
```

### 1.8 Retention Label Details (by linked label name)

```powershell
# Use the label name from PublishComplianceTag (step 1.3) to get its full details
Get-ComplianceTag "<LabelName>" | FL Name, Guid, RetentionDuration, RetentionAction, RetentionType, IsRecordLabel, IsRegulatoryLabel, ContentType, WhenCreated, WhenChanged
```

> **NOTE:** `Get-Label` returns **sensitivity labels**, not retention labels. If results come back from `Get-Label`, those are sensitivity labels and should not be confused with retention labels. Always use `Get-ComplianceTag` for retention label diagnostics.

---

## Diagnostic Analysis

Analyze the collected data against the following criteria. Flag each as ✅ (healthy) or ❌ (issue found).

**Key auto-apply behavior rules:**
- Auto-apply labels **never overwrite** an existing retention label on content.
- Auto-apply policies can take **up to 7 days** to start labeling after creation or enablement.
- Trainable classifiers can only evaluate content created within the **last 6 months** (180 days).

| # | Check | Condition for ❌ |
|---|---|---|
| 1 | **Policy enabled** | `Enabled` = False |
| 2 | **Distribution status / "Off (Error)"** | `DistributionStatus` ≠ Success or portal shows "Off (Error)" → retry distribution, then see [policy-stuck-error.md](policy-stuck-error.md) if still failing |
| 3 | **Simulation mode** | `Mode` = Simulate — policy is not applying labels, only simulating. Switch to Enable when ready |
| 4 | **Matching criteria configured** | `ContentMatchQuery` is empty AND no SIT/classifier configured — no matching criteria set on the rule |
| 5 | **Label linked to rule** | `PublishComplianceTag` is empty — no retention label is linked to the auto-apply rule |
| 6 | **Existing labels blocking** | Target content already has a retention label applied (including default labels) — auto-apply will skip these items |
| 7 | **Trainable classifier + content age** | Policy uses a trainable classifier and target content is older than 6 months — classifier cannot evaluate old content |
| 8 | **Trainable classifier + adaptive scope** | Policy uses a trainable classifier AND an adaptive scope — this combination is **not supported**. Use a static scope instead |
| 9 | **Custom SIT + existing SP/OD content** | Policy uses a custom sensitive info type targeting existing SharePoint/OneDrive content — custom SITs can only auto-label new/modified content, not already-stored items |
| 10 | **Exchange SIT scope** | SIT-based auto-apply for Exchange applies only to sent/received mail — not to items already stored in mailboxes |
| 11 | **Processing time** | Policy created or enabled within the last 7 days — auto-apply is still within normal processing window |
| 12 | **KQL query validity** | `ContentMatchQuery` contains invalid KQL syntax — test the query in Content Search to verify matches |
| 13 | **Policy limit** | Total auto-apply policies exceed tenant limits (10,000 total policies across all types) |
| 14 | **Simulation location limit** | Simulation mode with adaptive scope exceeds 20,000 locations |
| 15 | **Adaptive scope population** | Associated adaptive scope has 0 members or was created < 5 days ago → see [adaptive-scope.md](adaptive-scope.md) |

---

## Resolution & Remediation
> **⚠️ Do not offer to execute these steps.** The resolutions below contain mutating commands (`Set-*`, `New-*`, `Remove-*`, etc.) that cannot be run through the MCP server. Present these as recommendations for the admin to review and run manually in their own PowerShell session.
Based on flagged issues from the diagnostic analysis, apply the corresponding resolution:

| ❌ Check | Root Cause | Resolution |
|---|---|---|
| 1 | Policy disabled | Enable the policy: `Set-RetentionCompliancePolicy "<PolicyName>" -Enabled $true` |
| 2 | Distribution failure / "Off (Error)" | Retry: `Set-RetentionCompliancePolicy "<PolicyName>" -RetryDistribution` — wait 24–48 hrs. If still failing → [policy-stuck-error.md](policy-stuck-error.md) |
| 3 | Policy in simulation mode | Switch to enforce: `Set-RetentionCompliancePolicy "<PolicyName>" -Mode Enable` — review simulation results first |
| 4 | No matching criteria | Add a content match query, SIT, or classifier to the auto-apply rule |
| 5 | No label linked | Link a retention label to the rule via the Purview portal or PowerShell |
| 6 | Content already labeled | Auto-apply never overwrites — remove existing labels first (manually or via script) if auto-apply should take priority |
| 7 | Classifier cannot evaluate old content | Trainable classifiers only work on content < 6 months old. For older content, use KQL keyword queries or SITs instead |
| 8 | Trainable classifier + adaptive scope | Remove the adaptive scope and use a static scope instead — see [adaptive-scope.md](adaptive-scope.md) |
| 9 | Custom SIT limitation for existing content | Custom SITs only auto-label new or modified content in SP/OD. Modify existing items to trigger re-evaluation, or use a built-in SIT |
| 10 | SIT limited to new Exchange mail | SIT-based auto-apply for Exchange only processes sent/received mail. Use Content Search to label existing items |
| 11 | Normal processing delay | Wait up to 7 days for auto-apply to begin processing. Re-check after 7 days |
| 12 | Invalid KQL query | Fix KQL syntax — test the query in Purview Content Search before applying. Ensure content is indexed |
| 13 | Policy limit reached | Consolidate existing policies to stay within tenant limits |
| 14 | Simulation location limit exceeded | Reduce adaptive scope membership below 20,000 before running simulation |
| 15 | Adaptive scope not populated | Wait at least 5 days for scope population → see [adaptive-scope.md](adaptive-scope.md) for full troubleshooting |

---

## Cross-References

- [policy-stuck-error.md](policy-stuck-error.md) — Policy distribution failures and "Off (Error)" status
- [adaptive-scope.md](adaptive-scope.md) — Adaptive scope query and membership issues
- [retention-policy-not-applying.md](retention-policy-not-applying.md) — General policy application troubleshooting
