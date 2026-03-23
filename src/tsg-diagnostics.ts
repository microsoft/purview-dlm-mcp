// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ============================================================================
// Types & Enums (from diagnostics/models.ts)
// ============================================================================

/** Severity level for a diagnostic check. */
export enum Severity {
  Pass = "Pass",
  Info = "Info",
  Warning = "Warning",
  Error = "Error",
}

/** Maps severity to Unicode icons. */
export function severityIcon(severity: Severity): string {
  switch (severity) {
    case Severity.Error:
      return "\u274C";
    case Severity.Warning:
      return "\u26A0\uFE0F";
    case Severity.Info:
      return "\u2139\uFE0F";
    case Severity.Pass:
      return "\u2705";
    default:
      return "?";
  }
}

/** A single diagnostic finding. */
export interface DiagnosticCheck {
  refNumber: number;
  check: string;
  severity: Severity;
  finding: string;
  remediation: string | null;
  escalation: string | null;
  crossReferences: string[];
}

/** A command executed as part of a TSG evaluation. */
export interface TsgCommand {
  step: string;
  command: string;
  success: boolean;
  output: string;
  durationMs: number;
}

/** Summary statistics for a TSG evaluation. */
export interface TsgSummary {
  errors: number;
  warnings: number;
  info: number;
  passed: number;
  text: string;
  overallStatus: string;
}

/** Complete result of a TSG evaluation. */
export interface TsgResult {
  tsg: string;
  tsgNumber: number;
  reference: string;
  timestamp: string;
  commands: TsgCommand[];
  diagnostics: DiagnosticCheck[];
  summary: TsgSummary;
}

// ============================================================================
// Output Parsers (from diagnostics/outputParsers.ts)
// ============================================================================

/** Strip ANSI escape codes from text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Parse PowerShell Format-List output into a list of key-value records.
 * Records are separated by blank lines.
 */
export function parseFormatList(rawOutput: string): Record<string, string>[] {
  const clean = stripAnsi(rawOutput).trim();
  if (!clean) return [];

  const blocks = clean.split(/\r?\n\s*\r?\n/).filter((b) => b.trim());
  const records: Record<string, string>[] = [];

  for (const block of blocks) {
    const record: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const match = line.match(/^(\S+)\s*:\s*(.*)/);
      if (match) {
        record[match[1].trim()] = match[2].trim();
      }
    }
    if (Object.keys(record).length > 0) records.push(record);
  }

  return records;
}

/** Parse a single record from Format-List output. */
export function parseSingleRecord(rawOutput: string): Record<string, string> {
  const records = parseFormatList(rawOutput);
  return records.length > 0 ? records[0] : {};
}

/** Check if a Format-List value is empty ({} or blank). */
export function isEmpty(val: string | undefined | null): boolean {
  if (val === undefined || val === null || val === "") return true;
  const v = val.trim();
  return v === "" || v === "{}" || v === "{}," || v === "$null";
}

/** Parse a size string like "(1,234,567 bytes)" to bytes. */
export function parseSizeToBytes(sizeStr: string): number | null {
  const match = sizeStr.match(/\(([\d,]+)\s*bytes?\)/i);
  if (match) {
    const bytes = parseInt(match[1].replace(/,/g, ""), 10);
    if (!isNaN(bytes)) return bytes;
  }
  return null;
}

/** Parse a date string. */
export function parsePsDate(dateStr: string): Date | null {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d;
}

/** Days since a given date string. */
export function daysSince(dateStr: string): number | null {
  const d = parsePsDate(dateStr);
  if (d === null) return null;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

/** Parse a boolean value from a Format-List record. */
export function boolVal(record: Record<string, string>, key: string): boolean | null {
  const v = record[key];
  if (v === undefined) return null;
  if (v === "True") return true;
  if (v === "False") return false;
  return null;
}

/** Get a value from a record, or empty string if not present. */
export function getVal(record: Record<string, string>, key: string): string {
  return record[key] ?? "";
}

/** Produce a standardized info check when parsing fails. */
export function parseFailure(refNumber: number, check: string, fieldName: string, rawValue: string): DiagnosticCheck {
  return {
    refNumber,
    check,
    severity: Severity.Info,
    finding: `Could not parse ${fieldName}: "${rawValue.slice(0, 80)}". Manual review recommended.`,
    remediation: null,
    escalation: null,
    crossReferences: [],
  };
}

/** Distribution error patterns from policy-stuck-error.md reference. */
export const distributionErrorPatterns: { pattern: RegExp; meaning: string }[] = [
  { pattern: /Settings not found/i, meaning: "No retention rules configured" },
  { pattern: /Something went wrong|PolicyNotifyError/i, meaning: "Transient pipeline error" },
  { pattern: /location is ambiguous|MultipleInactiveRecipientsError/i, meaning: "Duplicate recipients" },
  { pattern: /location is out of storage|SiteOutOfQuota/i, meaning: "Site quota exceeded" },
  { pattern: /site is locked|SiteInReadOnlyOrNotAccessible/i, meaning: "Site locked or read-only" },
  { pattern: /couldn't find this location|FailedToOpenContainer/i, meaning: "Location no longer exists" },
  { pattern: /can't process your policy|ActiveDirectorySyncError/i, meaning: "AD sync error" },
  { pattern: /can't apply a hold here|RecipientTypeNotAllowed/i, meaning: "Unsupported mailbox type" },
];

// ============================================================================
// TSG Evaluators (from diagnostics/tsgEvaluators.ts)
// ============================================================================

type EvaluatorFn = (commands: TsgCommand[]) => DiagnosticCheck[];

const evaluators: Record<number, EvaluatorFn> = {
  1: evaluateTsg1,
  2: evaluateTsg2,
  3: evaluateTsg3,
  4: evaluateTsg4,
  5: evaluateTsg5,
  6: evaluateTsg6,
  7: evaluateTsg7,
  8: evaluateTsg8,
  9: evaluateTsg9,
  10: evaluateTsg10,
};

/** Evaluate a TSG by number. */
export function evaluateTsg(tsgNumber: number, commands: TsgCommand[]): DiagnosticCheck[] {
  const evaluator = evaluators[tsgNumber];
  if (!evaluator) throw new Error(`No evaluator for TSG ${tsgNumber}`);
  return evaluator(commands);
}

/** Compute summary statistics from a list of diagnostic checks. */
export function computeSummary(diagnostics: DiagnosticCheck[]): TsgSummary {
  const errors = diagnostics.filter((d) => d.severity === Severity.Error).length;
  const warnings = diagnostics.filter((d) => d.severity === Severity.Warning).length;
  const info = diagnostics.filter((d) => d.severity === Severity.Info).length;
  const passed = diagnostics.filter((d) => d.severity === Severity.Pass).length;

  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors > 1 ? "s" : ""}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? "s" : ""}`);
  if (info > 0) parts.push(`${info} informational`);
  const text = parts.length > 0 ? parts.join(", ") : "All checks passed";

  const overallStatus = errors >= 3 ? "critical" : errors > 0 ? "issues" : warnings > 0 ? "warnings" : "healthy";

  return { errors, warnings, info, passed, text, overallStatus };
}

/** Safely get command output. */
function cmdOutput(commands: TsgCommand[], index: number): string {
  return index < commands.length ? commands[index].output : "";
}

/** Split a comma-separated hold string into entries. */
function parseHoldEntries(inPlaceHolds: string): string[] {
  const holdsClean = inPlaceHolds.replace(/[{}]/g, "").trim();
  return holdsClean.length > 0 ? holdsClean.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** Helper to create a DiagnosticCheck. */
function check(
  refNumber: number,
  checkName: string,
  severity: Severity,
  finding: string,
  remediation: string | null = null,
  escalation: string | null = null,
  crossReferences: string[] = [],
): DiagnosticCheck {
  return { refNumber, check: checkName, severity, finding, remediation, escalation, crossReferences };
}

// --- TSG 1: Retention Policy Not Applying ---

function evaluateTsg1(commands: TsgCommand[]): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const step1 = parseSingleRecord(cmdOutput(commands, 0));
  const step3Records = parseFormatList(cmdOutput(commands, 2));
  const step4 = parseSingleRecord(cmdOutput(commands, 3));
  const step5 = parseSingleRecord(cmdOutput(commands, 4));

  // 1. Distribution status
  let distStatus = getVal(step1, "DistributionStatus");
  if (!distStatus) distStatus = "Unknown";

  if (distStatus === "Success")
    checks.push(check(1, "Distribution status", Severity.Pass, "DistributionStatus = Success"));
  else if (distStatus === "Error" || distStatus === "PolicySyncTimeout")
    checks.push(
      check(
        1,
        "Distribution status",
        Severity.Error,
        `DistributionStatus = ${distStatus}`,
        "Run Set-RetentionCompliancePolicy -RetryDistribution. If persistent, follow Policy Stuck in Error TSG.",
        "If retry fails after 48 hrs, escalate for backend binding cleanup.",
        ["policy-stuck-error.md"],
      ),
    );
  else if (distStatus === "Pending")
    checks.push(
      check(
        1,
        "Distribution status",
        Severity.Warning,
        "DistributionStatus = Pending \u2014 policy may still be distributing.",
        "Wait for distribution to complete (up to 24\u201348 hrs for large tenants).",
        null,
        ["policy-stuck-error.md"],
      ),
    );
  else
    checks.push(
      check(
        1,
        "Distribution status",
        Severity.Warning,
        `DistributionStatus = ${distStatus}`,
        "Investigate non-standard distribution status.",
        null,
        ["policy-stuck-error.md"],
      ),
    );

  // 2. Retention rule exists
  const hasRules = step3Records.length > 0 && step3Records.some((r) => "Name" in r);
  if (hasRules) {
    const ruleNames = step3Records
      .map((r) => getVal(r, "Name"))
      .filter(Boolean)
      .join(", ");
    const durations = step3Records
      .map((r) => getVal(r, "RetentionDuration"))
      .filter(Boolean)
      .join(", ");
    checks.push(check(2, "Retention rule exists", Severity.Pass, `Rule(s): ${ruleNames}. Duration(s): ${durations}`));
  } else
    checks.push(
      check(
        2,
        "Retention rule exists",
        Severity.Error,
        "No retention rules found for this policy.",
        'Create a retention rule: New-RetentionComplianceRule -Policy "<PolicyName>" -RetentionDuration <days> -RetentionComplianceAction Keep.',
      ),
    );

  // 3. Target in scope
  const locations: Record<string, string> = {};
  for (const key of ["ExchangeLocation", "SharePointLocation", "OneDriveLocation", "TeamsChannelLocation"]) {
    const val = getVal(step4, key);
    if (!isEmpty(val)) locations[key] = val;
  }
  if (Object.keys(locations).length > 0) {
    const summary = Object.entries(locations)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
    checks.push(check(3, "Target in scope", Severity.Pass, `Workload locations configured: ${summary}`));
  } else
    checks.push(
      check(
        3,
        "Target in scope",
        Severity.Error,
        "All workload locations are empty \u2014 policy has no target scope.",
        "Update the policy scope to include target locations. Remove the user from any exception list.",
      ),
    );

  // 4. Adaptive scope
  const adaptiveScope = getVal(step4, "AdaptiveScopeLocation");
  if (!isEmpty(adaptiveScope))
    checks.push(
      check(4, "Adaptive scope", Severity.Info, `Adaptive scope configured: ${adaptiveScope}. See Adaptive Scope TSG for full validation.`, null, null, [
        "adaptive-scope.md",
      ]),
    );
  else if (Object.keys(locations).length === 0)
    checks.push(
      check(4, "Adaptive scope", Severity.Warning, "No adaptive scope configured and no static locations set.", "Configure either static workload locations or an adaptive scope.", null, [
        "adaptive-scope.md",
      ]),
    );

  // 5. Hold stamped on mailbox
  const exchangeInScope = !isEmpty(getVal(step4, "ExchangeLocation")) || !isEmpty(getVal(step4, "AdaptiveScopeLocation"));
  if (exchangeInScope) {
    const inPlaceHolds = getVal(step5, "InPlaceHolds");
    const holdEntries = parseHoldEntries(inPlaceHolds);

    if (holdEntries.length > 0)
      checks.push(check(5, "Hold stamped on mailbox", Severity.Pass, `InPlaceHolds: ${holdEntries.join(", ")}`));
    else
      checks.push(
        check(
          5,
          "Hold stamped on mailbox",
          Severity.Warning,
          "No InPlaceHolds found on the mailbox. Policy may not be applied yet.",
          "Retry distribution: Set-RetentionCompliancePolicy -RetryDistribution. Wait 24\u201348 hrs.",
          "If still not stamped after 48 hrs, escalate for backend investigation.",
        ),
      );
  } else checks.push(check(5, "Hold stamped on mailbox", Severity.Info, "Hold stamp check not applicable \u2014 policy does not target Exchange."));

  // 6. Propagation window
  const mode = getVal(step1, "Mode");
  const enabled = getVal(step1, "Enabled");
  if (enabled === "True" && mode !== "PendingDeletion")
    checks.push(
      check(
        6,
        "Propagation window",
        Severity.Info,
        "Exchange: up to 7 days. SharePoint/OneDrive: 24 hrs. Teams: 48\u201372 hrs.",
        "Wait for the propagation window to elapse, then re-verify.",
      ),
    );

  // 7. Policy disabled
  if (enabled === "False")
    checks.push(
      check(7, "Policy disabled", Severity.Error, "Policy is disabled (Enabled = False) and will not apply.", "Enable: Set-RetentionCompliancePolicy -Enabled $true."),
    );

  // 8. Exception lists
  const exceptionKeys = ["ExchangeLocationException", "SharePointLocationException", "OneDriveLocationException"];
  const activeExceptions: string[] = [];
  for (const key of exceptionKeys) {
    const val = getVal(step4, key);
    if (!isEmpty(val)) activeExceptions.push(`${key}: ${val}`);
  }
  if (activeExceptions.length > 0)
    checks.push(
      check(
        8,
        "Exception list",
        Severity.Warning,
        `Target may be explicitly excluded: ${activeExceptions.join("; ")}`,
        "Verify the affected location is not on an exception list.",
      ),
    );

  // 9. Distribution detail errors
  const distDetailRaw = stripAnsi(cmdOutput(commands, 1)).trim();
  if (distDetailRaw) {
    const matchedErrors = distributionErrorPatterns.filter((ep) => ep.pattern.test(distDetailRaw)).map((ep) => ep.meaning);

    if (matchedErrors.length > 0)
      checks.push(
        check(
          9,
          "Distribution detail errors",
          Severity.Error,
          `Distribution errors detected: ${matchedErrors.join("; ")}`,
          "See policy-stuck-error.md for error-specific remediation.",
          "If errors persist after retry, escalate for backend investigation.",
          ["policy-stuck-error.md"],
        ),
      );
  }

  return checks;
}

// --- TSG 2: Policy Stuck in Error ---

function evaluateTsg2(commands: TsgCommand[]): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const step1 = parseSingleRecord(cmdOutput(commands, 0));
  const step2 = parseSingleRecord(cmdOutput(commands, 1));
  const step3 = parseSingleRecord(cmdOutput(commands, 2));
  const step4Records = parseFormatList(cmdOutput(commands, 3));

  // 1. Distribution status
  let distStatus = getVal(step1, "DistributionStatus");
  if (!distStatus) distStatus = "Unknown";

  if (distStatus === "Success") checks.push(check(1, "Distribution status", Severity.Pass, "DistributionStatus = Success"));
  else if (distStatus === "Error" || distStatus === "PolicySyncTimeout")
    checks.push(
      check(
        1,
        "Distribution status",
        Severity.Error,
        `DistributionStatus = ${distStatus}`,
        "Run Set-RetentionCompliancePolicy -RetryDistribution. Wait 24\u201348 hrs.",
        "If still failing after 48 hrs with no duplicate objects, escalate for backend binding cleanup.",
      ),
    );
  else if (distStatus === "Pending")
    checks.push(
      check(1, "Distribution status", Severity.Warning, "DistributionStatus = Pending \u2014 distribution in progress.", "Wait up to 24\u201348 hrs for distribution to complete."),
    );
  else checks.push(check(1, "Distribution status", Severity.Warning, `DistributionStatus = ${distStatus}`, "Investigate non-standard distribution status."));

  // 2. Pending deletion
  let modeStr = getVal(step2, "Mode");
  if (!modeStr) modeStr = getVal(step1, "Mode");

  if (modeStr === "PendingDeletion")
    checks.push(
      check(
        2,
        "Pending deletion",
        Severity.Error,
        "Mode = PendingDeletion \u2014 policy is stuck in deletion.",
        "Force-delete: Remove-RetentionCompliancePolicy -ForceDeletion.",
        "If force-delete fails, escalate for backend cleanup.",
      ),
    );
  else checks.push(check(2, "Pending deletion", Severity.Pass, `Mode = ${modeStr || "N/A"} \u2014 not pending deletion.`));

  // 3. Policy age
  const whenCreated = getVal(step2, "WhenCreated");
  if (whenCreated) {
    const ageDays = daysSince(whenCreated);
    if (ageDays !== null && ageDays < 2)
      checks.push(
        check(
          3,
          "Policy age",
          Severity.Info,
          `Policy created ${ageDays.toFixed(1)} days ago \u2014 within normal 48-hr distribution window.`,
          "Wait up to 48 hours for initial distribution to complete.",
        ),
      );
    else if (ageDays !== null)
      checks.push(check(3, "Policy age", Severity.Pass, `Policy created ${Math.round(ageDays)} days ago \u2014 past initial distribution window.`));
    else checks.push(parseFailure(3, "Policy age", "WhenCreated", whenCreated));
  }

  // 4. Policy type
  const policyType = getVal(step2, "Type");
  if (policyType) checks.push(check(4, "Policy type", Severity.Info, `Type = ${policyType}`));

  // 5. Workload locations
  const locKeys = ["ExchangeLocation", "SharePointLocation", "TeamsChannelLocation", "AdaptiveScopeLocation"];
  const configured = locKeys.filter((k) => !isEmpty(getVal(step3, k)));
  if (configured.length > 0) checks.push(check(5, "Workload locations", Severity.Pass, `Configured: ${configured.join(", ")}`));
  else checks.push(check(5, "Workload locations", Severity.Warning, "All workload locations are empty.", "Add target locations to the policy."));

  // 6. Duplicate objects
  if (step4Records.length > 1) {
    const names = step4Records.map((r) => getVal(r, "Name")).join(", ");
    checks.push(
      check(
        6,
        "Duplicate object check",
        Severity.Error,
        `${step4Records.length} duplicate recipients found: ${names}. Duplicates block policy distribution.`,
        "Remove the duplicate object, resync, then retry distribution.",
        "If duplicates cannot be resolved, escalate for AD cleanup.",
      ),
    );
  } else if (step4Records.length === 1)
    checks.push(
      check(6, "Duplicate object check", Severity.Pass, `Single recipient found: ${getVal(step4Records[0], "Name")} (${getVal(step4Records[0], "RecipientType")})`),
    );
  else checks.push(check(6, "Duplicate object check", Severity.Info, "No recipients matched the filter."));

  // 7. Adaptive scope age
  const adaptiveScope = getVal(step3, "AdaptiveScopeLocation");
  if (!isEmpty(adaptiveScope) && whenCreated) {
    const ageDays = daysSince(whenCreated);
    if (ageDays !== null && ageDays < 5)
      checks.push(
        check(
          7,
          "Adaptive scope age",
          Severity.Warning,
          `Adaptive scope used but policy is only ${ageDays.toFixed(1)} days old. Scope population takes up to 5 days.`,
          "Wait at least 5 days for the adaptive scope to fully populate.",
          null,
          ["adaptive-scope.md"],
        ),
      );
  }

  // 8. Distribution detail advisory
  checks.push(
    check(
      8,
      "Distribution detail advisory",
      Severity.Info,
      'TSG 2 test steps do not include -DistributionDetail. Run: Get-RetentionCompliancePolicy "<PolicyName>" -DistributionDetail | FL DistributionDetail for specific error codes.',
      null,
      null,
      ["policy-stuck-error.md"],
    ),
  );

  return checks;
}

// --- TSG 3: Items Not Moving to Archive ---

function evaluateTsg3(commands: TsgCommand[]): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const step1 = parseSingleRecord(cmdOutput(commands, 0));
  const step2Records = parseFormatList(cmdOutput(commands, 1));
  const step3Raw = stripAnsi(cmdOutput(commands, 2)).trim();
  const step4 = parseSingleRecord(cmdOutput(commands, 3));
  const step5Raw = stripAnsi(cmdOutput(commands, 4)).trim();
  const step6 = parseSingleRecord(cmdOutput(commands, 5));

  // 1. Archive enabled
  let archiveStatus = getVal(step1, "ArchiveStatus");
  if (!archiveStatus) archiveStatus = "None";
  if (archiveStatus === "Active") checks.push(check(1, "Archive enabled", Severity.Pass, "ArchiveStatus = Active"));
  else
    checks.push(
      check(1, "Archive enabled", Severity.Error, `ArchiveStatus = ${archiveStatus}`, "Enable the archive: Enable-Mailbox -Identity <UPN> -Archive.", null, [
        "auto-expanding-archive.md",
      ]),
    );

  // 2. MoveToArchive tag exists
  const archiveTags = step2Records.filter((r) => getVal(r, "RetentionEnabled") === "True");
  if (archiveTags.length > 0) {
    const tagNames = archiveTags.map((r) => getVal(r, "Name")).join(", ");
    checks.push(check(2, "MoveToArchive tag exists", Severity.Pass, `Active archive tags: ${tagNames}`));
  } else
    checks.push(
      check(
        2,
        "MoveToArchive tag exists",
        Severity.Error,
        "No enabled MoveToArchive retention tags found.",
        'Assign a retention policy with MoveToArchive tags: Set-Mailbox -RetentionPolicy "Default MRM Policy".',
      ),
    );

  // 3. Retention hold
  const retentionHold = boolVal(step1, "RetentionHoldEnabled");
  if (retentionHold === true)
    checks.push(
      check(
        3,
        "Retention hold",
        Severity.Error,
        "RetentionHoldEnabled = True \u2014 MRM processing is paused.",
        "Disable: Set-Mailbox -RetentionHoldEnabled $false.",
      ),
    );
  else checks.push(check(3, "Retention hold", Severity.Pass, "RetentionHoldEnabled = False"));

  // 4. ELC processing (mailbox level)
  const elcDisabledMbx = boolVal(step1, "ElcProcessingDisabled");
  if (elcDisabledMbx === true)
    checks.push(
      check(4, "ELC processing (mailbox)", Severity.Error, "ElcProcessingDisabled = True on mailbox.", "Enable: Set-Mailbox -ElcProcessingDisabled $false."),
    );
  else checks.push(check(4, "ELC processing (mailbox)", Severity.Pass, "ElcProcessingDisabled = False on mailbox"));

  // 5. ELC processing (org level)
  const elcDisabledOrg = boolVal(step4, "ElcProcessingDisabled");
  if (elcDisabledOrg === true)
    checks.push(
      check(5, "ELC processing (org)", Severity.Error, "ElcProcessingDisabled = True at org level.", "Enable: Set-OrganizationConfig -ElcProcessingDisabled $false."),
    );
  else checks.push(check(5, "ELC processing (org)", Severity.Pass, "ElcProcessingDisabled = False at org level"));

  // 6. License validation
  if (step3Raw) {
    const hasArchiveLicense = /BPOS_S_Enterprise|BPOS_S_Archive|BPOS_S_ArchiveAddOn/i.test(step3Raw);
    if (hasArchiveLicense) checks.push(check(6, "License validation", Severity.Pass, `License: ${step3Raw}`));
    else
      checks.push(
        check(
          6,
          "License validation",
          Severity.Error,
          `License capabilities: ${step3Raw} \u2014 missing required archive license.`,
          "Assign E3/E5 or Exchange Online Archiving add-on license (BPOS_S_Enterprise or BPOS_S_ArchiveAddOn).",
          null,
          ["auto-expanding-archive.md"],
        ),
      );
  } else
    checks.push(
      check(
        6,
        "License validation",
        Severity.Info,
        "License data not collected. Archive requires E3/E5 or Exchange Online Archiving add-on.",
        "Run: Get-MailboxPlan (Get-Mailbox <UPN>).MailboxPlan | Select-Object -ExpandProperty PersistedCapabilities",
      ),
    );

  // 7. ELC last success
  if (step5Raw)
    checks.push(check(7, "ELC last run", Severity.Info, `ELCLastSuccessTimestamp data: ${step5Raw.slice(0, 100)}`));
  else
    checks.push(
      check(
        7,
        "ELC last run",
        Severity.Warning,
        "ELCLastSuccessTimestamp not found \u2014 MRM may not have run on this mailbox.",
        "Trigger manually: Start-ManagedFolderAssistant -Identity <UPN>. Wait 24\u201348 hrs.",
      ),
    );

  // 8. Account status
  const accountDisabled = boolVal(step1, "AccountDisabled");
  const isShared = boolVal(step1, "IsShared");
  if (accountDisabled === true && isShared !== true)
    checks.push(
      check(
        8,
        "Account status",
        Severity.Warning,
        "AccountDisabled = True (non-shared mailbox). MRM may not process disabled accounts.",
        "Re-enable the account or convert to shared mailbox.",
      ),
    );
  else
    checks.push(
      check(8, "Account status", Severity.Pass, `AccountDisabled = ${accountDisabled ?? "N/A"}, IsShared = ${isShared ?? "N/A"}`),
    );

  // 9. Active move requests
  const moveStatus = getVal(step6, "Status");
  if (moveStatus && moveStatus !== "Completed")
    checks.push(
      check(
        9,
        "Active move requests",
        Severity.Warning,
        `Move request status: ${moveStatus} (${getVal(step6, "PercentComplete")}% complete). Archive moves paused during migration.`,
        "Wait for the move request to complete.",
      ),
    );
  else checks.push(check(9, "Active move requests", Severity.Pass, moveStatus ? "Move request completed." : "No active move requests."));

  // 10. Retention policy assignment
  const retPolicy = getVal(step1, "RetentionPolicy");
  if (retPolicy) checks.push(check(10, "MRM policy assigned", Severity.Pass, `RetentionPolicy = ${retPolicy}`, null, null, ["mrm-purview-conflict.md"]));
  else
    checks.push(
      check(10, "MRM policy assigned", Severity.Error, "No MRM retention policy assigned to mailbox.", 'Assign: Set-Mailbox -RetentionPolicy "Default MRM Policy".', null, [
        "mrm-purview-conflict.md",
      ]),
    );

  return checks;
}

// --- TSG 4: Auto-Expanding Archive ---

function evaluateTsg4(commands: TsgCommand[]): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const step1 = parseSingleRecord(cmdOutput(commands, 0));
  const step2 = parseSingleRecord(cmdOutput(commands, 1));
  const step3 = parseSingleRecord(cmdOutput(commands, 2));
  const step4Raw = stripAnsi(cmdOutput(commands, 3)).trim();
  const step5Raw = stripAnsi(cmdOutput(commands, 4)).trim();

  // 1. Org auto-expanding
  const orgEnabled = boolVal(step1, "AutoExpandingArchiveEnabled");
  if (orgEnabled === true)
    checks.push(check(1, "Org auto-expanding enabled", Severity.Pass, "AutoExpandingArchiveEnabled = True (org level)"));
  else
    checks.push(
      check(1, "Org auto-expanding enabled", Severity.Error, "AutoExpandingArchiveEnabled = False at org level.", "Enable: Set-OrganizationConfig -AutoExpandingArchive."),
    );

  // 2. User auto-expanding
  const userEnabled = boolVal(step2, "AutoExpandingArchiveEnabled");
  if (userEnabled === true)
    checks.push(check(2, "User auto-expanding enabled", Severity.Pass, "AutoExpandingArchiveEnabled = True (user level)"));
  else
    checks.push(
      check(
        2,
        "User auto-expanding enabled",
        Severity.Error,
        "AutoExpandingArchiveEnabled = False at user level.",
        "Enable: Enable-Mailbox -Identity <UPN> -AutoExpandingArchive.",
      ),
    );

  // 3. Archive status
  let archiveStatus = getVal(step2, "ArchiveStatus");
  if (!archiveStatus) archiveStatus = "None";
  if (archiveStatus === "Active") checks.push(check(3, "Archive status", Severity.Pass, "ArchiveStatus = Active"));
  else
    checks.push(
      check(
        3,
        "Archive status",
        Severity.Error,
        `ArchiveStatus = ${archiveStatus} \u2014 archive must be active for auto-expanding to function.`,
        "Enable archive first: Enable-Mailbox -Identity <UPN> -Archive.",
        null,
        ["items-not-moving-to-archive.md"],
      ),
    );

  // 4. Archive size (threshold: 90 GB)
  const totalItemSize = getVal(step3, "TotalItemSize");
  if (totalItemSize) {
    const archiveBytes = parseSizeToBytes(totalItemSize);
    const thresholdBytes = 90 * 1024 * 1024 * 1024;
    if (archiveBytes !== null) {
      const archiveGB = (archiveBytes / (1024 * 1024 * 1024)).toFixed(1);
      if (archiveBytes >= thresholdBytes)
        checks.push(
          check(4, "Archive size threshold", Severity.Pass, `Archive size: ${archiveGB} GB (\u2265 90 GB threshold for auto-expansion).`),
        );
      else
        checks.push(
          check(
            4,
            "Archive size threshold",
            Severity.Info,
            `Archive size: ${archiveGB} GB (below 90 GB auto-expansion threshold).`,
            "Auto-expansion triggers at \u2265 90 GB. No action needed if archive is not full.",
          ),
        );
    } else checks.push(parseFailure(4, "Archive size threshold", "TotalItemSize", totalItemSize));
  } else checks.push(check(4, "Archive size threshold", Severity.Info, "No archive statistics available (archive may not be provisioned)."));

  // 5. Aux archives
  const auxCount = step4Raw ? (step4Raw.match(/AuxArchive/gi) || []).length : 0;
  if (auxCount > 0)
    checks.push(
      check(
        5,
        "Auxiliary archives",
        auxCount >= 50 ? Severity.Warning : Severity.Pass,
        `${auxCount} auxiliary archive(s) found.${auxCount >= 50 ? " At maximum limit (50)." : ""}`,
        auxCount >= 50 ? "Maximum aux archives reached. Implement retention delete policies to reduce archive size." : null,
      ),
    );
  else checks.push(check(5, "Auxiliary archives", Severity.Info, "No auxiliary archives provisioned yet."));

  // 6. Litigation hold quota
  const litHold = boolVal(step2, "LitigationHoldEnabled");
  const archiveQuota = getVal(step2, "ArchiveQuota");
  if (litHold === true) {
    const quotaBytes = parseSizeToBytes(archiveQuota);
    if (quotaBytes !== null) {
      const is110GB = quotaBytes >= 110 * 1024 * 1024 * 1024;
      if (is110GB)
        checks.push(check(6, "Litigation hold quota", Severity.Pass, `Litigation hold enabled with ArchiveQuota = ${archiveQuota} (correctly bumped to 110 GB).`));
      else
        checks.push(
          check(
            6,
            "Litigation hold quota",
            Severity.Warning,
            `Litigation hold enabled but ArchiveQuota = ${archiveQuota}. Should be 110 GB.`,
            "Re-enable auto-expanding: Enable-Mailbox -AutoExpandingArchive (bumps quota to 110 GB).",
          ),
        );
    } else checks.push(parseFailure(6, "Litigation hold quota", "ArchiveQuota", archiveQuota));
  } else checks.push(check(6, "Litigation hold quota", Severity.Pass, "No litigation hold \u2014 quota adjustment not needed."));

  // 7. Archive connectivity
  if (step5Raw) {
    const success = step5Raw.toLowerCase().includes("success");
    const logonFail = step5Raw.toLowerCase().includes("couldn't log on");
    if (success) checks.push(check(7, "Archive connectivity", Severity.Pass, "Archive connectivity test succeeded."));
    else if (logonFail)
      checks.push(
        check(
          7,
          "Archive connectivity",
          Severity.Warning,
          `Archive connectivity: ${step5Raw}`,
          "Archive may not be provisioned. Enable archive first, then re-test.",
          "If archive is enabled but connectivity fails, escalate.",
        ),
      );
    else checks.push(check(7, "Archive connectivity", Severity.Info, `Archive connectivity result: ${step5Raw.slice(0, 200)}`));
  }

  // 8. ArchiveGuid
  const archiveGuid = getVal(step2, "ArchiveGuid");
  if (archiveGuid === "00000000-0000-0000-0000-000000000000")
    checks.push(check(8, "Archive provisioned", Severity.Info, "ArchiveGuid is empty (all zeros) \u2014 archive has never been provisioned."));

  // 9. License advisory
  checks.push(
    check(
      9,
      "License advisory",
      Severity.Info,
      "License data not collected in this TSG. Auto-expanding archive requires E3/E5 or Exchange Online Archiving add-on (BPOS_S_Enterprise or BPOS_S_ArchiveAddOn). Cross-reference TSG 3 for license validation.",
      null,
      null,
      ["items-not-moving-to-archive.md"],
    ),
  );

  return checks;
}

// --- TSG 5: Inactive Mailbox ---

function evaluateTsg5(commands: TsgCommand[]): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const step1Records = parseFormatList(cmdOutput(commands, 0));
  const step2Records = parseFormatList(cmdOutput(commands, 1));
  const step3Records = parseFormatList(cmdOutput(commands, 2));

  // 1. Inactive mailboxes found
  if (step1Records.length > 0) {
    const upns = step1Records
      .map((r) => getVal(r, "UserPrincipalName"))
      .filter(Boolean)
      .join(", ");
    checks.push(check(1, "Inactive mailbox exists", Severity.Pass, `${step1Records.length} inactive mailbox(es) found: ${upns}`));
  } else checks.push(check(1, "Inactive mailbox exists", Severity.Info, "No inactive mailboxes found in tenant."));

  // 2. Soft-deleted mailboxes & recovery window
  if (step2Records.length > 0) {
    for (const rec of step2Records) {
      let upnVal = getVal(rec, "UserPrincipalName");
      if (!upnVal) upnVal = "unknown";
      const whenDeleted = getVal(rec, "WhenSoftDeleted");
      const days = whenDeleted ? daysSince(whenDeleted) : null;

      if (days !== null && days <= 30)
        checks.push(
          check(
            2,
            `Soft-deleted: ${upnVal}`,
            Severity.Warning,
            `Soft-deleted ${Math.round(days)} days ago (within 30-day recovery window).`,
            "Recoverable: Restore user in Entra ID, apply hold, re-delete. Or use New-MailboxRestoreRequest.",
          ),
        );
      else if (days !== null)
        checks.push(
          check(2, `Soft-deleted: ${upnVal}`, Severity.Error, `Soft-deleted ${Math.round(days)} days ago (past 30-day recovery window).`, "Data may be permanently lost. No recovery possible."),
        );
      else if (whenDeleted) checks.push(parseFailure(2, `Soft-deleted: ${upnVal}`, "WhenSoftDeleted", whenDeleted));
    }
  } else checks.push(check(2, "Soft-deleted mailboxes", Severity.Info, "No soft-deleted mailboxes found."));

  // 3. Hold at deletion
  for (const rec of step1Records) {
    let upnVal = getVal(rec, "UserPrincipalName");
    if (!upnVal) upnVal = "unknown";
    const holds = getVal(rec, "InPlaceHolds");
    const litHold = boolVal(rec, "LitigationHoldEnabled");
    const compTagHold = boolVal(rec, "ComplianceTagHoldApplied");
    const hasHold = !isEmpty(holds) || litHold === true || compTagHold === true;
    if (!hasHold)
      checks.push(
        check(
          3,
          `Hold on inactive: ${upnVal}`,
          Severity.Error,
          "No InPlaceHolds, Litigation Hold, or ComplianceTagHold \u2014 mailbox may not be retained.",
          "For future: apply org-wide retention policy or litigation hold before user deletion.",
          null,
          ["retention-policy-not-applying.md"],
        ),
      );
  }

  // 4. Retention policy coverage
  if (step3Records.length > 0) {
    const policies = step3Records.filter((r) => boolVal(r, "Enabled") === true && getVal(r, "Mode") !== "PendingDeletion");
    if (policies.length > 0) {
      const names = policies
        .map((r) => getVal(r, "Name"))
        .join(", ");
      checks.push(check(4, "Retention policy coverage", Severity.Pass, `Active Exchange-wide retention policies: ${names}`));
    } else
      checks.push(
        check(
          4,
          "Retention policy coverage",
          Severity.Warning,
          "Retention policies found but none are active (enabled + not pending deletion).",
          "Ensure at least one org-wide retention policy is active for Exchange.",
          null,
          ["retention-policy-not-applying.md"],
        ),
      );
  } else
    checks.push(
      check(
        4,
        "Retention policy coverage",
        Severity.Warning,
        "No retention policies targeting all Exchange locations.",
        "Create an org-wide retention policy with ExchangeLocation = All to protect future mailboxes.",
        null,
        ["retention-policy-not-applying.md"],
      ),
    );

  // 5. Prevention
  checks.push(
    check(
      5,
      "Prevention",
      Severity.Info,
      "Ensure org-wide retention policy covers Exchange before user deletion. Verify hold stamp on mailbox. Consider Litigation Hold for critical mailboxes.",
    ),
  );

  return checks;
}

// --- TSG 6: SubstrateHolds / RI Quota ---

function evaluateTsg6(commands: TsgCommand[]): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const step1Records = parseFormatList(cmdOutput(commands, 0));
  const step2 = parseSingleRecord(cmdOutput(commands, 1));
  const step3Raw = stripAnsi(cmdOutput(commands, 2)).trim();
  const step4Raw = stripAnsi(cmdOutput(commands, 3)).trim();
  const step5Raw = stripAnsi(cmdOutput(commands, 4)).trim();

  // 1. Dominant RI folder
  const dominantFolders: string[] = [];
  let maxItems = 0;
  let maxFolderName = "";
  for (const folder of step1Records) {
    const items = parseInt(getVal(folder, "ItemsInFolder"), 10);
    if (!isNaN(items) && items > 0) {
      dominantFolders.push(`${getVal(folder, "Name")}: ${items} items`);
      if (items > maxItems) {
        maxItems = items;
        maxFolderName = getVal(folder, "Name");
      }
    }
  }
  const riCrossRefs = maxFolderName === "SubstrateHolds" ? ["teams-messages-not-deleting.md"] : [];
  checks.push(
    check(1, "Recoverable Items folders", Severity.Info, dominantFolders.length > 0 ? dominantFolders.join("; ") : "No items in Recoverable Items.", null, null, riCrossRefs),
  );

  // 2. Litigation hold
  const litHold = boolVal(step2, "LitigationHoldEnabled");
  const litDuration = getVal(step2, "LitigationHoldDuration");
  if (litHold === true)
    checks.push(
      check(
        2,
        "Litigation hold",
        Severity.Warning,
        `LitigationHoldEnabled = True${litDuration ? ` (Duration: ${litDuration})` : " (Unlimited)"}. All items retained in RI.`,
        "Remove if not needed: Set-Mailbox -LitigationHoldEnabled $false. Otherwise increase RecoverableItemsQuota.",
      ),
    );
  else checks.push(check(2, "Litigation hold", Severity.Pass, "No litigation hold."));

  // 3. Delay hold
  const delayHold = boolVal(step2, "DelayHoldApplied");
  if (delayHold === true)
    checks.push(
      check(
        3,
        "Delay hold",
        Severity.Warning,
        "DelayHoldApplied = True \u2014 30-day grace period after hold removal.",
        "Wait 30 days for automatic expiration, or force remove: Set-Mailbox -RemoveDelayHoldApplied.",
      ),
    );
  else checks.push(check(3, "Delay hold", Severity.Pass, "No delay hold applied."));

  // 4. Delay release hold
  const delayRelease = boolVal(step2, "DelayReleaseHoldApplied");
  if (delayRelease === true)
    checks.push(
      check(
        4,
        "Delay release hold",
        Severity.Warning,
        "DelayReleaseHoldApplied = True.",
        "Wait for automatic expiration or escalate if persistent.",
        "If DelayReleaseHoldApplied persists beyond 30 days, escalate.",
      ),
    );
  else checks.push(check(4, "Delay release hold", Severity.Pass, "No delay release hold."));

  // 5. Compliance tag hold
  const compTagHold = boolVal(step2, "ComplianceTagHoldApplied");
  if (compTagHold === true)
    checks.push(
      check(
        5,
        "Compliance tag hold",
        Severity.Warning,
        "ComplianceTagHoldApplied = True \u2014 a retention label is preventing cleanup.",
        "Review and remove the retention label if no longer needed.",
      ),
    );
  else checks.push(check(5, "Compliance tag hold", Severity.Pass, "No compliance tag hold."));

  // 6. InPlaceHolds (Purview/eDiscovery)
  const inPlaceHolds = getVal(step2, "InPlaceHolds");
  const holdEntries = parseHoldEntries(inPlaceHolds);

  if (holdEntries.length > 0) {
    const classified = holdEntries.map((h) =>
      h.startsWith("mbx")
        ? `${h} (Purview/Exchange)`
        : h.startsWith("cld")
          ? `${h} (Purview/Group)`
          : h.startsWith("UniH")
            ? `${h} (eDiscovery)`
            : h.startsWith("skp")
              ? `${h} (SPO/OD)`
              : h,
    );
    const multipleHolds = holdEntries.length >= 2;
    checks.push(
      check(
        6,
        "InPlaceHolds",
        multipleHolds ? Severity.Warning : Severity.Info,
        `${holdEntries.length} hold(s): ${classified.join("; ")}${multipleHolds ? ". Multiple overlapping holds \u2014 all must expire before RI cleanup." : ""}`,
        multipleHolds ? "Review overlapping holds. Longest retention period wins; all must expire before items are purged." : null,
      ),
    );
  } else checks.push(check(6, "InPlaceHolds", Severity.Pass, "No InPlaceHolds on mailbox."));

  // 7. Org-level holds
  if (step3Raw && step3Raw !== "{}" && step3Raw.length > 0)
    checks.push(check(7, "Org-level holds", Severity.Warning, `Org-level InPlaceHolds: ${step3Raw}`, "Review org-level holds. Remove if not needed."));
  else checks.push(check(7, "Org-level holds", Severity.Pass, "No org-level holds."));

  // 8. Dumpster expiration
  if (step4Raw) checks.push(check(8, "Dumpster expiration", Severity.Pass, "DumpsterExpiration data found."));
  else
    checks.push(
      check(
        8,
        "Dumpster expiration",
        Severity.Warning,
        "DumpsterExpirationLastSuccessRunTimestamp not found.",
        "Dumpster expiration may not be running. Monitor.",
        "If stuck for > 7 days, escalate.",
      ),
    );

  // 9. RI quota utilization
  const fiveGB = 5 * 1024 * 1024 * 1024;
  const riQuotaMatch = step5Raw.match(/TotalDeletedItemSize:\s*([^/]+)\s*\/\s*RecoverableItemsQuota:\s*(.+)/i);
  if (riQuotaMatch) {
    const deletedBytes = parseSizeToBytes(riQuotaMatch[1].trim());
    const riQuotaBytes = parseSizeToBytes(riQuotaMatch[2].trim());
    if (deletedBytes !== null && riQuotaBytes !== null) {
      const gap = riQuotaBytes - deletedBytes;
      const deletedGB = (deletedBytes / (1024 * 1024 * 1024)).toFixed(1);
      const riQuotaGB = (riQuotaBytes / (1024 * 1024 * 1024)).toFixed(1);
      if (gap <= 0)
        checks.push(
          check(
            9,
            "RI quota",
            Severity.Error,
            `RI quota exceeded: TotalDeletedItemSize ${deletedGB} GB / RecoverableItemsQuota ${riQuotaGB} GB.`,
            "Increase quota: Set-Mailbox -RecoverableItemsQuota 100GB. Address underlying hold/retention config.",
          ),
        );
      else if (gap <= fiveGB)
        checks.push(
          check(
            9,
            "RI quota",
            Severity.Warning,
            `RI quota near limit: TotalDeletedItemSize ${deletedGB} GB / RecoverableItemsQuota ${riQuotaGB} GB (${(gap / (1024 * 1024 * 1024)).toFixed(1)} GB remaining).`,
            "Increase quota or review holds to reduce RI growth.",
          ),
        );
      else
        checks.push(
          check(9, "RI quota", Severity.Pass, `RI quota healthy: TotalDeletedItemSize ${deletedGB} GB / RecoverableItemsQuota ${riQuotaGB} GB.`),
        );
    } else checks.push(parseFailure(9, "RI quota", "quota values", riQuotaMatch[0]));
  } else if (step5Raw)
    checks.push(check(9, "Quota utilization", Severity.Info, step5Raw.replace(/\r?\n/g, " | ")));

  // 10. Primary mailbox quota
  const primaryQuotaMatch = step5Raw.match(/TotalItemSize:\s*([^/]+)\s*\/\s*ProhibitSendReceiveQuota:\s*(.+?)(?:\r?\n|$)/i);
  if (primaryQuotaMatch) {
    const totalBytes = parseSizeToBytes(primaryQuotaMatch[1].trim());
    const quotaBytes = parseSizeToBytes(primaryQuotaMatch[2].trim());
    if (totalBytes !== null && quotaBytes !== null) {
      const gap = quotaBytes - totalBytes;
      const totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(1);
      const quotaGB = (quotaBytes / (1024 * 1024 * 1024)).toFixed(1);
      if (gap <= 0)
        checks.push(
          check(
            10,
            "Primary quota",
            Severity.Error,
            `Primary quota exceeded: TotalItemSize ${totalGB} GB / ProhibitSendReceiveQuota ${quotaGB} GB.`,
            "Address RI bloat first (above). Primary quota relief is secondary.",
          ),
        );
      else if (gap <= fiveGB)
        checks.push(
          check(
            10,
            "Primary quota",
            Severity.Warning,
            `Primary quota near limit: TotalItemSize ${totalGB} GB / ProhibitSendReceiveQuota ${quotaGB} GB (${(gap / (1024 * 1024 * 1024)).toFixed(1)} GB remaining).`,
            "Review mailbox size and RI consumption.",
          ),
        );
      else
        checks.push(
          check(10, "Primary quota", Severity.Pass, `Primary quota healthy: TotalItemSize ${totalGB} GB / ProhibitSendReceiveQuota ${quotaGB} GB.`),
        );
    } else checks.push(parseFailure(10, "Primary quota", "quota values", primaryQuotaMatch[0]));
  }

  return checks;
}

// --- TSG 7: Teams Messages Not Deleting ---

function evaluateTsg7(commands: TsgCommand[]): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const step1 = parseSingleRecord(cmdOutput(commands, 0));
  const step2 = parseSingleRecord(cmdOutput(commands, 1));
  const step3 = parseSingleRecord(cmdOutput(commands, 2));
  const step4Raw = stripAnsi(cmdOutput(commands, 3)).trim();

  // 1. Policy targets Teams
  const teamsChannel = getVal(step1, "TeamsChannelLocation");
  const teamsChat = getVal(step1, "TeamsChatLocation");
  const hasTeamsLocations = !isEmpty(teamsChannel) || !isEmpty(teamsChat);
  if (hasTeamsLocations) {
    const details = [
      !isEmpty(teamsChannel) ? `TeamsChannelLocation: ${teamsChannel}` : null,
      !isEmpty(teamsChat) ? `TeamsChatLocation: ${teamsChat}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    checks.push(check(1, "Policy targets Teams", Severity.Pass, details));
  } else
    checks.push(
      check(1, "Policy targets Teams", Severity.Error, "Neither TeamsChannelLocation nor TeamsChatLocation is configured.", "Update the policy to include Teams locations."),
    );

  // 2. Distribution status
  let distStatus = getVal(step1, "DistributionStatus");
  if (!distStatus) distStatus = "Unknown";
  if (distStatus === "Success") checks.push(check(2, "Distribution status", Severity.Pass, "DistributionStatus = Success"));
  else
    checks.push(
      check(2, "Distribution status", Severity.Error, `DistributionStatus = ${distStatus}`, "See Policy Stuck in Error TSG.", null, ["policy-stuck-error.md"]),
    );

  // 3. Retention rule
  const retDuration = getVal(step2, "RetentionDuration");
  const retAction = getVal(step2, "RetentionComplianceAction");
  if (retDuration && retAction) checks.push(check(3, "Retention rule", Severity.Pass, `RetentionDuration = ${retDuration}, Action = ${retAction}`));
  else checks.push(check(3, "Retention rule", Severity.Warning, "No retention rule details found for this policy."));

  // 4. 16-day async window
  checks.push(
    check(
      4,
      "Deletion timeline",
      Severity.Info,
      "Teams deletion can take up to 16 days after retention expires: MFA (7d) + TBA cleanup (7d) + client cache (2d).",
      "If within 16-day window, wait before investigating further.",
    ),
  );

  // 5. SubstrateHolds content
  const itemsInFolder = getVal(step3, "ItemsInFolder");
  if (itemsInFolder) {
    const items = parseInt(itemsInFolder, 10);
    const itemCount = isNaN(items) ? 0 : items;
    checks.push(
      check(
        5,
        "SubstrateHolds content",
        itemCount > 0 ? Severity.Info : Severity.Pass,
        `SubstrateHolds folder: ${itemCount} items, size: ${getVal(step3, "FolderSize")}`,
        null,
        null,
        itemCount > 0 ? ["substrateholds-quota.md"] : [],
      ),
    );
  } else checks.push(check(5, "SubstrateHolds content", Severity.Pass, "SubstrateHolds folder empty or not found."));

  // 6. Competing holds
  const userSection = step4Raw.split("DisplayName")[0];
  const userRecord = parseSingleRecord(userSection);
  const userLitHold = boolVal(userRecord, "LitigationHoldEnabled");
  const userCompTagHold = boolVal(userRecord, "ComplianceTagHoldApplied");

  if (userLitHold === true)
    checks.push(
      check(
        6,
        "Litigation hold (competing)",
        Severity.Warning,
        "LitigationHoldEnabled = True \u2014 may prevent Teams message deletion.",
        "Remove litigation hold if not required: Set-Mailbox -LitigationHoldEnabled $false.",
      ),
    );
  if (userCompTagHold === true)
    checks.push(
      check(
        6,
        "Compliance tag hold (competing)",
        Severity.Warning,
        "ComplianceTagHoldApplied = True \u2014 a retention label may prevent deletion.",
        "Review and remove the retention label if no longer needed.",
      ),
    );

  const userHolds = getVal(userRecord, "InPlaceHolds");
  const userHoldEntries = parseHoldEntries(userHolds);

  if (userHoldEntries.length >= 2)
    checks.push(
      check(
        6,
        "Multiple holds on user",
        Severity.Warning,
        `${userHoldEntries.length} InPlaceHolds on user mailbox \u2014 a competing policy with longer retention may be preventing deletion.`,
        "Review all holds. Longest retain period wins over delete.",
        null,
        ["substrateholds-quota.md"],
      ),
    );

  if (userLitHold !== true && userCompTagHold !== true && userHoldEntries.length < 2)
    checks.push(check(6, "Competing holds", Severity.Pass, "No litigation hold, compliance tag hold, or competing multi-hold interfering."));

  return checks;
}

// --- TSG 8: MRM / Purview Conflict ---

function evaluateTsg8(commands: TsgCommand[]): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const step1 = parseSingleRecord(cmdOutput(commands, 0));
  const step2Records = parseFormatList(cmdOutput(commands, 1));
  const step3Records = parseFormatList(cmdOutput(commands, 2));
  const step4Raw = stripAnsi(cmdOutput(commands, 3)).trim();

  // 1. MRM policy assigned
  const mrmPolicy = getVal(step1, "RetentionPolicy");
  if (mrmPolicy) {
    const hasDeleteTags = step2Records.some((r) => {
      const action = getVal(r, "RetentionAction");
      return (action === "DeleteAndAllowRecovery" || action === "PermanentlyDelete") && getVal(r, "RetentionEnabled") === "True";
    });
    if (hasDeleteTags)
      checks.push(
        check(
          1,
          "MRM policy assigned",
          Severity.Warning,
          `RetentionPolicy = ${mrmPolicy}. MRM has delete tags that may conflict with Purview retention.`,
          "If migrated to Purview, remove MRM: Set-Mailbox -RetentionPolicy $null.",
        ),
      );
    else
      checks.push(
        check(
          1,
          "MRM policy assigned",
          Severity.Info,
          `RetentionPolicy = ${mrmPolicy}. MRM assigned with MoveToArchive-only tags \u2014 this is a valid configuration alongside Purview.`,
        ),
      );
  } else checks.push(check(1, "MRM policy assigned", Severity.Pass, "No MRM retention policy assigned (clean Purview-only state)."));

  // 2. MRM delete tags
  const deleteTags = step2Records.filter((r) => {
    const action = getVal(r, "RetentionAction");
    return (action === "DeleteAndAllowRecovery" || action === "PermanentlyDelete") && getVal(r, "RetentionEnabled") === "True";
  });

  if (deleteTags.length > 0) {
    const tagNames = deleteTags.map((r) => `${getVal(r, "Name")} (${getVal(r, "RetentionAction")}, ${getVal(r, "AgeLimitForRetention")})`).join("; ");
    checks.push(
      check(
        2,
        "MRM delete tags",
        Severity.Warning,
        `Active MRM delete/purge tags: ${tagNames}`,
        "Review for conflict with Purview retain policies. Retention wins over deletion per precedence rules.",
      ),
    );
  } else checks.push(check(2, "MRM delete tags", Severity.Pass, "No active MRM delete/purge tags."));

  // 3. Purview retain policies
  if (step3Records.length > 0) {
    const names = step3Records
      .map((r) => getVal(r, "Name"))
      .filter(Boolean)
      .join(", ");
    checks.push(check(3, "Purview retain policies", Severity.Pass, `Purview policies targeting Exchange: ${names}`));
  } else
    checks.push(
      check(
        3,
        "Purview retain policies",
        Severity.Warning,
        "No Purview retention policies targeting all Exchange locations.",
        "If MRM delete tags exist without Purview retain safety net, items may be permanently deleted.",
        null,
        ["retention-policy-not-applying.md"],
      ),
    );

  // 4. MRM delete + no Purview retain
  if (deleteTags.length > 0 && step3Records.length === 0)
    checks.push(
      check(
        4,
        "Unprotected MRM deletion",
        Severity.Error,
        "MRM delete tags active with NO Purview retain policy \u2014 items may be permanently lost.",
        "Apply a Purview retain policy immediately. Recover from Recoverable Items within 14 days.",
        null,
        ["retention-policy-not-applying.md"],
      ),
    );
  else if (deleteTags.length > 0 && step3Records.length > 0)
    checks.push(
      check(
        4,
        "MRM + Purview interaction",
        Severity.Info,
        "MRM delete tags + Purview retain = expected behavior. Purview retain wins per precedence rules. Items move to RI but are kept.",
      ),
    );

  // 5. TracingFAI errors
  if (step4Raw && step4Raw.length > 10) {
    const hasFs =
      /"Fs"\s*:\s*[1-9]/i.test(step4Raw) || /DumpsterQuotaTooSmall|TagUnexpectedActionChanged|FAIUpdateFailed/i.test(step4Raw);
    if (hasFs)
      checks.push(
        check(
          5,
          "TracingFAI errors",
          Severity.Error,
          "TracingFAI errors detected. MRM configuration may be corrupted.",
          "Reset: Set-Mailbox -RemoveMRMConfiguration, then Start-ManagedFolderAssistant -Identity <UPN>.",
        ),
      );
    else checks.push(check(5, "TracingFAI errors", Severity.Pass, "TracingFAI data present with no critical errors."));
  } else checks.push(check(5, "TracingFAI errors", Severity.Pass, "No TracingFAI data (normal if MRM hasn't run recently)."));

  // 6. Retention precedence reminder
  checks.push(
    check(
      6,
      "Retention precedence",
      Severity.Info,
      "Rules: (1) Retain wins over delete. (2) Longest retention wins. (3) Explicit > implicit scope. (4) Shortest delete wins.",
    ),
  );

  return checks;
}

// --- TSG 9: Adaptive Scope ---

function evaluateTsg9(commands: TsgCommand[]): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const step1 = parseSingleRecord(cmdOutput(commands, 0));
  const step2Records = parseFormatList(cmdOutput(commands, 1));
  const step3Raw = stripAnsi(cmdOutput(commands, 2)).trim();
  const step4 = parseSingleRecord(cmdOutput(commands, 3));

  // 1. Scope populated
  const scopeName = getVal(step1, "Name");
  if (scopeName) {
    const locType = getVal(step1, "LocationType");
    const filterQuery = getVal(step1, "FilterQuery");
    checks.push(
      check(
        1,
        "Scope populated",
        Severity.Pass,
        `Scope: ${scopeName}, LocationType: ${locType || "N/A"}, Filter: ${filterQuery || "N/A"}`,
      ),
    );
  } else checks.push(check(1, "Scope populated", Severity.Error, "Adaptive scope not found or returned no data.", "Verify scope name. Create scope if it doesn't exist."));

  // 2. Scope age
  const whenCreated = getVal(step1, "WhenCreated");
  if (whenCreated) {
    const ageDays = daysSince(whenCreated);
    if (ageDays !== null && ageDays < 5)
      checks.push(
        check(
          2,
          "Scope age \u22655 days",
          Severity.Warning,
          `Scope created ${ageDays.toFixed(1)} days ago \u2014 population takes up to 5 days.`,
          "Wait at least 5 days before assigning scope to a policy.",
        ),
      );
    else if (ageDays !== null)
      checks.push(check(2, "Scope age \u22655 days", Severity.Pass, `Scope created ${Math.round(ageDays)} days ago \u2014 fully populated.`));
    else checks.push(parseFailure(2, "Scope age \u22655 days", "WhenCreated", whenCreated));
  }

  // 3. OPATH validation
  const step2Success = commands.length > 1 && commands[1].success;
  const step2Error = stripAnsi(cmdOutput(commands, 1));
  if (step2Success && step2Records.length > 0)
    checks.push(check(3, "OPATH filter validation", Severity.Pass, `Filter returned ${step2Records.length} recipient(s).`));
  else if (step2Error.includes("PS_ERROR") || step2Error.includes("Cannot process") || step2Error.includes("Invalid filter"))
    checks.push(
      check(
        3,
        "OPATH filter validation",
        Severity.Error,
        "OPATH filter syntax error \u2014 filter query is invalid.",
        'Fix the FilterQuery. Validate: Get-Recipient -Filter "<query>" -ResultSize 1.',
      ),
    );
  else checks.push(check(3, "OPATH filter validation", Severity.Info, "Filter returned no results (may be expected if scope targets specific attributes)."));

  // 4. Non-mailbox user inflation
  const countMatches = [...step3Raw.matchAll(/Count\s*:\s*(\d+)/g)];
  if (countMatches.length >= 2) {
    const getUserCount = parseInt(countMatches[0][1], 10);
    const getRecipientCount = parseInt(countMatches[1][1], 10);
    if (getUserCount > 0 && getRecipientCount > 0 && getUserCount > getRecipientCount * 1.5)
      checks.push(
        check(
          4,
          "Non-mailbox user inflation",
          Severity.Warning,
          `Get-User returned ${getUserCount} but Get-Recipient (UserMailbox) returned ${getRecipientCount}. ${getUserCount - getRecipientCount} non-mailbox accounts inflating scope.`,
          "Add RecipientType -eq 'UserMailbox' to the filter to exclude non-mailbox accounts.",
        ),
      );
    else
      checks.push(
        check(
          4,
          "Non-mailbox user inflation",
          Severity.Pass,
          `Get-User: ${getUserCount}, Get-Recipient (UserMailbox): ${getRecipientCount} \u2014 no significant inflation.`,
        ),
      );
  } else if (step3Raw) checks.push(parseFailure(4, "Non-mailbox user inflation", "Measure-Object Count", step3Raw));

  // 5. Associated policy distribution
  const policyName = getVal(step4, "Name");
  const policyDist = getVal(step4, "DistributionStatus");
  if (policyName) {
    if (policyDist === "Success")
      checks.push(check(5, "Associated policy", Severity.Pass, `Policy: ${policyName}, DistributionStatus = Success`));
    else
      checks.push(
        check(
          5,
          "Associated policy",
          Severity.Warning,
          `Policy: ${policyName}, DistributionStatus = ${policyDist || "Unknown"}`,
          "See Policy Stuck in Error TSG for distribution troubleshooting.",
          null,
          ["policy-stuck-error.md"],
        ),
      );
  } else checks.push(check(5, "Associated policy", Severity.Info, "No policies using adaptive scopes found."));

  // 6. Filter query length
  const filterQueryStr = getVal(step1, "FilterQuery");
  if (filterQueryStr.length > 10000)
    checks.push(
      check(6, "Query length", Severity.Error, `FilterQuery is ${filterQueryStr.length} chars (limit: 10,000).`, "Shorten the query to under 10,000 characters."),
    );

  // 7. Scope WhenChanged
  const whenChanged = getVal(step1, "WhenChanged");
  if (whenChanged && whenCreated) checks.push(check(7, "Scope dates", Severity.Info, `Created: ${whenCreated}, Last changed: ${whenChanged}`));

  // 8. Trainable classifier advisory
  checks.push(
    check(
      8,
      "Trainable classifier advisory",
      Severity.Info,
      "Trainable classifiers are NOT supported with adaptive scopes. If the associated policy uses a trainable classifier, it will not work.",
      "Use a static scope instead of an adaptive scope when using trainable classifiers.",
      null,
      ["auto-apply-labels.md"],
    ),
  );

  return checks;
}

// --- TSG 10: Auto-Apply Labels ---

function evaluateTsg10(commands: TsgCommand[]): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const step1 = parseSingleRecord(cmdOutput(commands, 0));
  const step2 = parseSingleRecord(cmdOutput(commands, 1));
  const step3Records = parseFormatList(cmdOutput(commands, 2));
  // 1. Policy enabled
  const enabled = boolVal(step1, "Enabled");
  if (enabled === true) checks.push(check(1, "Policy enabled", Severity.Pass, "Enabled = True"));
  else if ("Name" in step1)
    checks.push(check(1, "Policy enabled", Severity.Error, `Enabled = ${getVal(step1, "Enabled")} \u2014 policy is not active.`, "Enable: Set-RetentionCompliancePolicy -Enabled $true."));
  else checks.push(check(1, "Policy enabled", Severity.Error, "Auto-apply policy not found.", "Verify the policy name. Create one if needed."));

  // 2. Distribution status
  let distStatus = getVal(step1, "DistributionStatus");
  if (!distStatus) distStatus = "Unknown";
  if (distStatus === "Success") checks.push(check(2, "Distribution status", Severity.Pass, "DistributionStatus = Success"));
  else
    checks.push(
      check(
        2,
        "Distribution status",
        Severity.Error,
        `DistributionStatus = ${distStatus}`,
        "Retry: Set-RetentionCompliancePolicy -RetryDistribution. Wait 24\u201348 hrs.",
        "If persistent, see Policy Stuck in Error TSG.",
        ["policy-stuck-error.md"],
      ),
    );

  // 3. Mode (Enforce vs Simulate)
  const mode = getVal(step1, "Mode");
  if (mode === "Enforce" || mode === "Enable") checks.push(check(3, "Policy mode", Severity.Pass, `Mode = ${mode} (actively labeling content).`));
  else if (mode === "Simulate" || mode === "TestWithNotifications" || mode === "TestWithoutNotifications")
    checks.push(
      check(3, "Policy mode", Severity.Warning, `Mode = ${mode} \u2014 policy is in simulation, not enforcing.`, "Switch to enforce: Set-RetentionCompliancePolicy -Mode Enable."),
    );
  else if (mode) checks.push(check(3, "Policy mode", Severity.Warning, `Mode = ${mode}`, "Investigate non-standard mode."));

  // 4. Matching criteria
  const contentMatch = getVal(step2, "ContentMatchQuery");
  const sit = getVal(step2, "ContentContainsSensitiveInformation");
  const hasKQL = !isEmpty(contentMatch);
  const hasSIT = !isEmpty(sit);
  if (hasKQL || hasSIT) {
    const criteria = [hasKQL ? `KQL: ${contentMatch}` : null, hasSIT ? "SIT configured" : null].filter(Boolean).join("; ");
    checks.push(check(4, "Matching criteria", Severity.Pass, criteria));
  } else
    checks.push(
      check(
        4,
        "Matching criteria",
        Severity.Warning,
        "No ContentMatchQuery or SIT configured. Policy may not label any content.",
        "Add a KQL query, sensitive information type, or trainable classifier.",
      ),
    );

  // 5. Label linked
  const publishTag = getVal(step2, "PublishComplianceTag");
  if (!isEmpty(publishTag)) checks.push(check(5, "Label linked", Severity.Pass, `PublishComplianceTag = ${publishTag}`));
  else
    checks.push(
      check(5, "Label linked", Severity.Error, "No retention label linked to the auto-apply rule.", "Link a retention label to the rule via the Purview portal or PowerShell."),
    );

  // 6. Processing time (7-day ramp-up)
  const whenCreated = getVal(step1, "WhenCreated");
  if (whenCreated) {
    const ageDays = daysSince(whenCreated);
    if (ageDays !== null && ageDays < 7)
      checks.push(
        check(
          6,
          "Processing time",
          Severity.Info,
          `Policy created ${ageDays.toFixed(1)} days ago. Auto-apply can take up to 7 days to start labeling.`,
          "Wait up to 7 days, then re-check.",
        ),
      );
    else if (ageDays === null) checks.push(parseFailure(6, "Processing time", "WhenCreated", whenCreated));
  }

  // 7. Auto-apply policy count
  const step4Raw = stripAnsi(cmdOutput(commands, 3));
  const countMatch = step4Raw.match(/Count\s*:\s*(\d+)/);
  if (countMatch) {
    const count = parseInt(countMatch[1], 10);
    if (count >= 10000) checks.push(check(7, "Policy count limit", Severity.Error, `${count} auto-apply policies (limit: 10,000).`, "Consolidate policies to stay under the 10,000 limit."));
    else checks.push(check(7, "Policy count", Severity.Pass, `${count} auto-apply policy/policies found.`));
  } else if (step4Raw.trim()) checks.push(parseFailure(7, "Policy count", "Measure-Object Count", step4Raw));

  // 8. Compliance tags summary
  if (step3Records.length > 0) {
    const recordLabels = step3Records.filter((r) => boolVal(r, "IsRecordLabel") === true).length;
    checks.push(check(8, "Compliance tags", Severity.Info, `${step3Records.length} tag(s) available, ${recordLabels} record label(s).`));
  }

  // 9. Existing labels blocking advisory
  checks.push(
    check(
      9,
      "Existing labels advisory",
      Severity.Info,
      "Auto-apply labels NEVER overwrite existing retention labels. If target items already have a label, they will be skipped. This is the most common reason auto-apply appears to not label content.",
      "Remove existing labels first (manually or via script) if auto-apply should take priority.",
    ),
  );

  return checks;
}

// ============================================================================
// Report Renderer (from diagnostics/reportRenderer.ts)
// ============================================================================

/** Renders TSG diagnostic results as a Markdown report. */
export function renderMarkdownReport(results: TsgResult[]): string {
  const lines: string[] = [];
  lines.push("# TSG Diagnostic Report");
  lines.push(`**Run:** ${new Date().toISOString()}`);
  lines.push(`**Tenant:** ${process.env.DLM_ORGANIZATION ?? "unknown"}`);
  lines.push(`**Target mailbox:** ${process.env.DLM_UPN ?? "unknown"}`);
  lines.push("");

  // Executive Summary
  const totalErrors = results.reduce((s, r) => s + r.summary.errors, 0);
  const totalWarnings = results.reduce((s, r) => s + r.summary.warnings, 0);
  const totalInfo = results.reduce((s, r) => s + r.summary.info, 0);

  lines.push("## Executive Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|---|---|");
  lines.push(`| TSGs evaluated | ${results.length} |`);
  lines.push(`| Total errors | ${totalErrors} |`);
  lines.push(`| Total warnings | ${totalWarnings} |`);
  lines.push(`| Total informational | ${totalInfo} |`);
  lines.push("");
  lines.push("| TSG | Status | Errors | Warnings | Result |");
  lines.push("|---|---|---|---|---|");

  for (const r of results) {
    const icon = r.summary.overallStatus === "healthy" ? "\u2705" : r.summary.overallStatus === "warnings" ? "\u26A0\uFE0F" : "\u274C";
    lines.push(`| ${r.tsgNumber}. ${r.tsg} | ${icon} | ${r.summary.errors} | ${r.summary.warnings} | ${r.summary.text} |`);
  }
  lines.push("");

  // Per-TSG Detail
  for (const r of results) {
    lines.push("---");
    lines.push(`## TSG ${r.tsgNumber} \u2014 ${r.tsg}`);
    lines.push(`**Reference:** ${r.reference}`);
    lines.push(`**Result:** ${r.summary.text}`);
    lines.push("");

    // Data Collection
    lines.push("### Data Collection");
    lines.push("| Step | Command | Status | Duration |");
    lines.push("|---|---|---|---|");
    for (const cmd of r.commands) {
      const status = cmd.success ? "\u2705" : "\u274C";
      const duration = `${(cmd.durationMs / 1000).toFixed(1)}s`;
      const cmdText = cmd.command.length > 80 ? cmd.command.slice(0, 77) + "..." : cmd.command;
      lines.push(`| ${cmd.step} | \`${cmdText}\` | ${status} | ${duration} |`);
    }
    lines.push("");

    // Diagnostic Analysis
    if (r.diagnostics.length > 0) {
      lines.push("### Diagnostic Analysis");
      lines.push("| # | Check | Status | Finding |");
      lines.push("|---|---|---|---|");
      for (const d of r.diagnostics) {
        const icon = severityIcon(d.severity);
        lines.push(`| ${d.refNumber} | ${d.check} | ${icon} | ${d.finding} |`);
      }
      lines.push("");

      // Remediation
      const actionable = r.diagnostics.filter(
        (d) => d.severity !== Severity.Pass && d.severity !== Severity.Info && d.remediation !== null,
      );
      if (actionable.length > 0) {
        lines.push("### Remediation");
        lines.push("");
        lines.push("> \u26A0\uFE0F **Manual action required.** The steps below contain mutating commands that cannot be executed through this MCP server. Copy and run them manually in your own PowerShell session after reviewing each one.");
        lines.push("");
        for (const d of actionable) {
          const icon = severityIcon(d.severity);
          lines.push(`- **${d.check}** (${icon}): ${d.remediation}`);
          if (d.escalation !== null) lines.push(`  - *Escalation:* ${d.escalation}`);
        }
        lines.push("");
      }

      // Cross-References
      const allRefs = [...new Set(r.diagnostics.flatMap((d) => d.crossReferences))];
      if (allRefs.length > 0) {
        lines.push("### Related TSGs");
        for (const reference of allRefs) lines.push(`- ${reference}`);
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}
