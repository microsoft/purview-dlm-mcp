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
 * Matches a dangerous alias as a standalone token: preceded by start-of-string
 * or an operator/whitespace, followed by whitespace, operator, or end-of-string.
 * Prevents false positives like `Get-IRMConfiguration` (where `IRM` is part of
 * a longer identifier) or `$iwr` (variable reference).
 */
const aliasPattern = new RegExp(`(?:^|[\\s;|&({])(${dangerousAliases.join("|")})(?=[\\s;|&)}]|$)`, "i");

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

  // Block high-risk aliases as standalone tokens (iwr, iex, etc.).
  const aliasMatch = command.match(aliasPattern);
  if (aliasMatch) {
    return {
      valid: false,
      violation: `Alias '${aliasMatch[1]}' is not allowed — use the full cmdlet name`,
      blockedVerb: "alias",
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

/**
 * Parse and validate in the existing PowerShell process, then execute that exact
 * AST. Encoding keeps user text out of the trusted wrapper's PowerShell syntax.
 */
export function buildValidatedCommand(command: string): string {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  const names = [...allowedCmdlets, ...safeBuiltins].map((name) => `'${name}'`).join(",");

  // The parser runs in a child scope; dot-sourcing only the validated result
  // preserves diagnostic variables across execute() calls, not validator state.
  return `. (& {
    $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}'))
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$parseErrors)
    if ($parseErrors.Count) { throw 'Invalid PowerShell syntax' }
    $allowed = @(${names})
    $aliases = @{
      fl = 'format-list'; ft = 'format-table'; select = 'select-object'
      where = 'where-object'; '?' = 'where-object'
      foreach = 'foreach-object'; '%' = 'foreach-object'
      sort = 'sort-object'; group = 'group-object'; measure = 'measure-object'
      gm = 'get-member'; gci = 'get-childitem'; dir = 'get-childitem'; ls = 'get-childitem'
      echo = 'write-output'; write = 'write-output'; tee = 'tee-object'
    }
    $nodeTypes = @(
      'ScriptBlockAst', 'NamedBlockAst', 'StatementBlockAst', 'PipelineAst',
      'CommandAst', 'CommandParameterAst', 'CommandExpressionAst',
      'StringConstantExpressionAst', 'ExpandableStringExpressionAst',
      'ConstantExpressionAst', 'VariableExpressionAst', 'MemberExpressionAst',
      'InvokeMemberExpressionAst', 'BinaryExpressionAst', 'UnaryExpressionAst',
      'ParenExpressionAst', 'SubExpressionAst', 'ArrayExpressionAst',
      'ArrayLiteralAst', 'HashtableAst', 'ScriptBlockExpressionAst',
      'AssignmentStatementAst', 'ConvertExpressionAst', 'TypeConstraintAst',
      'IndexExpressionAst', 'IfStatementAst', 'ForEachStatementAst',
      'BreakStatementAst', 'ContinueStatementAst', 'ReturnStatementAst'
    )
    $reserved = '^(?:_ippsToken|ExecutionContext|Host|Error|MyInvocation|args|input|OFS|OutputEncoding|PSDefaultParameterValues|.*Preference)$'
    foreach ($node in $ast.FindAll({ param($n) $true }, $true)) {
      $kind = $node.GetType().Name
      if ($kind -notin $nodeTypes) { throw "Unsupported PowerShell syntax: $kind" }
      switch ($kind) {
        ScriptBlockAst {
          if ($null -ne $node.ScriptRequirements) { throw 'PowerShell requirements are not allowed' }
        }
        PipelineAst {
          if ($node.Background) { throw 'Background execution is not allowed' }
        }
        CommandAst {
          $name = $node.GetCommandName()
          if ($node.InvocationOperator -ne 'Unknown' -or -not $name) {
            throw 'Dynamic invocation and dot sourcing are not allowed'
          }
          $name = $name.ToLowerInvariant()
          if ($aliases.ContainsKey($name)) {
            $alias = $ExecutionContext.InvokeCommand.GetCommand($name, [System.Management.Automation.CommandTypes]::Alias)
            if ($null -eq $alias -or $alias.ResolvedCommand.Name -ine $aliases[$name]) {
              throw "Alias '$name' is not allowed in this session; use '$($aliases[$name])'"
            }
            $name = $aliases[$name]
          }
          if ($name -notin $allowed) { throw "Unknown cmdlet: $name - not in the allowlist" }
          $elements = @($node.CommandElements | Select-Object -Skip 1)
          if ($name -eq 'get-childitem' -and
              -not ($elements.Count -eq 1 -and
                $elements[0] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                $elements[0].Value -eq 'Env:')) {
            throw 'Get-ChildItem only supports the isolated Env: provider, not session functions or variables'
          }
          if ($name -eq 'foreach-object') {
            foreach ($element in $elements) {
              if ($element -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { continue }
              if ($element -is [System.Management.Automation.Language.CommandParameterAst] -and
                  $element.ParameterName -in @('Begin', 'Process', 'End') -and
                  ($null -eq $element.Argument -or
                   $element.Argument -is [System.Management.Automation.Language.ScriptBlockExpressionAst])) { continue }
              throw 'ForEach-Object requires literal scriptblocks; member invocation is not allowed'
            }
          }
          if ($name -eq 'where-object') {
            $first = $elements[0]
            $literalFilter = $elements.Count -eq 1 -and
              $first -is [System.Management.Automation.Language.ScriptBlockExpressionAst]
            $namedFilter = $first -is [System.Management.Automation.Language.CommandParameterAst] -and
              $first.ParameterName -eq 'FilterScript' -and
              (($elements.Count -eq 2 -and $null -eq $first.Argument -and
                $elements[1] -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) -or
               ($elements.Count -eq 1 -and
                $first.Argument -is [System.Management.Automation.Language.ScriptBlockExpressionAst]))
            $propertyFilter = $first -is [System.Management.Automation.Language.StringConstantExpressionAst]
            foreach ($element in $elements) {
              if ($element -is [System.Management.Automation.Language.CommandParameterAst] -and
                  'FilterScript'.StartsWith($element.ParameterName, [System.StringComparison]::OrdinalIgnoreCase)) {
                $propertyFilter = $false
              }
            }
            if (-not ($literalFilter -or $namedFilter -or $propertyFilter)) {
              throw 'Where-Object requires a literal filter scriptblock or property name'
            }
          }
          if ($name -eq 'tee-object' -and
              -not ($elements.Count -eq 2 -and
                $elements[0] -is [System.Management.Automation.Language.CommandParameterAst] -and
                $elements[0].ParameterName -eq 'Variable' -and $null -eq $elements[0].Argument -and
                $elements[1] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                $elements[1].Value -match '^[a-zA-Z_]\\w*$' -and $elements[1].Value -notmatch $reserved)) {
            throw 'Tee-Object only supports a local diagnostic variable'
          }
        }
        CommandParameterAst {
          foreach ($parameter in @('OutVariable', 'ErrorVariable', 'WarningVariable', 'InformationVariable', 'PipelineVariable')) {
            if ($parameter.StartsWith($node.ParameterName, [System.StringComparison]::OrdinalIgnoreCase) -or
                $node.ParameterName -in @('ov', 'ev', 'wv', 'iv', 'pv')) {
              throw 'Output-variable parameters are not allowed; use a local assignment'
            }
          }
        }
        VariableExpressionAst {
          if ($node.Splatted -or -not $node.VariablePath.IsUnqualified -or
              $node.VariablePath.UserPath -match $reserved) {
            throw 'Scoped, private, session-control and splatted variables are not allowed'
          }
        }
        AssignmentStatementAst {
          if ($node.Left -isnot [System.Management.Automation.Language.VariableExpressionAst]) {
            throw 'Only local diagnostic variable assignments are allowed'
          }
        }
        BinaryExpressionAst {
          # -as converts to any type named by a string and invokes its constructor,
          # e.g. 'path' -as 'System.IO.StreamWriter' creates or truncates a file.
          if ($node.Operator -eq 'As') { throw 'The -as operator is not allowed; use a diagnostic cast such as [string]' }
        }
        UnaryExpressionAst {
          if ($node.TokenKind -match 'PlusPlus|MinusMinus') { throw 'Increment and decrement are not allowed' }
        }
        TypeConstraintAst {
          if ($node.TypeName.FullName -notin @('xml', 'string', 'int', 'long', 'bool', 'double', 'decimal', 'datetime', 'guid', 'pscustomobject')) {
            throw 'Only diagnostic data casts are allowed'
          }
        }
        MemberExpressionAst {
          if ($node.Static -or $node.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {
            throw 'Static and dynamic member access are not allowed'
          }
        }
        InvokeMemberExpressionAst {
          if ($node.Static -or $node.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
              $node.Member.Value -notin @('ToString', 'Split')) {
            throw 'Only diagnostic ToString and Split method calls are allowed'
          }
        }
      }
    }
    $ast.GetScriptBlock()
  })`;
}
