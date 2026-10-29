// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, test, expect } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { PsExecutor } from "../../src/powershell/executor.js";

interface ExecutorInternals {
  proc: ChildProcess | null;
  ready: boolean;
  execRaw(command: string, timeoutMs?: number): Promise<string>;
}

describe("PsExecutor timeout", () => {
  test("kills the session on timeout so late output cannot leak into later commands", async () => {
    const executor = new PsExecutor();
    const internals = executor as unknown as ExecutorInternals;
    const proc = spawn("pwsh", ["-NoExit", "-NoProfile", "-Command", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    proc.stdout!.on("data", (d: Buffer) => {
      (executor as unknown as { buf: string }).buf += d.toString();
    });
    internals.proc = proc;
    internals.ready = true;

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
