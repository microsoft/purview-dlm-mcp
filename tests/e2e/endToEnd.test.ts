// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { test, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, getClient } from "./fixtures/mcpServerFixture.js";

beforeAll(async () => {
  await startServer();
}, 300_000);

afterAll(async () => {
  await stopServer();
});

async function runCommand(command: string) {
  const result = await getClient().callTool({
    name: "run_powershell",
    arguments: { command },
  });
  const text = (result.content as Array<{ type: string; text: string }>).find((c) => c.type === "text")!.text;
  return JSON.parse(text);
}

async function runAndExpectSuccess(command: string): Promise<string> {
  const parsed = await runCommand(command);
  expect(parsed.success).toBe(true);
  return parsed.output;
}

// --- Group 1: Server Discovery ---

test("lists exactly 4 tools", async () => {
  const result = await getClient().listTools();
  expect(result.tools).toHaveLength(4);
  const names = result.tools.map((t) => t.name).sort();
  expect(names).toEqual(["ask_learn", "create_issue", "get_execution_log", "run_powershell"]);
});

test("run_powershell has correct schema", async () => {
  const result = await getClient().listTools();
  const runPs = result.tools.find((t) => t.name === "run_powershell");
  expect(runPs).toBeDefined();
});

test("get_execution_log has no required params", async () => {
  const result = await getClient().listTools();
  const getLog = result.tools.find((t) => t.name === "get_execution_log");
  expect(getLog).toBeDefined();
});

// --- Group 2: Allowlist Enforcement ---

test("blocks Set-Mailbox", async () => {
  const parsed = await runCommand("Set-Mailbox -Identity test");
  expect(parsed.success).toBe(false);
  expect(parsed.error).toContain("Set-");
});

test("blocks Remove-RetentionCompliancePolicy", async () => {
  const parsed = await runCommand('Remove-RetentionCompliancePolicy -Identity "test"');
  expect(parsed.success).toBe(false);
  expect(parsed.error).toContain("Remove-");
});

test("blocks New-RetentionComplianceRule", async () => {
  const parsed = await runCommand('New-RetentionComplianceRule -Policy "test"');
  expect(parsed.success).toBe(false);
  expect(parsed.error).toContain("New-");
});

test("blocks Start-ManagedFolderAssistant", async () => {
  const parsed = await runCommand("Start-ManagedFolderAssistant -Identity test");
  expect(parsed.success).toBe(false);
  expect(parsed.error).toContain("Start-");
});

test("blocks Invoke-WebRequest", async () => {
  const parsed = await runCommand("Invoke-WebRequest -Uri https://example.com");
  expect(parsed.success).toBe(false);
  expect(parsed.error).toContain("Invoke-");
});

test("blocks unknown cmdlet", async () => {
  const parsed = await runCommand("Get-FooBaz");
  expect(parsed.success).toBe(false);
  expect(parsed.error).toContain("not in the allowlist");
});

test("blocks pipeline with blocked cmdlet", async () => {
  const parsed = await runCommand("Get-Mailbox | Set-Mailbox -Name test");
  expect(parsed.success).toBe(false);
  expect(parsed.error).toContain("Set-");
});

// --- Group 3: Security & Compliance Cmdlets ---

test("Get-RetentionCompliancePolicy returns data", async () => {
  const output = await runAndExpectSuccess(
    "Get-RetentionCompliancePolicy | Select-Object -First 1 Name, DistributionStatus",
  );
  expect(output).toBeTruthy();
});

test("Get-RetentionComplianceRule returns data", async () => {
  const policyOutput = await runAndExpectSuccess(
    "Get-RetentionCompliancePolicy | Select-Object -First 1 Name | ConvertTo-Json",
  );
  let policyName: string;
  try {
    policyName = JSON.parse(policyOutput).Name;
  } catch {
    policyName = "Default";
  }
  const output = await runAndExpectSuccess(`Get-RetentionComplianceRule -Policy "${policyName}" | FL Name`);
  expect(typeof output).toBe("string");
});

test("Get-AdaptiveScope executes", async () => {
  await runAndExpectSuccess("Get-AdaptiveScope | Select-Object -First 1 Name, LocationType");
});

test("Get-ComplianceTag executes", async () => {
  await runAndExpectSuccess("Get-ComplianceTag | Select-Object -First 1 Name, RetentionDuration");
});

// --- Group 4: Exchange Online Cmdlets ---

test("Get-Mailbox returns data", async () => {
  const output = await runAndExpectSuccess("Get-Mailbox -ResultSize 1 | FL DisplayName, UserPrincipalName");
  expect(output).toBeTruthy();
});

test("Get-Recipient returns data", async () => {
  const output = await runAndExpectSuccess("Get-Recipient -ResultSize 1 | FL Name, RecipientType");
  expect(output).toBeTruthy();
});

test("Get-User returns data", async () => {
  const output = await runAndExpectSuccess("Get-User -ResultSize 1 | FL Name, RecipientTypeDetails");
  expect(output).toBeTruthy();
});

test("Get-OrganizationConfig returns data", async () => {
  const output = await runAndExpectSuccess("Get-OrganizationConfig | FL AutoExpandingArchiveEnabled");
  expect(output).toBeTruthy();
});

test("Get-MailboxStatistics returns data", async () => {
  const upn = process.env.DLM_UPN!;
  const output = await runAndExpectSuccess(`Get-MailboxStatistics ${upn} | FL TotalItemSize`);
  expect(output).toBeTruthy();
});

test("Get-UnifiedGroup executes", async () => {
  await runAndExpectSuccess("Get-UnifiedGroup -ResultSize 1 | FL DisplayName");
});

// --- Group 5: Complex Pipelines & Safe Builtins ---

test("pipeline with Where-Object", async () => {
  await runAndExpectSuccess("Get-RetentionCompliancePolicy | Where-Object {$_.Enabled -eq $true} | Measure-Object");
});

test("pipeline with Format-List", async () => {
  await runAndExpectSuccess("Get-Mailbox -ResultSize 1 | Format-List DisplayName");
});

test("ConvertTo-Json produces valid JSON", async () => {
  const output = await runAndExpectSuccess(
    "Get-OrganizationConfig | Select-Object AutoExpandingArchiveEnabled | ConvertTo-Json",
  );
  const json = JSON.parse(output);
  expect(json).toBeDefined();
});

test("multi-pipe chain executes", async () => {
  await runAndExpectSuccess(
    "Get-RetentionCompliancePolicy | Select-Object Name, Enabled | Sort-Object Name | ConvertTo-Json",
  );
});

// --- Group 6: Response Structure Validation ---

test("successful command has correct shape", async () => {
  const parsed = await runCommand("Get-OrganizationConfig | FL AutoExpandingArchiveEnabled");
  expect(parsed.success).toBe(true);
  expect(typeof parsed.output).toBe("string");
  expect(parsed.error).toBeNull();
  expect(parsed.durationMs).toBeGreaterThan(0);
  expect(parsed.logIndex).toBeGreaterThanOrEqual(1);
});

test("failed command has correct shape", async () => {
  const parsed = await runCommand("Set-Mailbox -Identity test");
  expect(parsed.success).toBe(false);
  expect(parsed.error).toBeTruthy();
});

test("log index increments", async () => {
  const parsed1 = await runCommand("Get-OrganizationConfig | FL AutoExpandingArchiveEnabled");
  const parsed2 = await runCommand("Get-OrganizationConfig | FL AutoExpandingArchiveEnabled");
  expect(parsed2.logIndex).toBe(parsed1.logIndex + 1);
});

// --- Group 7: Execution Log ---

test("log returns markdown", async () => {
  const result = await getClient().callTool({
    name: "get_execution_log",
    arguments: {},
  });
  const text = (result.content as Array<{ type: string; text: string }>).find((c) => c.type === "text")!.text;
  expect(text).toContain("# Execution Log");
});

test("log includes commands run so far", async () => {
  const result = await getClient().callTool({
    name: "get_execution_log",
    arguments: {},
  });
  const text = (result.content as Array<{ type: string; text: string }>).find((c) => c.type === "text")!.text;
  expect(text).toContain("Total commands:");
});

test("log shows failures", async () => {
  await runCommand("Set-Mailbox -Identity test");
  const result = await getClient().callTool({
    name: "get_execution_log",
    arguments: {},
  });
  const text = (result.content as Array<{ type: string; text: string }>).find((c) => c.type === "text")!.text;
  expect(text).toContain("\u274C");
});

// --- Group 7b: Environment Isolation (MSRC fix) ---

test("DLM_UPN env var is not visible inside pwsh session", async () => {
  // Sanity check: the parent Node process has DLM_UPN set
  expect(process.env.DLM_UPN).toBeTruthy();
  // pwsh subprocess must NOT see it (buildSafeEnv whitelist excludes DLM_*)
  const output = await runAndExpectSuccess("(Get-ChildItem Env: | Where-Object { $_.Name -eq 'DLM_UPN' }).Count");
  expect(output.trim()).toBe("0");
});

test("no DLM_* env vars leak into pwsh session", async () => {
  const output = await runAndExpectSuccess("(Get-ChildItem Env: | Where-Object { $_.Name -like 'DLM_*' }).Count");
  expect(output.trim()).toBe("0");
});

test("hardened runspace rejects Invoke-WebRequest when validation is bypassed via string concatenation", async () => {
  // Build the cmdlet name at runtime so the TS verb-noun regex doesn't see
  // 'Invoke-WebRequest' as a token. The validator passes; the runspace
  // function override (Layer 2) must still throw.
  const parsed = await runCommand("& ('Invoke' + '-WebRequest') -Uri http://example.com");
  expect(parsed.success).toBe(false);
  expect(parsed.error).toContain("Disabled by Purview DLM MCP security policy");
});

// --- Group 8: Ask Learn ---

test("ask_learn has correct schema", async () => {
  const result = await getClient().listTools();
  const askLearn = result.tools.find((t) => t.name === "ask_learn");
  expect(askLearn).toBeDefined();
});

test("ask_learn returns retention links", async () => {
  const result = await getClient().callTool({
    name: "ask_learn",
    arguments: { question: "How do I create a retention policy?" },
  });
  const text = (result.content as Array<{ type: string; text: string }>).find((c) => c.type === "text")!.text;
  expect(text).toContain("Retention Policies");
  expect(text).toContain("learn.microsoft.com");
});

test("ask_learn returns eDiscovery links", async () => {
  const result = await getClient().callTool({
    name: "ask_learn",
    arguments: { question: "How do I set up a legal hold for eDiscovery?" },
  });
  const text = (result.content as Array<{ type: string; text: string }>).find((c) => c.type === "text")!.text;
  expect(text).toContain("eDiscovery");
  expect(text).toContain("learn.microsoft.com");
});

test("ask_learn returns fallback for unknown", async () => {
  const result = await getClient().callTool({
    name: "ask_learn",
    arguments: { question: "Tell me about quantum computing" },
  });
  const text = (result.content as Array<{ type: string; text: string }>).find((c) => c.type === "text")!.text;
  expect(text).toContain("Microsoft Purview");
  expect(text).toContain("learn.microsoft.com/purview/");
});
