// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Explicitly allowed cmdlets (read-only diagnostic commands). */
export const allowedCmdlets = new Set(
  [
    // Security & Compliance (IPPSSession)
    "Get-AdaptiveScope",
    "Get-RetentionCompliancePolicy",
    "Get-RetentionComplianceRule",
    "Get-AppRetentionCompliancePolicy",
    "Get-AppRetentionComplianceRule",
    "Get-ComplianceTag",
    "Get-ComplianceTagStorageLocation",

    // Exchange Online
    "Export-MailboxDiagnosticLogs",
    "Get-AdminAuditLogConfig",
    "Get-AdaptiveScopeMembers",
    "Get-CasMailbox",
    "Get-DistributionGroup",
    "Get-InboxRule",
    "Get-IRMConfiguration",
    "Get-JournalRule",
    "Get-Mailbox",
    "Get-MailboxAuditBypassAssociation",
    "Get-MailboxFolderStatistics",
    "Get-MailboxLocation",
    "Get-MailboxPermission",
    "Get-MailboxPlan",
    "Get-MailboxStatistics",
    "Get-MailUser",
    "Get-MoveRequest",
    "Get-OrganizationConfig",
    "Get-Recipient",
    "Get-RetentionPolicy",
    "Get-RetentionPolicyTag",
    "Get-TransportRule",
    "Get-UnifiedAuditLogRetentionPolicy",
    "Get-UnifiedGroup",
    "Get-User",
    "Test-ArchiveConnectivity",
  ].map((c) => c.toLowerCase()),
);

/** Verb prefixes that are NEVER allowed (mutating cmdlets). */
const blockedPrefixes = [
  "set-",
  "new-",
  "remove-",
  "enable-",
  "start-",
  "disable-",
  "stop-",
  "invoke-",
  "add-",
  "clear-",
  "uninstall-",
  "update-",
  "register-",
  "revoke-",
  "grant-",
];

/** PowerShell built-in / formatting cmdlets that are always safe. */
const safeBuiltins = new Set([
  "write-host",
  "write-output",
  "write-warning",
  "write-error",
  "select-object",
  "where-object",
  "foreach-object",
  "format-table",
  "format-list",
  "convertto-json",
  "convertfrom-json",
  "group-object",
  "sort-object",
  "measure-object",
  "out-string",
  "join-string",
  "compare-object",
  "tee-object",
  "get-member",
  "get-date",
  "get-childitem",
]);

/**
 * Microsoft-approved PowerShell verb names (lowercase). A captured `verb-noun`
 * token is only treated as a cmdlet for allowlist purposes when its verb is in
 * this set — otherwise it's assumed to be a hyphenated string fragment (e.g.,
 * a hostname like `mailbox-prod-01`) and skipped.
 */
const knownPsVerbs = new Set([
  "add",
  "approve",
  "assert",
  "backup",
  "block",
  "checkpoint",
  "clear",
  "close",
  "compare",
  "complete",
  "compress",
  "confirm",
  "connect",
  "convert",
  "convertfrom",
  "convertto",
  "copy",
  "debug",
  "deny",
  "deploy",
  "disable",
  "disconnect",
  "dismount",
  "edit",
  "enable",
  "enter",
  "exit",
  "expand",
  "export",
  "find",
  "format",
  "foreach",
  "get",
  "grant",
  "group",
  "hide",
  "import",
  "initialize",
  "install",
  "invoke",
  "join",
  "limit",
  "lock",
  "measure",
  "merge",
  "mount",
  "move",
  "new",
  "open",
  "optimize",
  "out",
  "ping",
  "pop",
  "protect",
  "publish",
  "push",
  "read",
  "receive",
  "redo",
  "register",
  "remove",
  "rename",
  "repair",
  "request",
  "reset",
  "resize",
  "resolve",
  "restart",
  "restore",
  "resume",
  "revoke",
  "save",
  "search",
  "select",
  "send",
  "set",
  "show",
  "skip",
  "sort",
  "split",
  "start",
  "step",
  "stop",
  "submit",
  "suspend",
  "switch",
  "sync",
  "tee",
  "test",
  "trace",
  "unblock",
  "undo",
  "uninstall",
  "unlock",
  "unprotect",
  "unpublish",
  "unregister",
  "update",
  "use",
  "wait",
  "watch",
  "where",
  "write",
]);

/**
 * High-risk PowerShell aliases that obscure command intent (e.g., `iwr` →
 * `Invoke-WebRequest`). The runspace also removes these at startup
 * (`executor.ts`), but rejecting them here keeps error messages user-facing
 * and provides defense-in-depth if the runspace hardening is ever weakened.
 */
const dangerousAliases = ["iwr", "irm", "iex", "icm", "curl", "wget", "saps"];

/**
 * Verb-noun cmdlet pattern. Case-insensitive: verbs may be any case ("get-",
 * "Get-", "GET-") so that lowercase obfuscation cannot bypass validation.
 * The verb must be in `knownPsVerbs` for a match to be treated as a cmdlet.
 */
const cmdletPattern = /\b([a-zA-Z]+)-([a-zA-Z][a-zA-Z0-9]+)\b/g;

/** Matches `$env:` in any case. */
const envAccessPattern = /\$env:/i;

/** Matches `.NET` type-member access: `[Type]::Member` or `[Namespace.Type]::Member`. */
const typeMemberPattern = /\[[\w.]+\]\s*::/;

/** Matches reads of the session-private MSAL token variable (defense-in-depth; token is also scrubbed at init). */
const privateVarPattern = /\$_ippsToken\b/i;

/**
 * Matches `$ExecutionContext` — the canonical handle for runtime script execution
 * via `$ExecutionContext.InvokeCommand.InvokeScript('…')`. That call builds a
 * script block from a string at runtime, so the inner command is never visible
 * to the verb-noun or call-operator regex. No legitimate read-only diagnostic
 * command references this automatic variable, so blocking it has zero
 * false-positive cost on the allowed cmdlet set.
 */
const executionContextPattern = /\$ExecutionContext\b/i;

/**
 * Matches a dangerous alias as a standalone token: preceded by start-of-string
 * or an operator/whitespace, followed by whitespace, operator, or end-of-string.
 * Prevents false positives like `Get-IRMConfiguration` (where `IRM` is part of
 * a longer identifier) or `$iwr` (variable reference).
 */
const aliasPattern = new RegExp(`(?:^|[\\s;|&({])(${dangerousAliases.join("|")})(?=[\\s;|&)}]|$)`, "i");

/**
 * Matches the call operator `&` or dot-source operator `.` applied to a
 * parenthesized/computed expression, a variable, or a quoted string — e.g.
 * `& ('Invoke' + '-RestMethod')`, `& $cmd`, `. ('iex')`. This is the canonical
 * way to build a cmdlet name at runtime so the verb-noun token regex never sees
 * it. The operator must sit at a command position (start of string, or after
 * whitespace / `;` `|` `(` `{` `=`), so ordinary property access (`$_.Name`),
 * decimals (`1.5`), and the range operator (`1..10`) are unaffected.
 */
const invocationOperatorPattern = /(?:^|[\s;|({=])[&.]\s*[("'$]/;

export interface ValidationResult {
  valid: boolean;
  violation?: string;
  blockedVerb?: string;
}

/**
 * Validate a PowerShell command string against the allowlist.
 * Returns { valid: true } when safe, or { valid: false, violation } when blocked.
 */
export function validateCommand(command: string): ValidationResult {
  // Block environment variable access ($env:VAR). The pwsh subprocess is
  // started with a minimal env passthrough, but `$env:` access is still
  // rejected to remove any reconnaissance primitive and to block
  // env-substitution-based command injection.
  if (envAccessPattern.test(command)) {
    return {
      valid: false,
      violation: "Access to environment variables ($env:) is not allowed",
      blockedVerb: "env-access",
    };
  }

  // Block .NET type-member access: [Type]::Method() / [Type]::Property.
  // This is the canonical AMSI / allowlist bypass primitive
  // (e.g., [Net.WebClient]::new().DownloadString(...)).
  if (typeMemberPattern.test(command)) {
    return {
      valid: false,
      violation: ".NET type method invocation ([Type]::Member) is not allowed",
      blockedVerb: "type-literal",
    };
  }

  // Block reads of session-private variables. The MSAL access token is
  // scrubbed from the runspace after Connect-IPPSSession, but defense in
  // depth: reject any reference here too.
  if (privateVarPattern.test(command)) {
    return {
      valid: false,
      violation: "Access to session-private variables is not allowed",
      blockedVerb: "private-var",
    };
  }

  // Block `$ExecutionContext` — the canonical handle for
  // `$ExecutionContext.InvokeCommand.InvokeScript('...')`, which builds a
  // script block from a string at runtime and is therefore invisible to the
  // verb-noun and call-operator regexes. Same rationale as the call-operator
  // check below (issue #44): the runspace no longer overrides
  // Invoke-WebRequest / Invoke-RestMethod / Add-Type, so a runtime-constructed
  // call to those primitives must be blocked at Layer 1.
  if (executionContextPattern.test(command)) {
    return {
      valid: false,
      violation: "Access to $ExecutionContext is not allowed",
      blockedVerb: "execution-context",
    };
  }

  // Block high-risk aliases as standalone tokens (iwr, iex, etc.).
  const aliasMatch = command.match(aliasPattern);
  if (aliasMatch) {
    return {
      valid: false,
      violation: `Alias '${aliasMatch[1]}' is not allowed — use the full cmdlet name`,
      blockedVerb: "alias",
    };
  }

  // Block the call/dot-source operators applied to a computed name, variable,
  // or quoted string (e.g. `& ('Invoke' + '-RestMethod')`). This is the
  // runtime-name-construction bypass the verb-noun regex below cannot catch.
  // The runspace no longer overrides Invoke-WebRequest / Invoke-RestMethod /
  // Add-Type (issue #44 — EXO v3 REST proxies need them), so this Layer-1 check
  // is what keeps those obfuscated forms blocked.
  if (invocationOperatorPattern.test(command)) {
    return {
      valid: false,
      violation:
        "Invoking a command via the call/dot-source operator (& or .) on a computed name, variable, or string is not allowed",
      blockedVerb: "call-operator",
    };
  }

  // Validate each verb-noun token (case-insensitive).
  for (const m of command.matchAll(cmdletPattern)) {
    const verbLower = m[1].toLowerCase();

    // Tokens whose verb is not a recognized PowerShell verb are assumed to be
    // hyphenated string fragments (e.g., `mailbox-prod-01` in a parameter
    // value), not cmdlet invocations. Skip them to avoid false positives.
    if (!knownPsVerbs.has(verbLower)) {
      continue;
    }

    const cmdlet = m[0];
    const cmdletLower = `${verbLower}-${m[2].toLowerCase()}`;

    // Check blocked prefixes first (fast-fail)
    for (const prefix of blockedPrefixes) {
      if (cmdletLower.startsWith(prefix)) {
        return {
          valid: false,
          violation: `Blocked cmdlet: ${cmdlet} — ${prefix.charAt(0).toUpperCase() + prefix.slice(1)}* cmdlets are not allowed`,
          blockedVerb: prefix.slice(0, -1),
        };
      }
    }

    // Must be in the explicit allowlist or safe builtins
    if (!allowedCmdlets.has(cmdletLower) && !safeBuiltins.has(cmdletLower)) {
      return {
        valid: false,
        violation: `Unknown cmdlet: ${cmdlet} — not in the allowlist`,
      };
    }
  }

  return { valid: true };
}
