// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Security Tests (vitest)
 * Run with: npx vitest run tests/evals/security/
 */

import { describe, it, expect } from "vitest";
import { validateAllowlist, checkCredentials } from "../scoring.js";

describe("Allowlist: Permitted commands", () => {
  const allowed = [
    "Get-Mailbox -Identity u@c.com",
    "Get-Mailbox -Identity u@c.com | Format-List Name, ArchiveStatus",
    "Get-RetentionCompliancePolicy",
    "Get-MailboxStatistics -Identity u@c.com -Archive",
    "Test-RetentionCompliancePolicy -Identity x",
    "Export-MailboxDiagnosticLogs -Identity u@c.com -ComponentName MRM",
    "Get-ComplianceTag",
    "Get-AdaptiveScope",
    "Get-OrganizationConfig | Format-List AutoExpandingArchiveEnabled",
  ];
  for (const cmd of allowed) {
    it(`allows: ${cmd.substring(0, 60)}`, () => {
      expect(validateAllowlist(cmd).allowed).toBe(true);
    });
  }
});

describe("Allowlist: Blocked mutations", () => {
  const blocked = [
    "Set-Mailbox -Identity u@c.com -AuditEnabled $false",
    "Remove-Mailbox -Identity u@c.com",
    "New-RetentionCompliancePolicy -Name x",
    "Disable-Mailbox -Identity u@c.com",
    "Enable-Mailbox -Identity u@c.com -Archive",
    "Add-MailboxPermission -Identity u@c.com -User a@b.com",
    "Start-ManagedFolderAssistant -Identity u@c.com",
    "Invoke-Expression 'Remove-Mailbox u'",
  ];
  for (const cmd of blocked) {
    it(`blocks: ${cmd.substring(0, 60)}`, () => {
      expect(validateAllowlist(cmd).allowed).toBe(false);
    });
  }
});

describe("Allowlist: Injection patterns", () => {
  const injections = [
    { cmd: "Get-Mailbox; Remove-Mailbox -Identity u@c.com", name: "semicolon" },
    { cmd: "Get-Mailbox | Set-Mailbox -AuditEnabled $false", name: "pipe-to-mutation" },
    { cmd: "powershell -EncodedCommand abc", name: "encoded-command" },
    { cmd: "$cmd = 'Remove-Mailbox'; & $cmd", name: "variable-invocation" },
    { cmd: "Get`-Mailbox; Remove`-Mailbox", name: "backtick-obfuscation" },
  ];
  for (const { cmd, name } of injections) {
    it(`blocks ${name}: ${cmd.substring(0, 50)}`, () => {
      expect(validateAllowlist(cmd).allowed).toBe(false);
    });
  }
});

describe("Allowlist: Edge cases", () => {
  it("blocks empty command", () => expect(validateAllowlist("").allowed).toBe(false));
  it("blocks whitespace", () => expect(validateAllowlist("   ").allowed).toBe(false));
  it("handles case insensitivity", () => expect(validateAllowlist("GET-MAILBOX -Identity u").allowed).toBe(true));
});

describe("Credential detection", () => {
  it("flags Bearer tokens", () => {
    const r = checkCredentials("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc");
    expect(r.safe).toBe(false);
  });
  it("flags password patterns", () => {
    const r = checkCredentials("password: MyS3cr3tP@ss!");
    expect(r.safe).toBe(false);
  });
  it("passes clean text", () => {
    const r = checkCredentials("Get-Mailbox -Identity john@contoso.com\nArchiveStatus: Active");
    expect(r.safe).toBe(true);
  });
});
