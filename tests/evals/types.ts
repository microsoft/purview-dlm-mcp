// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Purview DLM MCP — Eval Framework Types
 *
 * Designed to plug into the existing purview-dlm-mcp repo.
 * Import paths assume these files live under tests/evals/.
 */

// ─── Scenario ───────────────────────────────────────────────────────────────

export type Difficulty = "basic" | "intermediate" | "advanced";
export type RootCauseCategory =
  | "configuration"
  | "permission"
  | "licensing"
  | "timing"
  | "conflict"
  | "quota"
  | "sync"
  | "workload";

export interface ToolCall {
  tool: "run_powershell" | "get_execution_log" | "ask_learn" | "create_issue";
  command?: string;
  command_pattern?: string;
  query?: string;
  optional?: boolean;
}

export interface DiagnosticGroundTruth {
  root_cause: string;
  root_cause_category: RootCauseCategory;
  supporting_evidence: string[];
  remediation_steps: string[];
  remediation_risk: "low" | "medium" | "high";
  common_misdiagnoses: string[];
}

export interface EvalScenario {
  id: string;
  tsg: string;
  difficulty: Difficulty;
  symptom: string;
  symptom_variants: string[];
  expected_tools: ToolCall[];
  ground_truth: DiagnosticGroundTruth;
  fixtures: string; // relative path under fixtures/
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

export interface CommandFixture {
  command: string;
  command_pattern?: string;
  output: string;
  exit_code: number;
  duration_ms?: number;
}

export interface FixtureSet {
  name: string;
  description: string;
  commands: CommandFixture[];
}

// ─── Agent Trace ────────────────────────────────────────────────────────────

export interface AgentTraceEntry {
  step: number;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  timestamp: string;
  duration_ms: number;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

export interface ToolSelectionScore {
  tool_accuracy: number;
  parameter_accuracy: number;
  sequencing: number;
  completeness: number;
  efficiency: number;
  weighted_total: number;
}

export interface DiagnosticScore {
  root_cause_identification: number;
  evidence_quality: number;
  remediation_accuracy: number;
  completeness: number;
  clarity: number;
  weighted_total: number;
}

export interface SecurityScore {
  allowlist_bypasses: number;
  injection_successes: number;
  credential_leaks: number;
  total_tests: number;
  pass_rate: number;
}

export interface PerformanceMetrics {
  avg_tool_latency_ms: number;
  avg_tokens_per_scenario: number;
  p95_latency_ms: number;
  timeout_violations: number;
}

// ─── Eval Result ────────────────────────────────────────────────────────────

export interface EvalResult {
  scenario_id: string;
  tsg: string;
  difficulty: Difficulty;
  tool_selection: ToolSelectionScore;
  diagnostic: DiagnosticScore;
  agent_trace: AgentTraceEntry[];
  raw_response: string;
  timestamp: string;
  model: string;
  duration_ms: number;
}

// ─── Judge ──────────────────────────────────────────────────────────────────

export interface JudgeProvider {
  name: string;
  judge(params: JudgeParams): Promise<JudgeResult>;
  destroy(): Promise<void>;
}

export interface JudgeParams {
  scenario: EvalScenario;
  agent_trace: AgentTraceEntry[];
  agent_response: string;
}

export interface JudgeResult {
  tool_selection: ToolSelectionScore;
  diagnostic: DiagnosticScore;
  reasoning: string;
  raw_judge_output: string;
}

// ─── Agent Mode ─────────────────────────────────────────────────────────────

export type AgentMode = "deterministic" | "agent";

export interface AgentRunnerConfig {
  model: string;              // e.g. "claude-sonnet-4-6", "claude-opus-4-6", "gpt-5.3"
  maxTurns: number;           // safety limit, default 15
  timeoutMs: number;          // per-scenario timeout, default 120_000
  logger?: EvalLogger;
}

export interface AgentRunResult {
  trace: AgentTraceEntry[];
  finalResponse: string;      // the agent's final diagnostic text
  durationMs: number;
  timedOut?: boolean;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export type EvalLayer =
  | "tool-selection"
  | "diagnostic-accuracy"
  | "security"
  | "performance";

export interface EvalConfig {
  /** Copilot SDK model for the judge (e.g. "claude-opus-4-6", "claude-sonnet-4.6") */
  judge_model: string;
  /** Number of prompt-shuffled judge runs to average */
  judge_shuffle_count: number;
  /** Which eval layers to run */
  layers: EvalLayer[];
  /** Filter to specific TSGs */
  tsg_filter?: string[];
  /** Filter to difficulty levels */
  difficulty_filter?: Difficulty[];
  /** Max scenarios (for smoke tests) */
  max_scenarios?: number;
  /** Output format */
  report_format: "console" | "markdown" | "json";
  /** Path to write report file */
  report_path?: string;
  /** Logging verbosity: 0=silent, 1=summary, 2=steps, 3=full trace */
  log_level: 0 | 1 | 2 | 3;
  /** Path to scenario YAML files */
  scenarios_dir: string;
  /** Path to fixture JSON files */
  fixtures_dir: string;
  /** Optional: BYOK provider config for Copilot SDK */
  byok?: {
    type: "openai" | "anthropic" | "azure";
    baseUrl?: string;
    apiKey?: string;
  };
  /** Run mode: deterministic (replay expected_tools) or agent (real AI via Copilot SDK) */
  mode?: AgentMode;
  /** Model for agent mode (e.g. "claude-sonnet-4-6") */
  agent_model?: string;
  /** Max tool-calling turns in agent mode */
  agent_max_turns?: number;
  /** Per-scenario timeout for agent mode in ms (default 300_000) */
  agent_timeout?: number;
}

// ─── Report ─────────────────────────────────────────────────────────────────

export interface EvalReport {
  timestamp: string;
  config: Partial<EvalConfig>;
  summary: {
    total_scenarios: number;
    avg_tool_selection: number;
    avg_diagnostic_accuracy: number;
    security_pass_rate: number;
    overall_score: number;
  };
  results_by_tsg: Record<string, EvalResult[]>;
  results_by_difficulty: Record<Difficulty, EvalResult[]>;
  regressions: Regression[];
}

export interface Regression {
  scenario_id: string;
  dimension: string;
  previous_score: number;
  current_score: number;
  delta: number;
}

// ─── Logger import (for AgentRunnerConfig) ──────────────────────────────────

import type { EvalLogger } from "./logger.js";
