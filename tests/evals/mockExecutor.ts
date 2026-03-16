// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Mock PowerShell Executor
 *
 * Intercepts run_powershell calls and returns pre-recorded fixture outputs.
 * Integrates with EvalLogger for detailed tracing.
 *
 * Plugs into the MCP server by replacing the real executor at test time.
 * The server's src/powershell/executor.ts exports a class — this mock
 * implements the same execute(command) interface.
 */

import * as fs from "node:fs";
import type { CommandFixture, FixtureSet, AgentTraceEntry } from "./types.js";
import type { EvalLogger } from "./logger.js";

export interface MockExecutorOptions {
  fixturePath: string;
  logger?: EvalLogger;
  /** Return this when no fixture matches */
  defaultOutput?: string;
  defaultExitCode?: number;
}

export class MockPowerShellExecutor {
  private fixtures: CommandFixture[] = [];
  private trace: AgentTraceEntry[] = [];
  private step = 0;
  private logger?: EvalLogger;
  private defaultOutput: string;
  private defaultExitCode: number;

  constructor(opts: MockExecutorOptions) {
    this.logger = opts.logger;
    this.defaultOutput = opts.defaultOutput ?? "WARNING: No fixture matched this command.";
    this.defaultExitCode = opts.defaultExitCode ?? 1;
    this.loadFixtures(opts.fixturePath);
  }

  private loadFixtures(filePath: string): void {
    const raw = fs.readFileSync(filePath, "utf-8");
    const set: FixtureSet = JSON.parse(raw);
    this.fixtures = set.commands;
    this.logger?.traceFixtureLoad(filePath, this.fixtures.length);
  }

  /**
   * Execute a command against fixtures. Same signature as the real executor.
   */
  async execute(command: string): Promise<{ output: string; exitCode: number }> {
    this.step++;
    const start = Date.now();
    this.logger?.toolCall(this.step, "run_powershell", command);

    const fixture = this.findFixture(command);
    const matched = !!fixture;
    const output = fixture?.output ?? this.defaultOutput;
    const exitCode = fixture?.exit_code ?? this.defaultExitCode;

    this.logger?.toolResult(this.step, matched, output);
    if (!matched) {
      this.logger?.warn(`No fixture matched: ${command}`);
    }
    this.logger?.tracePsOutput(command, output);

    const entry: AgentTraceEntry = {
      step: this.step,
      tool: "run_powershell",
      input: { command },
      output,
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - start,
    };
    this.trace.push(entry);

    return { output, exitCode };
  }

  getTrace(): AgentTraceEntry[] {
    return [...this.trace];
  }

  reset(): void {
    this.trace = [];
    this.step = 0;
  }

  // ─── Fixture matching ───────────────────────────────────────────────

  private findFixture(command: string): CommandFixture | undefined {
    const norm = this.normalize(command);

    // 1. Exact match
    const exact = this.fixtures.find((f) => this.normalize(f.command) === norm);
    if (exact) return exact;

    // 2. Regex pattern
    const pattern = this.fixtures.find((f) => {
      if (!f.command_pattern) return false;
      try { return new RegExp(f.command_pattern, "i").test(command); }
      catch { return false; }
    });
    if (pattern) return pattern;

    // 3. Fuzzy: same primary cmdlet and >40% param overlap (recall-based)
    const cmdlet = norm.split(/[\s|]/)[0];
    const fuzzy = this.fixtures.find((f) => {
      const fc = this.normalize(f.command).split(/[\s|]/)[0];
      return fc === cmdlet && this.paramOverlap(norm, this.normalize(f.command)) > 0.25;
    });
    return fuzzy;
  }

  private static readonly CMDLET_ALIASES: Record<string, string> = {
    "get-exomailbox": "get-mailbox",
    "get-exomailboxstatistics": "get-mailboxstatistics",
    "get-exomailboxfolderstatistics": "get-mailboxfolderstatistics",
    "get-exorecipient": "get-recipient",
  };

  private normalize(cmd: string): string {
    let n = cmd
      .replace(/\s+/g, " ").trim().toLowerCase()
      // Strip quotes around parameter values
      .replace(/"([^"]+)"/g, "$1")
      .replace(/'([^']+)'/g, "$1")
      // Alias expansions — treat Select-Object / Format-Table same as Format-List
      .replace(/\|\s*fl\b/g, "| format-list")
      .replace(/\|\s*ft\b/g, "| format-list")
      .replace(/\|\s*select-object\b/g, "| format-list")
      .replace(/\|\s*select\b(?!\s*-)/g, "| format-list")
      .replace(/\|\s*format-table\b/g, "| format-list")
      // Strip noise parameters agents add
      .replace(/-resultsize\s+\S+/g, "")
      .replace(/-autosize\b/g, "")
      // Strip -Filter values (agents often add custom filters)
      .replace(/-filter\s+(?:"[^"]*"|'[^']*'|\S+)/gi, "")
      // Strip trailing sort/select chains
      .replace(/\|\s*sort-object\b.*$/g, "")
      // Cleanup
      .replace(/\s+/g, " ").trim();

    // Resolve cmdlet aliases
    const primaryCmdlet = n.split(/[\s|]/)[0];
    const resolved = MockPowerShellExecutor.CMDLET_ALIASES[primaryCmdlet];
    if (resolved) {
      n = resolved + n.slice(primaryCmdlet.length);
    }

    return n;
  }

  private paramOverlap(agentCmd: string, fixtureCmd: string): number {
    // Extract params after the first cmdlet (skip the cmdlet name itself which contains hyphens)
    const extractParams = (cmd: string): Set<string> => {
      const afterCmdlet = cmd.replace(/^\S+\s*/, ""); // strip leading cmdlet
      return new Set((afterCmdlet.match(/-\w+/g) ?? []).map((p) => p.toLowerCase()));
    };
    const ap = extractParams(agentCmd);
    const fp = extractParams(fixtureCmd);
    if (fp.size === 0) return 1;
    const inter = [...fp].filter((x) => ap.has(x));
    return inter.length / fp.size;
  }
}
