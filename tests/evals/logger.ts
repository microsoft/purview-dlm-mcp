// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Eval Logger
 *
 * Structured logging with verbosity levels for detailed diagnostics.
 *
 * Levels:
 *   0 = silent   — nothing
 *   1 = summary  — scenario pass/fail, final scores
 *   2 = steps    — each tool call, judge invocation, score breakdown
 *   3 = trace    — full PS output, judge prompts, raw API responses
 *
 * All log entries are also collected in an array for post-run export.
 */

export type LogLevel = 0 | 1 | 2 | 3;

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  0: "SILENT",
  1: "INFO",
  2: "STEP",
  3: "TRACE",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  0: "",
  1: "\x1b[36m",  // cyan
  2: "\x1b[33m",  // yellow
  3: "\x1b[90m",  // gray
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

export class EvalLogger {
  private level: LogLevel;
  private entries: LogEntry[] = [];
  private startTime = Date.now();

  constructor(level: LogLevel = 2) {
    this.level = level;
  }

  // ─── Core logging ───────────────────────────────────────────────────

  private log(lvl: LogLevel, category: string, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: lvl,
      category,
      message,
      data,
    };
    this.entries.push(entry);

    if (this.level >= lvl && lvl > 0) {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      const color = LEVEL_COLORS[lvl];
      const label = LEVEL_LABELS[lvl].padEnd(5);
      console.log(
        `${DIM}[${elapsed}s]${RESET} ${color}${label}${RESET} ${DIM}[${category}]${RESET} ${message}`
      );
      if (data && this.level >= 3) {
        console.log(`${DIM}       └─ ${JSON.stringify(data, null, 2).split("\n").join("\n          ")}${RESET}`);
      }
    }
  }

  // ─── Convenience: level-1 info log ─────────────────────────────────

  log1(msg: string): void {
    this.log(1, "info", msg);
  }

  // ─── Semantic methods ───────────────────────────────────────────────

  /** Level 1: High-level scenario lifecycle */
  scenarioStart(id: string, tsg: string, difficulty: string): void {
    this.log(1, "scenario", `${BOLD}▶ ${id}${RESET} (${tsg}, ${difficulty})`);
  }

  scenarioPass(id: string, toolScore: number, diagScore: number, durationMs: number): void {
    this.log(1, "scenario",
      `${GREEN}✅ PASS${RESET} ${id} — tool: ${this.pct(toolScore)} | diag: ${this.pct(diagScore)} | ${durationMs}ms`
    );
  }

  scenarioFail(id: string, toolScore: number, diagScore: number, reason: string): void {
    this.log(1, "scenario",
      `${RED}❌ FAIL${RESET} ${id} — tool: ${this.pct(toolScore)} | diag: ${this.pct(diagScore)} | ${reason}`
    );
  }

  /** Level 2: Individual steps within a scenario */
  toolCall(step: number, tool: string, command: string): void {
    this.log(2, "tool-call", `  Step ${step}: [${tool}] ${command.substring(0, 100)}`);
  }

  toolResult(step: number, matched: boolean, output: string): void {
    const status = matched ? `${GREEN}matched${RESET}` : `${RED}no-match${RESET}`;
    this.log(2, "tool-result", `  Step ${step}: ${status} — ${output.substring(0, 120)}...`);
  }

  judgeStart(shuffleRun: number, totalRuns: number): void {
    this.log(2, "judge", `  Judge run ${shuffleRun}/${totalRuns}...`);
  }

  judgeScore(dimension: string, score: number): void {
    this.log(2, "judge", `  ${dimension}: ${this.pct(score)}`);
  }

  scoreBreakdown(label: string, scores: Record<string, number>): void {
    const parts = Object.entries(scores).map(([k, v]) => `${k}=${this.pct(v)}`).join(", ");
    this.log(2, "score", `  ${label}: ${parts}`);
  }

  /** Level 3: Full trace data */
  traceFixtureLoad(path: string, commandCount: number): void {
    this.log(3, "fixture", `Loaded ${commandCount} commands from ${path}`);
  }

  traceJudgePrompt(prompt: string): void {
    this.log(3, "judge-prompt", `Judge prompt (${prompt.length} chars):\n${prompt.substring(0, 500)}...`);
  }

  traceJudgeResponse(raw: string): void {
    this.log(3, "judge-response", `Judge response:\n${raw.substring(0, 500)}...`);
  }

  tracePsOutput(command: string, output: string): void {
    this.log(3, "ps-output", `Command: ${command}\nOutput:\n${output}`);
  }

  /** Level 2: Security test results */
  securityTest(name: string, passed: boolean, details: string): void {
    const status = passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    this.log(2, "security", `  ${status} ${name}: ${details}`);
  }

  /** Level 1: Section headers */
  section(title: string): void {
    this.log(1, "section", `\n${BOLD}═══ ${title} ═══${RESET}`);
  }

  /** Level 1: Warnings */
  warn(message: string): void {
    this.log(1, "warn", `\x1b[33m⚠ ${message}${RESET}`);
  }

  /** Level 1: Errors */
  error(message: string, err?: unknown): void {
    this.log(1, "error", `${RED}✖ ${message}${RESET}`, err ? { error: String(err) } : undefined);
  }

  // ─── Export ─────────────────────────────────────────────────────────

  /** Get all log entries for writing to file */
  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  /** Export log as JSON Lines */
  toJSONL(): string {
    return this.entries.map((e) => JSON.stringify(e)).join("\n");
  }

  /** Export log as human-readable text */
  toText(): string {
    return this.entries
      .filter((e) => e.level > 0)
      .map((e) => `[${e.timestamp}] [${LEVEL_LABELS[e.level]}] [${e.category}] ${e.message}`)
      .join("\n");
  }

  // ─── Util ──────────────────────────────────────────────────────────

  private pct(v: number): string {
    return `${(v * 100).toFixed(1)}%`;
  }
}
