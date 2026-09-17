# Expected Events Are Not Audited

## Symptoms

- **No audit logs found for any user:** `Search-UnifiedAuditLog` returns no results for any user in the tenant — unified audit log ingestion may be disabled.
- **No mailbox audit logs:** `Search-MailboxAuditLog` returns no results — mailbox auditing may be disabled at the organization level.
- **Audit logs missing for a specific user:** Activities for a particular mailbox are not recorded — audit bypass, licensing, or per-mailbox audit configuration may be the cause.
- **Premium audit events not available:** Advanced audit events (e.g., `MailItemsAccessed`, `Send`) are not present — tenant or user may lack E5/M365 Auditing capabilities.
- **Admin audit logs incomplete:** `Search-AdminAuditLog` returns partial results — arbitration mailbox Audits folder may have hit the 3 million item limit.
- **Audit logs missing for satellite geo:** Multi-Geo tenant and audit logs are not found — admin may be connected to the wrong region.
- **Custom audit retention not applying:** Events are being purged before expected — custom audit log retention policies may not cover the required record types or users.
- **AuxAuditLog mailbox missing:** Audit infrastructure mailbox is absent — engineering escalation required.

---

## Scenario Selection

This guide covers **two scenarios** based on whether the issue affects all users or a specific user:

| Scenario | When to Use | Data Collection |
|----------|-------------|-----------------|
| **Activities are not audited for all users** | No user specified — org-wide audit issue | Sections 1.1–1.9 |
| **Activities are not audited for a specific user** | A specific user is affected | Sections 1.1–1.9 (org-wide) **plus** Sections 2.1–2.7 (user-specific) |

---

## Data Collection — Scenario 1: All Users (Org-Wide)

Execute all commands below to gather the complete org-level diagnostic dataset.

### 1.1 Mailbox Audit Status (Organization Level)

```powershell
Get-OrganizationConfig | FL AuditDisabled
```

### 1.2 Unified Audit Log Ingestion Status

```powershell
Get-AdminAuditLogConfig | FL UnifiedAuditLogIngestionEnabled, UnifiedAuditLogFirstOptInDate
```

### 1.3 Tenant E5 / Premium Audit Capabilities

```powershell
Get-OrganizationConfig | FL PersistedCapabilities
```

### 1.4 Audit Log Retention Policies

```powershell
Get-UnifiedAuditLogRetentionPolicy | Format-Table Name, Guid, RecordTypes, RetentionDuration, UserIds
```

### 1.5 Arbitration Mailbox — Audits Folder Item Count

```powershell
Get-MailboxFolderStatistics "SystemMailbox{e0dc1c29-89c3-4034-b678-e6c29d823ed9}" -FolderScope RecoverableItems | Where-Object {
    $_.Name -eq "Audits"
} | Format-Table Name, ItemsInFolder, FolderSize
```

### 1.6 Arbitration Mailbox — Recoverable Items Quota

```powershell
Get-Mailbox -Arbitration "SystemMailbox{e0dc1c29-89c3-4034-b678-e6c29d823ed9}" | FL RecoverableItemsQuota
Get-MailboxStatistics "SystemMailbox{e0dc1c29-89c3-4034-b678-e6c29d823ed9}" | FL TotalDeletedItemSize
```

### 1.7 Multi-Geo Configuration

```powershell
Get-OrganizationConfig | FL AllowedMailboxRegions, DefaultMailboxRegion
```

### 1.8 AuxAuditLog Mailbox Existence

```powershell
Get-Mailbox -AuxAuditLog -ErrorAction SilentlyContinue | FL Name, Guid, Database
```

### 1.9 ELC Processing Status (Organization Level)

```powershell
Get-OrganizationConfig | FL ElcProcessingDisabled
```

---

## Data Collection — Scenario 2: Specific User (Additional Steps)

Execute all org-wide commands above (1.1–1.9) **plus** the following user-specific commands. Replace `<UPN>` with the affected user's email address.

### 2.1 User Mailbox Audit Configuration

```powershell
Get-Mailbox <UPN> | FL DisplayName, UserPrincipalName, PrimarySmtpAddress, ExchangeGuid, AuditEnabled, AuditAdmin, AuditDelegate, AuditOwner, DefaultAuditSet, PersistedCapabilities, RecoverableItemsQuota
```

### 2.2 Mailbox Audit Bypass Status

```powershell
Get-MailboxAuditBypassAssociation <UPN> | FL Name, AuditBypassEnabled
```

### 2.3 User E5 / Premium Audit License (Mailbox Level)

```powershell
Get-Mailbox <UPN> | FL PersistedCapabilities
```

### 2.4 User Audit Retention Policy Membership

```powershell
# Check if user appears in any custom audit retention policies
Get-UnifiedAuditLogRetentionPolicy | Where-Object { $_.UserIds -contains "<UPN>" } | Format-Table Name, Guid, RecordTypes, RetentionDuration
```

### 2.5 User Mailbox — Audits Folder Item Count

```powershell
Get-MailboxFolderStatistics <UPN> -FolderScope RecoverableItems | Where-Object {
    $_.Name -eq "Audits"
} | Format-Table Name, ItemsInFolder, FolderSize
```

### 2.6 User Mailbox — Recoverable Items Utilization

```powershell
Get-MailboxStatistics <UPN> | FL TotalDeletedItemSize
Get-Mailbox <UPN> | FL RecoverableItemsQuota
```

### 2.7 User Mailbox — Archive & ELC Status

```powershell
Get-Mailbox <UPN> | FL ArchiveStatus, ArchiveGuid, ElcProcessingDisabled, RetentionPolicy
```

---

## Diagnostic Analysis — Scenario 1: All Users (Org-Wide)

Analyze the collected data against the following criteria. Flag each as ✅ (healthy) or ❌ (issue found).

| # | Check | Condition for ❌ |
|---|---|---|
| 1 | **Mailbox auditing enabled (org)** | `AuditDisabled` = True — mailbox auditing is disabled at the organization level. Admins cannot find mailbox audit logs via `Search-MailboxAuditLog` |
| 2 | **Unified audit log ingestion enabled** | `UnifiedAuditLogIngestionEnabled` = False — Exchange audit log ingestion into the Unified Audit Log is disabled. No Exchange events will appear in `Search-UnifiedAuditLog` |
| 3 | **Unified audit log opt-in date** | `UnifiedAuditLogFirstOptInDate` is populated — events before this date will **not** be available in Unified Audit Log. Flag if customer is searching for events before this date |
| 4 | **E5 / Premium audit capabilities (tenant)** | `PersistedCapabilities` does not contain `M365Auditing` — tenant is not eligible for premium audit events (e.g., `MailItemsAccessed`, `Send`, `SearchQueryInitiatedExchange`, `SearchQueryInitiatedSharePoint`) |
| 5 | **Custom audit retention policies** | `Get-UnifiedAuditLogRetentionPolicy` returns policies with specific `RecordTypes` — some event types may have different retention durations. Highlight which record types have custom retention |
| 6 | **Arbitration mailbox Audits folder limit** | `ItemsInFolder` for the Audits folder in the arbitration mailbox ≥ 3,000,000 — the 3 million item limit has been reached. `Search-AdminAuditLog` results will be incomplete |
| 7 | **Arbitration mailbox Recoverable Items quota** | `TotalDeletedItemSize` is approaching or exceeds `RecoverableItemsQuota` — no new audit events can be recorded in the arbitration mailbox |
| 8 | **Multi-Geo tenant** | `AllowedMailboxRegions` contains multiple regions — audit log availability varies by region. Admin audit logs work across all regions, but Unified Audit and Mailbox Audit logs require connecting to the correct region |
| 9 | **AuxAuditLog mailbox exists** | `Get-Mailbox -AuxAuditLog` returns no results — the AuxAuditLog infrastructure mailbox is missing. **Engineering escalation required** |
| 10 | **ELC processing enabled (org)** | `ElcProcessingDisabled` = True — ELC processing is disabled org-wide, which can affect audit log retention processing |

---

## Diagnostic Analysis — Scenario 2: Specific User (Additional Checks)

Run **all org-wide checks (1–10)** above first, then apply the following user-specific checks.

| # | Check | Condition for ❌ |
|---|---|---|
| 11 | **Mailbox audit enabled (user)** | `AuditEnabled` = False — mailbox audit logging is not enabled for this user. Activities will not be recorded unless `M365Auditing` is assigned and mailbox auditing on by default is in effect |
| 12 | **M365Auditing capability (user)** | `PersistedCapabilities` does not contain `M365Auditing` — premium audit features are not available for this user. Check if the assigned subscription includes M365Auditing but it is not enabled |
| 13 | **Audit bypass enabled** | `AuditBypassEnabled` = True — all mailbox audit logging is bypassed for this user. Activities performed by or on behalf of this user are **not recorded** |
| 14 | **Audit actions configured** | Review `AuditAdmin`, `AuditDelegate`, `AuditOwner` — the specific activity the customer is looking for may not be in the configured audit action list for the relevant logon type |
| 15 | **DefaultAuditSet coverage** | `DefaultAuditSet` does not include all three logon types (`Admin`, `Delegate`, `Owner`) — some logon types are using custom (potentially incomplete) audit action lists instead of the Microsoft-managed defaults |
| 16 | **User Audits folder limit** | `ItemsInFolder` for the user's Audits folder ≥ 3,000,000 — the 3 million item limit has been reached. Use `Search-UnifiedAuditLog` instead of `Search-MailboxAuditLog` |
| 17 | **User Recoverable Items quota** | `TotalDeletedItemSize` is approaching or exceeds `RecoverableItemsQuota` — no new audit events can be recorded in the user mailbox Audits folder |
| 18 | **Custom audit retention for user** | User appears in a `Get-UnifiedAuditLogRetentionPolicy` with specific `RecordTypes` and `RetentionDuration` — events of those types will be retained for the specified duration, which may differ from the org default |
| 19 | **ELC processing enabled (user)** | `ElcProcessingDisabled` = True — ELC processing is disabled for this specific mailbox. Audit log retention may not be processed correctly |

---

## Resolution & Remediation — Scenario 1: All Users (Org-Wide)

> **⚠️ Do not offer to execute these steps.** The resolutions below contain mutating commands (`Set-*`, `New-*`, `Remove-*`, etc.) that cannot be run through the MCP server. Present these as recommendations for the admin to review and run manually in their own PowerShell session.

| ❌ Check | Root Cause | Resolution |
|---|---|---|
| 1 | Mailbox auditing disabled at org level | Admin should enable mailbox auditing: `Set-OrganizationConfig -AuditDisabled $false`. Note: it can take up to 24 hours to take effect |
| 2 | Unified audit log ingestion disabled | Admin should enable unified audit log ingestion: `Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true` |
| 3 | Events pre-date opt-in | Unified Audit Log only contains events from `UnifiedAuditLogFirstOptInDate` onward. Events before this date are not available. No remediation — informational only |
| 4 | No E5 / M365Auditing at tenant level | Tenant does not have premium audit capabilities. Premium events (`MailItemsAccessed`, `Send`, etc.) require Microsoft 365 E5, E5 Compliance, or E5 eDiscovery & Audit add-on licenses |
| 5 | Custom audit retention policies exist | Informational — review `RecordTypes` and `RetentionDuration` in each policy to understand which event types have non-default retention. Ensure the expected record types are covered |
| 6 | Arbitration Audits folder at 3M limit | Use `Search-UnifiedAuditLog` instead of `Search-AdminAuditLog` to retrieve admin audit events. The arbitration mailbox Audits folder has reached its item limit |
| 7 | Arbitration Recoverable Items quota hit | Use `Search-UnifiedAuditLog` instead of `Search-AdminAuditLog`. The arbitration mailbox cannot store additional audit entries. Consider archiving or extending quota via support |
| 8 | Multi-Geo tenant | **Admin audit logs:** Available across all regions — no action needed. **Unified Audit logs:** Connect to the main region (`DefaultMailboxRegion`) to search. **Mailbox Audit logs:** Connect to the forest where the target mailbox is located |
| 9 | AuxAuditLog mailbox missing | **Engineering escalation required.** The AuxAuditLog infrastructure mailbox is absent and cannot be provisioned by the admin. Escalate to the Audit engineering team |
| 10 | ELC processing disabled (org) | Admin should verify if ELC processing was intentionally disabled. If not, enable it: `Set-OrganizationConfig -ElcProcessingDisabled $false` |

---

## Resolution & Remediation — Scenario 2: Specific User (Additional)

> **⚠️ Do not offer to execute these steps.** The resolutions below contain mutating commands (`Set-*`, `New-*`, `Remove-*`, etc.) that cannot be run through the MCP server. Present these as recommendations for the admin to review and run manually in their own PowerShell session.

Apply **all org-wide resolutions** from Scenario 1 first, then the following user-specific resolutions.

| ❌ Check | Root Cause | Resolution |
|---|---|---|
| 11 | Mailbox audit not enabled for user | If `M365Auditing` is not assigned, admin should enable manually: `Set-Mailbox <UPN> -AuditEnabled $true`. If `M365Auditing` is assigned, mailbox auditing should be on by default — check for `DefaultAuditSet` overrides |
| 12 | M365Auditing not on user mailbox | Check if the user's assigned Microsoft 365 subscription includes M365Auditing. If M365Auditing is in the subscription but not enabled on the mailbox, it may need to be re-licensed or the license assignment may need to be refreshed. If the subscription does not include M365Auditing, premium audit features are not available for this user |
| 13 | Audit bypass enabled | Admin has explicitly bypassed auditing for this user. To resume auditing: `Set-MailboxAuditBypassAssociation <UPN> -AuditBypassEnabled $false`. Note: this was likely set intentionally (e.g., for service accounts) — confirm with admin before removing |
| 14 | Missing audit actions for logon type | The activity the customer is searching for is not in the configured audit action list. Admin can add the missing action: `Set-Mailbox <UPN> -AuditAdmin @{Add="<ActionName>"}` (or `-AuditDelegate`, `-AuditOwner`). Alternatively, revert to defaults by resetting `DefaultAuditSet` |
| 15 | DefaultAuditSet incomplete | Some logon types are using custom audit action lists. To restore Microsoft-managed defaults for all logon types: `Set-Mailbox <UPN> -DefaultAuditSet Admin,Delegate,Owner`. This ensures new audit actions added by Microsoft are automatically included |
| 16 | User Audits folder at 3M limit | Use `Search-UnifiedAuditLog` instead of `Search-MailboxAuditLog` for this user. Consider enabling the archive mailbox or reducing the mailbox audit log age limit to manage folder size |
| 17 | User Recoverable Items quota hit | The user's Recoverable Items has reached quota. Consider enabling archive, investigating Recoverable Items archiving, or reducing the mailbox audit log retention age. See [substrateholds-quota.md](substrateholds-quota.md) for Recoverable Items troubleshooting |
| 18 | Custom audit retention for user | Informational — the user has custom audit retention policies. Review the `RecordTypes` and `RetentionDuration` to confirm the expected events are retained for the required duration |
| 19 | ELC processing disabled (user) | Admin should verify if ELC processing was intentionally disabled for this mailbox. If not: `Set-Mailbox <UPN> -ElcProcessingDisabled $false` |

---

## Cross-References

- [substrateholds-quota.md](substrateholds-quota.md) — Recoverable Items quota and SubstrateHolds troubleshooting
- [items-not-moving-to-archive.md](items-not-moving-to-archive.md) — Archive and MRM processing issues
- [retention-policy-not-applying.md](retention-policy-not-applying.md) — General retention policy application troubleshooting