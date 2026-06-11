// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { test, expect, describe } from "vitest";
import {
  HARDENED_COMMAND_OVERRIDES,
  buildHardeningStatements,
  buildMarkedScript,
} from "../../src/powershell/executor.js";

// Regression coverage for issue #44: runspace hardening must not shadow the
// client-side primitives that ExchangeOnlineManagement v3 REST proxies call
// internally, or every Get-*/Test-* cmdlet fails with a misleading
// "server side error" message.

describe("runspace hardening override list (issue #44)", () => {
  // EXO v3 auto-generated proxy functions call these internally when invoking
  // Get-* cmdlets against outlook.office365.com. Overriding them with throwing
  // stubs breaks all EXO/SCC cmdlets.
  const EXO_REST_PRIMITIVES = ["Invoke-WebRequest", "Invoke-RestMethod", "Add-Type"];

  test("does NOT override the primitives EXO v3 REST proxies depend on", () => {
    for (const primitive of EXO_REST_PRIMITIVES) {
      expect(HARDENED_COMMAND_OVERRIDES).not.toContain(primitive);
    }
  });

  test("still overrides dangerous code-execution / process primitives", () => {
    // These are NOT used by EXO REST proxies, so keeping them as throwing
    // stubs preserves Layer-2 defense-in-depth against allowlist bypasses
    // (e.g. string-concat obfuscation the Layer-1 regex misses).
    for (const primitive of ["Invoke-Expression", "Invoke-Command", "Start-Process"]) {
      expect(HARDENED_COMMAND_OVERRIDES).toContain(primitive);
    }
  });

  test("still blocks re-auth / disconnect cmdlets", () => {
    for (const primitive of [
      "Connect-ExchangeOnline",
      "Connect-IPPSSession",
      "Disconnect-ExchangeOnline",
      "Disconnect-IPPSSession",
    ]) {
      expect(HARDENED_COMMAND_OVERRIDES).toContain(primitive);
    }
  });

  test("removes high-risk aliases and stubs each override with a throw", () => {
    const joined = buildHardeningStatements().join("\n");
    expect(joined).toContain("Remove-Item Alias:iwr");
    for (const primitive of HARDENED_COMMAND_OVERRIDES) {
      expect(joined).toContain(`function global:${primitive} { throw`);
    }
  });
});

describe("execRaw marker script — non-terminating error surfacing (issue #44)", () => {
  test("forces ErrorActionPreference=Stop for user commands so EXO Write-Error surfaces", () => {
    const script = buildMarkedScript("Get-OrganizationConfig", "MARK_END", true);
    // Non-terminating errors must be promoted so they reach the catch block.
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    // The user command is still executed inside the try.
    expect(script).toContain("Get-OrganizationConfig");
    // Failures are routed through the PS_ERROR sentinel that execute() parses.
    expect(script).toContain("PS_ERROR:");
    // The end marker still terminates the output the poller waits for.
    expect(script).toContain("MARK_END");
  });

  test("leaves internal/init commands unchanged (no forced Stop)", () => {
    // Init steps (e.g. `$_ippsToken = ...`, Connect-*) run at top scope and
    // must not have their error semantics altered, so stopOnError defaults off.
    const script = buildMarkedScript("$x = 1", "MARK_END");
    expect(script).not.toContain("$ErrorActionPreference");
    expect(script).toContain("$x = 1");
    expect(script).toContain("MARK_END");
  });
});
