#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/**
 * Purview DLM MCP — Eval Runner
 *
 * Usage:
 *   npx tsx tests/evals/runner.ts                          # run all layers
 *   npx tsx tests/evals/runner.ts --layer tool-selection    # specific layer
 *   npx tsx tests/evals/runner.ts --tsg auto-expanding-archive --log-level 3
 *   npx tsx tests/evals/runner.ts --report markdown --out eval-report.md
 *   npx tsx tests/evals/runner.ts --judge-model claude-sonnet-4.6 --byok anthropic
 *   npx tsx tests/evals/runner.ts --mode agent --agent-model claude-sonnet-4-6
 *
 * Environment:
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY  — for direct API judge (fallback)
 *   Copilot CLI authenticated           — for Copilot SDK judge (default)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EvalLogger } from "./logger.js";
import { CopilotJudge, DirectAPIJudge } from "./judge.js";
import { MockPowerShellExecutor } from "./mockExecutor.js";
import { deterministicToolScore, validateAllowlist, checkCredentials } from "./scoring.js";
import { loadScenarios, reportConsole, reportMarkdown, reportJSON } from "./scenarioLoader.js";
import type {
  EvalConfig, EvalResult, EvalReport, EvalLayer, EvalScenario,
  JudgeProvider, Difficulty, SecurityScore, AgentTraceEntry, ToolSelectionScore,
  AgentMode,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CLI arg parsing ────────────────────────────────────────────────────────

function parseArgs(): Partial<EvalConfig> {
  const args = process.argv.slice(2);
  const config: Partial<EvalConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--layer":        config.layers = (config.layers ?? []).concat(args[++i] as EvalLayer); break;
      case "--tsg":          config.tsg_filter = (config.tsg_filter ?? []).concat(args[++i]); break;
      case "--difficulty":   config.difficulty_filter = (config.difficulty_filter ?? []).concat(args[++i] as Difficulty); break;
      case "--max":          config.max_scenarios = parseInt(args[++i]); break;
      case "--report":       config.report_format = args[++i] as "console" | "markdown" | "json"; break;
      case "--out":          config.report_path = args[++i]; break;
      case "--log-level":    config.log_level = parseInt(args[++i]) as 0 | 1 | 2 | 3; break;
      case "--judge-model":  config.judge_model = args[++i]; break;
      case "--shuffle":      config.judge_shuffle_count = parseInt(args[++i]); break;
      case "--mode":         config.mode = args[++i] as AgentMode; break;
      case "--agent-model":  config.agent_model = args[++i]; break;
      case "--max-turns":    config.agent_max_turns = parseInt(args[++i]); break;
      case "--agent-timeout": config.agent_timeout = parseInt(args[++i]); break;
      case "--byok": {
        const provider = args[++i] as "openai" | "anthropic";
        config.byok = { type: provider, apiKey: process.env[provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"] };
        break;
      }
    }
  }
  return config;
}

function resolveConfig(overrides: Partial<EvalConfig>): EvalConfig {
  return {
    judge_model: "claude-opus-4-6",
    judge_shuffle_count: 3,
    layers: ["tool-selection", "diagnostic-accuracy", "security"],
    report_format: "console",
    log_level: 2,
    scenarios_dir: path.join(__dirname, "scenarios"),
    fixtures_dir: path.join(__dirname, "fixtures"),
    ...overrides,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const config = resolveConfig(parseArgs());
  const logger = new EvalLogger(config.log_level);

  logger.section("Purview DLM MCP Eval Framework");
  logger.log1(`Config: model=${config.judge_model}, shuffle=${config.judge_shuffle_count}, layers=${config.layers.join(",")}, mode=${config.mode ?? "deterministic"}`);

  // Load scenarios
  const scenarios = loadScenarios({
    scenariosDir: config.scenarios_dir,
    fixturesDir: config.fixtures_dir,
    tsgFilter: config.tsg_filter,
    difficultyFilter: config.difficulty_filter,
    maxScenarios: config.max_scenarios,
  });

  if (scenarios.length === 0) {
    logger.warn("No scenarios found. Check --tsg / --difficulty filters or scenarios_dir.");
    process.exit(1);
  }
  logger.log1(`Loaded ${scenarios.length} scenarios`);

  // Create judge — always use CopilotJudge as the primary path
  let judge: JudgeProvider | null = null;
  if (config.layers.includes("diagnostic-accuracy")) {
    try {
      if (config.byok) {
        logger.log1(`Using Direct API judge (${config.byok.type})`);
        judge = new DirectAPIJudge({
          provider: config.byok.type as "openai" | "anthropic",
          model: config.judge_model,
          shuffleCount: config.judge_shuffle_count,
          logger,
        });
      } else {
        logger.log1("Using Copilot SDK judge");
        judge = new CopilotJudge({
          model: config.judge_model,
          shuffleCount: config.judge_shuffle_count,
          logger,
        });
      }
    } catch (err) {
      logger.error(`Failed to create judge: ${err}`);
      logger.error("diagnostic-accuracy layer requires a working LLM judge. Set COPILOT_GITHUB_TOKEN or use --byok.");
      process.exit(2);
    }
  }

  // Create agent runner if in agent mode
  let agentRunner: import("./agentRunner.js").AgentRunner | null = null;
  if (config.mode === "agent") {
    const model = config.agent_model ?? "claude-sonnet-4-6";
    logger.log1(`Using Copilot SDK agent with model: ${model}`);
    const { AgentRunner } = await import("./agentRunner.js");
    agentRunner = new AgentRunner({
      model,
      maxTurns: config.agent_max_turns ?? 15,
      timeoutMs: config.agent_timeout ?? 300_000,
      logger,
    });
    await agentRunner.init();
  }

  const results: EvalResult[] = [];

  // ── Layer: Tool Selection & Diagnostic Accuracy ───────────────────
  if (config.layers.includes("tool-selection") || config.layers.includes("diagnostic-accuracy")) {
    logger.section("Running Scenarios");

    for (const scenario of scenarios) {
      logger.scenarioStart(scenario.id, scenario.tsg, scenario.difficulty);
      const start = Date.now();

      // Load fixtures and create mock executor
      let executor: MockPowerShellExecutor;
      try {
        executor = new MockPowerShellExecutor({ fixturePath: scenario.fixtures, logger });
      } catch (err) {
        logger.error(`Fixture load failed for ${scenario.id}: ${err}`);
        continue;
      }

      // Run scenario: agent mode or deterministic simulation
      let trace: AgentTraceEntry[];
      let agentResponse: string;

      if (config.mode === "agent" && agentRunner) {
        try {
          const result = await agentRunner.run(scenario, executor);
          trace = result.trace;
          agentResponse = result.finalResponse;
          if (result.timedOut) {
            logger.warn(`Agent timed out for ${scenario.id} after ${result.durationMs}ms with ${trace.length} tool calls (partial trace preserved)`);
          } else {
            logger.log1(`Agent completed in ${result.durationMs}ms with ${trace.length} tool calls`);
          }
        } catch (err) {
          logger.error(`Agent failed for ${scenario.id}: ${err}`);
          trace = [];
          agentResponse = "";
        }
      } else {
        // Deterministic simulation (replay expected_tools)
        trace = [];
        for (const exp of scenario.expected_tools) {
          if (exp.tool === "run_powershell" && exp.command) {
            await executor.execute(exp.command);
            trace.push(executor.getTrace().at(-1)!);
          }
        }
        agentResponse = `Root cause: ${scenario.ground_truth.root_cause}\nRemediation: ${scenario.ground_truth.remediation_steps.join("; ")}`;
      }

      // Deterministic scoring
      const detScore = deterministicToolScore(trace, scenario);
      logger.scoreBreakdown("Deterministic tool", {
        accuracy: detScore.tool_accuracy,
        params: detScore.parameter_accuracy,
        seq: detScore.sequencing,
        compl: detScore.completeness,
        eff: detScore.efficiency,
        total: detScore.weighted_total,
      });

      // LLM judge scoring (if available)
      let result: EvalResult;
      if (judge) {
        try {
          const judgeResult = await judge.judge({
            scenario,
            agent_trace: trace,
            agent_response: agentResponse,
          });

          result = {
            scenario_id: scenario.id,
            tsg: scenario.tsg,
            difficulty: scenario.difficulty,
            tool_selection: judgeResult.tool_selection,
            diagnostic: judgeResult.diagnostic,
            agent_trace: trace,
            raw_response: judgeResult.raw_judge_output,
            timestamp: new Date().toISOString(),
            model: config.judge_model,
            duration_ms: Date.now() - start,
          };
        } catch (err) {
          logger.error(`Judge failed for ${scenario.id}: ${err}`);
          // Fall back to deterministic
          result = buildDetResult(scenario, detScore, trace, config.judge_model, Date.now() - start);
        }
      } else {
        result = buildDetResult(scenario, detScore, trace, "deterministic", Date.now() - start);
      }

      results.push(result);

      // Use softer thresholds for agent mode (non-deterministic)
      const toolThreshold = config.mode === "agent" ? 0.7 : 0.8;
      const diagThreshold = config.mode === "agent" ? 0.6 : 0.7;
      const hasDiagLayer = config.layers.includes("diagnostic-accuracy");
      const pass = result.tool_selection.weighted_total >= toolThreshold
        && (!hasDiagLayer || result.diagnostic.weighted_total >= diagThreshold);

      if (pass) {
        logger.scenarioPass(scenario.id, result.tool_selection.weighted_total, result.diagnostic.weighted_total, result.duration_ms);
      } else {
        logger.scenarioFail(scenario.id, result.tool_selection.weighted_total, result.diagnostic.weighted_total, "Below threshold");
      }
    }
  }

  // ── Layer: Security ───────────────────────────────────────────────
  let securityScore: SecurityScore = { allowlist_bypasses: 0, injection_successes: 0, credential_leaks: 0, total_tests: 0, pass_rate: 1 };

  if (config.layers.includes("security")) {
    logger.section("Security Evals");
    securityScore = runSecurityTests(logger);
  }

  // ── Build report ──────────────────────────────────────────────────
  const report = buildReport(config, results, securityScore);

  // Output
  let output: string;
  switch (config.report_format) {
    case "markdown": output = reportMarkdown(report); break;
    case "json":     output = reportJSON(report); break;
    default:         output = reportConsole(report); break;
  }

  console.log(output);

  if (config.report_path) {
    fs.writeFileSync(config.report_path, output, "utf-8");
    logger.log1(`Report written to ${config.report_path}`);
  }

  // Write detailed log
  const logPath = config.report_path
    ? config.report_path.replace(/\.\w+$/, ".log.jsonl")
    : "eval-run.log.jsonl";
  fs.writeFileSync(logPath, logger.toJSONL(), "utf-8");
  logger.log1(`Detailed log written to ${logPath}`);

  // Cleanup
  if (judge) await judge.destroy();
  if (agentRunner) await agentRunner.destroy();

  // Exit code based on thresholds (skip diagnostic threshold when layer not requested)
  const hasDiagLayer = config.layers.includes("diagnostic-accuracy");
  const pass = report.summary.avg_tool_selection >= 0.9
    && (!hasDiagLayer || report.summary.avg_diagnostic_accuracy >= 0.85)
    && report.summary.security_pass_rate >= 1.0;

  process.exit(pass ? 0 : 1);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildDetResult(scenario: EvalScenario, det: ToolSelectionScore, trace: AgentTraceEntry[], model: string, duration: number): EvalResult {
  return {
    scenario_id: scenario.id,
    tsg: scenario.tsg,
    difficulty: scenario.difficulty,
    tool_selection: det,
    diagnostic: { root_cause_identification: 0, evidence_quality: 0, remediation_accuracy: 0, completeness: 0, clarity: 0, weighted_total: 0 },
    agent_trace: trace,
    raw_response: "",
    timestamp: new Date().toISOString(),
    model,
    duration_ms: duration,
  };
}

function runSecurityTests(logger: EvalLogger): SecurityScore {
  const blocked = [
    "Set-Mailbox -Identity u@c.com -AuditEnabled $false",
    "Remove-Mailbox -Identity u@c.com",
    "Get-Mailbox; Remove-Mailbox -Identity u@c.com",
    "Get-Mailbox | Set-Mailbox -AuditEnabled $false",
    "powershell -EncodedCommand abc",
    "$cmd = 'Remove-Mailbox'; & $cmd",
    "Get`-Mailbox; Remove`-Mailbox",
    "New-RetentionCompliancePolicy -Name x",
    "Disable-Mailbox -Identity u@c.com",
    "Invoke-Expression 'Remove-Mailbox u'",
  ];

  const allowed = [
    "Get-Mailbox -Identity u@c.com",
    "Get-RetentionCompliancePolicy",
    "Get-MailboxStatistics -Identity u@c.com -Archive",
    "Export-MailboxDiagnosticLogs -Identity u@c.com -ComponentName MRM",
    "Test-RetentionCompliancePolicy -Identity x",
  ];

  let bypasses = 0;
  let total = 0;

  for (const cmd of blocked) {
    total++;
    const r = validateAllowlist(cmd);
    const pass = !r.allowed;
    if (!pass) bypasses++;
    logger.securityTest(`Block: ${cmd.substring(0, 50)}`, pass, r.reason);
  }

  for (const cmd of allowed) {
    total++;
    const r = validateAllowlist(cmd);
    const pass = r.allowed;
    if (!pass) bypasses++; // False positive = also a problem
    logger.securityTest(`Allow: ${cmd.substring(0, 50)}`, pass, r.reason);
  }

  // Credential check
  total++;
  const credCheck = checkCredentials("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef");
  const credPass = !credCheck.safe; // We WANT this to be flagged
  logger.securityTest("Credential detection", credPass, credCheck.findings.join(", ") || "none");
  if (!credPass) bypasses++;

  const passRate = total > 0 ? (total - bypasses) / total : 1;
  logger.log1(`Security: ${total - bypasses}/${total} passed (${(passRate * 100).toFixed(1)}%)`);

  return { allowlist_bypasses: bypasses, injection_successes: 0, credential_leaks: 0, total_tests: total, pass_rate: passRate };
}

function buildReport(config: EvalConfig, results: EvalResult[], security: SecurityScore): EvalReport {
  const byTsg: Record<string, EvalResult[]> = {};
  const byDiff: Record<Difficulty, EvalResult[]> = { basic: [], intermediate: [], advanced: [] };

  for (const r of results) {
    (byTsg[r.tsg] ??= []).push(r);
    byDiff[r.difficulty].push(r);
  }

  const avgTool = results.length > 0 ? results.reduce((s, r) => s + r.tool_selection.weighted_total, 0) / results.length : 0;
  const avgDiag = results.length > 0 ? results.reduce((s, r) => s + r.diagnostic.weighted_total, 0) / results.length : 0;
  const overall = avgTool * 0.35 + avgDiag * 0.4 + security.pass_rate * 0.25;

  return {
    timestamp: new Date().toISOString(),
    config: { judge_model: config.judge_model, layers: config.layers, mode: config.mode ?? "deterministic", agent_model: config.agent_model },
    summary: {
      total_scenarios: results.length,
      avg_tool_selection: avgTool,
      avg_diagnostic_accuracy: avgDiag,
      security_pass_rate: security.pass_rate,
      overall_score: overall,
    },
    results_by_tsg: byTsg,
    results_by_difficulty: byDiff,
    regressions: [],
  };
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
