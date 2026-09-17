# Adaptive Scope Issues

## Symptoms

- **Wrong members in scope:** Adaptive scope includes users, groups, or sites that should not be targeted — often caused by an OPATH filter matching unintended recipients.
- **No members in scope:** Scope shows 0 members in the portal or `Get-Recipient -Filter` returns no results — filter query is invalid or too restrictive.
- **Scope shows members in portal but policy still failing:** Membership appears correct in the scope details page, but the associated retention policy is not applying to those locations.
- **Scope populating slowly:** Scope was recently created and membership count is still increasing — adaptive scopes require at least 5 days to fully populate.
- **Inflated member count:** Scope count is significantly higher than expected — unlicensed, synced, or non-mailbox accounts are being included.
- **Cannot use with trainable classifiers:** Auto-apply policy using a trainable classifier fails when combined with an adaptive scope — this combination is not supported.

---

## Data Collection

Execute all commands below to gather the complete diagnostic dataset. Replace `<ScopeName>` with the adaptive scope name and `<PolicyName>` with the associated policy.

### 1.1 Scope Configuration & Filter Query

```powershell
Get-AdaptiveScope "<ScopeName>" | FL Name, LocationType, RawQuery, FilterConditions, WhenCreated, WhenChanged
```

### 1.2 User Scope OPATH Validation

```powershell
# Test the scope filter query against actual recipients
Get-Recipient -Filter "<same filter from adaptive scope>" -ResultSize Unlimited | Measure-Object
Get-Recipient -Filter "<same filter from adaptive scope>" -ResultSize 10 | FL Name, RecipientType, RecipientTypeDetails
```

### 1.3 M365 Group Scope Validation

```powershell
# For group-type adaptive scopes
Get-Mailbox -GroupMailbox -Filter "<same filter from adaptive scope>" -ResultSize Unlimited | Measure-Object
```

### 1.4 Associated Retention Policy Status

```powershell
Get-RetentionCompliancePolicy "<PolicyName>" | FL Name, Enabled, Mode, AdaptiveScopeLocation
Get-RetentionCompliancePolicy "<PolicyName>" -DistributionDetail | FL DistributionStatus, DistributionDetail
```

### 1.5 Non-Mailbox User Inflation Check

```powershell
# Compare Get-User (all users) vs Get-Recipient (mailbox users) for the same filter
Get-User -Filter "<same filter from adaptive scope>" -ResultSize Unlimited | Measure-Object
Get-Recipient -RecipientTypeDetails UserMailbox -Filter "<same filter from adaptive scope>" -ResultSize Unlimited | Measure-Object
```

### 1.6 Scope Age Check

```powershell
Get-AdaptiveScope "<ScopeName>" | FL WhenCreated
# Calculate days since creation — scope needs at least 5 days to fully populate
```

### 1.7 Scope Membership

> **NOTE:** `Get-AdaptiveScopeMembers` is not available via the MCP tool. This command must be executed manually by the admin in a PowerShell session.

```powershell
Get-AdaptiveScopeMembers -Identity "<ScopeName>"
```

---

## Diagnostic Analysis

### Prerequisites / Licensing

**Prerequisites:** Adaptive scopes require Microsoft 365 E5, E5 Compliance, or E5 Information Protection & Governance add-on. Without this license, adaptive scopes cannot be created.

Analyze the collected data against the following criteria. Flag each as ✅ (healthy) or ❌ (issue found).

**OPATH operators reference:** `eq`, `ne`, `lt`, `gt`, `like`, `notlike`, `and`, `or`, `not`

**KQL site template reference:**

| Template | Site Type |
|---|---|
| `SITEPAGEPUBLISHING` | Modern communication sites |
| `GROUP` | Microsoft 365 group-connected sites |
| `TEAMCHANNEL` | Teams private channel sites |
| `STS` | Classic SharePoint team sites |
| `SPSPERS` | OneDrive sites |

**Adaptive scope limits:**

| Limit | Value |
|---|---|
| String length for attribute values | 200 chars |
| Attributes per group or without group | 10 |
| Number of groups | 10 |
| Advanced query characters | 10,000 |
| Members displayed in scope details | 1,000,000 |
| Simulation locations (adaptive scope) | 20,000 |

| # | Check | Condition for ❌ |
|---|---|---|
| 1 | **Scope populated** | `Get-AdaptiveScopeMembers` returns no results or `Get-Recipient -Filter` returns no matches |
| 2 | **Scope age ≥ 5 days** | `WhenCreated` < 5 days ago — scope has not had time to fully populate |
| 3 | **OPATH syntax valid** | `Get-Recipient -Filter` returns an error — filter query has syntax issues (unbalanced quotes, wrong operators, invalid attributes) |
| 4 | **Non-mailbox user inflation** | `Get-User` count significantly exceeds `Get-Recipient` count — unlicensed/synced accounts without mailboxes are inflating the scope |
| 5 | **Arbitration mailbox inclusion** | Scope details in portal show system/arbitration mailboxes — these appear in scope details but not in PowerShell validation. Expected behavior |
| 6 | **KQL site template mapping** | For SharePoint scopes, KQL query uses incorrect template name or custom `RefinableString` properties are not mapped correctly |
| 7 | **Policy distribution** | `DistributionStatus` ≠ Success on the associated policy → switch to [policy-stuck-error.md](policy-stuck-error.md) |
| 8 | **Trainable classifier + adaptive scope** | Auto-apply policy uses a trainable classifier AND an adaptive scope — this combination is **not supported**. Use a static scope instead |
| 9 | **Attribute limits exceeded** | Filter query uses more than 10 attributes per group, or more than 10 groups |
| 10 | **Query length exceeded** | Advanced query exceeds 10,000 characters |
| 11 | **Simulation location limit** | Simulation mode with adaptive scope exceeds 20,000 locations |
| 12 | **Membership display limit** | Scope has more than 1,000,000 members — portal display truncated (not an error, but affects verification) |

---

## Resolution & Remediation

> **⚠️ Do not offer to execute these steps.** The resolutions below contain mutating commands (`Set-*`, `New-*`, `Remove-*`, etc.) that cannot be run through the MCP server. Present these as recommendations for the admin to review and run manually in their own PowerShell session.

Based on flagged issues from the diagnostic analysis, apply the corresponding resolution:

| ❌ Check | Root Cause | Resolution |
|---|---|---|
| 1 | Filter query returns no matches | Review and correct the `FilterQuery` — validate with `Get-Recipient -Filter` or `Get-Mailbox -GroupMailbox -Filter` before updating the scope |
| 2 | Scope too new to populate | Wait at least 5 days after scope creation. Do not assign to a policy until membership is confirmed |
| 3 | OPATH syntax error | Fix filter syntax — check for unbalanced quotes, incorrect operators, or invalid attribute names. See OPATH operators reference above |
| 4 | Unlicensed users inflating count | Refine the filter to target only mailbox-enabled recipients: add `(RecipientType -eq 'UserMailbox')` or `(RecipientTypeDetails -eq 'UserMailbox')` to the filter |
| 5 | Arbitration mailboxes in scope details | No action required — this is expected behavior. Arbitration mailboxes are excluded from policy enforcement |
| 6 | Incorrect KQL site template | Correct the KQL query using the site template reference above. Validate by running the query in SharePoint search before applying |
| 7 | Policy distribution failure | Switch to [policy-stuck-error.md](policy-stuck-error.md) for distribution troubleshooting |
| 8 | Trainable classifier + adaptive scope | Remove the adaptive scope and use a static scope instead. This is a platform limitation — see [auto-apply-labels.md](auto-apply-labels.md) |
| 9 | Too many attributes in filter | Simplify the filter to stay within the 10-attribute limit per group |
| 10 | Query too long | Shorten the advanced query to under 10,000 characters |
| 11 | Too many simulation locations | Reduce adaptive scope membership below 20,000 before running simulation, or run simulation in batches |
| 12 | Membership display truncated | Use `Get-AdaptiveScopeMembers` in PowerShell to view full membership beyond 1,000,000 |

---

## Cross-References

- [policy-stuck-error.md](policy-stuck-error.md) — Policy distribution failures
- [auto-apply-labels.md](auto-apply-labels.md) — Auto-apply label issues including trainable classifier limitations
- [retention-policy-not-applying.md](retention-policy-not-applying.md) — Policy not applying to workloads
