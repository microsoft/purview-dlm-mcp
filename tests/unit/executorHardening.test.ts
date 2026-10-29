// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { PsExecutor } from "../../src/powershell/executor.js";

interface ExecutorInternals {
  proc: ChildProcess | null;
  ready: boolean;
  buf: string;
  execRaw(command: string, timeoutMs?: number): Promise<string>;
  hardenRunspace(): Promise<void>;
}

/** Attach a bare pwsh process to an executor, skipping EXO auth and connect. */
function startSession(): { executor: PsExecutor; internals: ExecutorInternals; proc: ChildProcess } {
  const executor = new PsExecutor();
  const internals = executor as unknown as ExecutorInternals;
  const proc = spawn("pwsh", ["-NoExit", "-NoProfile", "-Command", "-"], { stdio: ["pipe", "pipe", "pipe"] });
  proc.stdout!.on("data", (d: Buffer) => {
    internals.buf += d.toString();
  });
  internals.proc = proc;
  internals.ready = true;
  return { executor, internals, proc };
}

let session: ReturnType<typeof startSession> | undefined;
afterEach(async () => {
  await session?.executor.shutdown();
  session = undefined;
});

describe("PsExecutor timeout", () => {
  test("kills the session on timeout so late output cannot leak into later commands", async () => {
    session = startSession();
    const { executor, internals, proc } = session;

    const exited = new Promise((resolve) => proc.on("exit", resolve));
    await expect(internals.execRaw("Start-Sleep -Seconds 30; Write-Output late", 1_000)).rejects.toThrow(
      /timed out after 1000ms.*Restart the MCP server/,
    );
    await exited;

    expect(executor.isReady).toBe(false);
    expect(internals.proc).toBeNull();
    const result = await executor.execute("Get-Mailbox");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Restart the MCP server");
  }, 20_000);
});

describe("PsExecutor runspace hardening", () => {
  // These run through execRaw, which skips the AST guard, to prove the
  // hardened session blocks the MSRC report's primitives on its own.
  test("blocks native executables, child pwsh, and removed aliases even without the AST guard", async () => {
    session = startSession();
    const { internals } = session;
    await internals.hardenRunspace();

    for (const command of ["whoami", "pwsh -NoProfile -Command 1", "cmd /c ver"]) {
      expect(await internals.execRaw(command)).toMatch(/^PS_ERROR: .*not recognized/);
    }
    for (const alias of ["gc", "cat", "ni", "cp", "del", "ri", "iex", "h", "r", "gcb", "gin", "scb"]) {
      expect(await internals.execRaw(`Get-Alias -Name '${alias}' -ErrorAction SilentlyContinue`)).toBe("");
    }
    expect(await internals.execRaw("Invoke-Expression 'whoami'")).toContain("Disabled by Purview DLM MCP");
  }, 30_000);

  test("keeps cmdlets and the guard's mapped aliases working", async () => {
    session = startSession();
    const { internals } = session;
    await internals.hardenRunspace();

    expect(await internals.execRaw("Get-Date -Year 2026 -Format yyyy")).toBe("2026");
    expect(await internals.execRaw("@(3, 1, 2) | sort | select -First 1")).toBe("1");
    expect(await internals.execRaw("(Get-Alias -Name fl).ResolvedCommand.Name")).toBe("Format-List");

    // The AST guard itself runs inside the hardened session.
    const { executor } = session;
    expect(await executor.execute("Get-Date -Year 2026 -Format yyyy | Where-Object { $_ -eq '2026' }")).toMatchObject({
      success: true,
      output: "2026",
    });
    expect(await executor.execute("Get-Date; whoami")).toMatchObject({
      success: false,
      error: expect.stringContaining("not in the allowlist"),
    });
  }, 30_000);
});
