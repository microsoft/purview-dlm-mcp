// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Copilot SDK Judge
 *
 * Uses @github/copilot-sdk to evaluate agent diagnostic traces.
 * Implements prompt shuffling (per MCP-Bench) for scoring stability.
 *
 * Prerequisites:
 *   npm install @github/copilot-sdk
 *   GitHub Copilot CLI installed and authenticated (or BYOK configured)
 *
 * The judge creates a CopilotClient, sends the evaluation rubric as a
 * prompt, and parses the structured JSON response.
 */

import type {
  JudgeProvider,
  JudgeParams,
  JudgeResult,
  ToolSelectionScore,
  DiagnosticScore,
  EvalConfig,
} from "./types.js";
import type { EvalLogger } from "./logger.js";

// ─── Rubric dimensions (shuffled per run) ───────────────────────────────────

const TOOL_DIMS = [
  "TOOL_ACCURACY",
  "PARAMETER_ACCURACY",
  "SEQUENCING",
  "COMPLETENESS",
  "EFFICIENCY",
] as const;

const DIAG_DIMS = [
  "ROOT_CAUSE_IDENTIFICATION",
  "EVIDENCE_QUALITY",
  "REMEDIATION_ACCURACY",
  "COMPLETENESS",
  "CLARITY",
] as const;

const TOOL_DESCRIPTIONS: Record<string, string> = {
  TOOL_ACCURACY: "Did the agent use the correct MCP tools (run_powershell vs ask_learn)?",
  PARAMETER_ACCURACY: "Were PowerShell commands syntactically and semantically correct?",
  SEQUENCING: "Were commands executed in logical TSG-aligned order?",
  COMPLETENESS: "Were all necessary diagnostic steps performed?",
  EFFICIENCY: "Were redundant or unnecessary commands avoided?",
};

const DIAG_DESCRIPTIONS: Record<string, string> = {
  ROOT_CAUSE_IDENTIFICATION: "Did the agent correctly identify the root cause?",
  EVIDENCE_QUALITY: "Did the agent cite specific PS output to support the diagnosis?",
  REMEDIATION_ACCURACY: "Is the recommended fix correct and actionable?",
  COMPLETENESS: "Were all relevant issues identified?",
  CLARITY: "Is the explanation clear and well-structured for an IT admin?",
};

// ─── Prompt builder ─────────────────────────────────────────────────────────

function buildPrompt(
  params: JudgeParams,
  toolOrder: string[],
  diagOrder: string[]
): string {
  const trace = params.agent_trace
    .map((t, i) => {
      const cmd = t.tool === "run_powershell"
        ? (t.input as { command: string }).command
        : JSON.stringify(t.input);
      return `Step ${i + 1}: [${t.tool}] ${cmd}\n  Output: ${t.output.substring(0, 400)}${t.output.length > 400 ? "…" : ""}`;
    })
    .join("\n\n");

  const expected = params.scenario.expected_tools
    .map((t, i) => `${i + 1}. [${t.tool}]${t.command ? " " + t.command : ""}${t.optional ? " (optional)" : ""}`)
    .join("\n");

  const gt = params.scenario.ground_truth;

  return `You are an expert evaluator for Microsoft Purview DLM diagnostics.
Score an AI agent's investigation of a DLM issue.

═══ SCENARIO ═══
TSG: ${params.scenario.tsg} | Difficulty: ${params.scenario.difficulty}
Symptom: ${params.scenario.symptom}

═══ EXPECTED APPROACH ═══
${expected}

═══ EXPECTED ROOT CAUSE ═══
${gt.root_cause} (${gt.root_cause_category})

═══ EXPECTED REMEDIATION ═══
${gt.remediation_steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

═══ COMMON MISDIAGNOSES ═══
${gt.common_misdiagnoses.map((m) => "- " + m).join("\n")}

═══ AGENT TRACE ═══
${trace}

═══ AGENT RESPONSE ═══
${params.agent_response}

═══ SCORING INSTRUCTIONS ═══
Score each dimension 0–10. 10=perfect, 7=good, 4=partial, 0=wrong.

PART A — TOOL SELECTION (evaluate in this order):
${toolOrder.map((d, i) => `${i + 1}. ${d}: ${TOOL_DESCRIPTIONS[d]}`).join("\n")}

PART B — DIAGNOSTIC QUALITY (evaluate in this order):
${diagOrder.map((d, i) => `${i + 1}. ${d}: ${DIAG_DESCRIPTIONS[d]}`).join("\n")}

Respond ONLY with valid JSON (no markdown fences):
{
  "tool_selection": { "tool_accuracy": N, "parameter_accuracy": N, "sequencing": N, "completeness": N, "efficiency": N },
  "diagnostic": { "root_cause_identification": N, "evidence_quality": N, "remediation_accuracy": N, "completeness": N, "clarity": N },
  "reasoning": "Brief 2–3 sentence explanation"
}`;
}

// ─── Score parsing ──────────────────────────────────────────────────────────

function parseResponse(raw: string): {
  tool: Record<string, number>;
  diag: Record<string, number>;
  reasoning: string;
} {
  const cleaned = raw.replace(/```json\s*/g, "").replace(/```/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in judge response: ${raw.substring(0, 200)}`);

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    tool: parsed.tool_selection ?? {},
    diag: parsed.diagnostic ?? {},
    reasoning: parsed.reasoning ?? "",
  };
}

function norm(v: number): number {
  return Math.max(0, Math.min(1, v / 10));
}

function toToolScore(raw: Record<string, number>): ToolSelectionScore {
  const s = {
    tool_accuracy: norm(raw.tool_accuracy ?? 0),
    parameter_accuracy: norm(raw.parameter_accuracy ?? 0),
    sequencing: norm(raw.sequencing ?? 0),
    completeness: norm(raw.completeness ?? 0),
    efficiency: norm(raw.efficiency ?? 0),
    weighted_total: 0,
  };
  s.weighted_total =
    s.tool_accuracy * 0.3 +
    s.parameter_accuracy * 0.25 +
    s.sequencing * 0.2 +
    s.completeness * 0.15 +
    s.efficiency * 0.1;
  return s;
}

function toDiagScore(raw: Record<string, number>): DiagnosticScore {
  const s = {
    root_cause_identification: norm(raw.root_cause_identification ?? 0),
    evidence_quality: norm(raw.evidence_quality ?? 0),
    remediation_accuracy: norm(raw.remediation_accuracy ?? 0),
    completeness: norm(raw.completeness ?? 0),
    clarity: norm(raw.clarity ?? 0),
    weighted_total: 0,
  };
  s.weighted_total =
    s.root_cause_identification * 0.35 +
    s.evidence_quality * 0.2 +
    s.remediation_accuracy * 0.25 +
    s.completeness * 0.1 +
    s.clarity * 0.1;
  return s;
}

function avg<T extends Record<string, number>>(items: T[]): T {
  if (items.length === 0) return items[0];
  const result = { ...items[0] };
  for (const key of Object.keys(result)) {
    (result as Record<string, number>)[key] =
      items.reduce((sum, item) => sum + ((item as Record<string, number>)[key] ?? 0), 0) / items.length;
  }
  return result;
}

// ─── Shuffle ────────────────────────────────────────────────────────────────

function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─── Copilot SDK Judge ──────────────────────────────────────────────────────

export class CopilotJudge implements JudgeProvider {
  name = "copilot-sdk";

  private model: string;
  private shuffleCount: number;
  private logger?: EvalLogger;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null; // CopilotClient — dynamically imported
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _approveAll: any = null;
  private byok?: EvalConfig["byok"];

  constructor(opts: {
    model?: string;
    shuffleCount?: number;
    logger?: EvalLogger;
    byok?: EvalConfig["byok"];
  }) {
    this.model = opts.model ?? "claude-opus-4-6";
    this.shuffleCount = opts.shuffleCount ?? 5;
    this.logger = opts.logger;
    this.byok = opts.byok;
  }

  private async ensureClient(): Promise<void> {
    if (this.client) return;

    // Dynamic import so the eval framework doesn't hard-fail if SDK isn't installed
    const { CopilotClient, approveAll } = await import("@github/copilot-sdk");
    this._approveAll = approveAll;
    this.client = new CopilotClient();
    await this.client.start();
  }

  async judge(params: JudgeParams): Promise<JudgeResult> {
    await this.ensureClient();

    const toolScores: ToolSelectionScore[] = [];
    const diagScores: DiagnosticScore[] = [];
    let lastReasoning = "";
    let lastRaw = "";

    for (let i = 0; i < this.shuffleCount; i++) {
      this.logger?.judgeStart(i + 1, this.shuffleCount);

      const toolOrder = shuffle(TOOL_DIMS) as unknown as string[];
      const diagOrder = shuffle(DIAG_DIMS) as unknown as string[];
      const prompt = buildPrompt(params, toolOrder, diagOrder);

      this.logger?.traceJudgePrompt(prompt);

      // Create session with optional BYOK
      const sessionConfig: Record<string, unknown> = { model: this.model };
      if (this.byok) {
        sessionConfig.provider = {
          type: this.byok.type === "anthropic" ? "anthropic" : "openai",
          ...(this.byok.baseUrl && { baseUrl: this.byok.baseUrl }),
          ...(this.byok.apiKey && { apiKey: this.byok.apiKey }),
        };
      }

      sessionConfig.onPermissionRequest = this._approveAll;
      const session = await this.client.createSession(sessionConfig);

      try {
        const response = await session.sendAndWait({ prompt });
        const rawText = response?.data?.content ?? "";

        lastRaw = rawText;
        this.logger?.traceJudgeResponse(rawText);

        const parsed = parseResponse(rawText);
        const ts = toToolScore(parsed.tool);
        const ds = toDiagScore(parsed.diag);

        toolScores.push(ts);
        diagScores.push(ds);
        lastReasoning = parsed.reasoning;

        this.logger?.scoreBreakdown(`Judge run ${i + 1} tool`, {
          accuracy: ts.tool_accuracy,
          params: ts.parameter_accuracy,
          seq: ts.sequencing,
          compl: ts.completeness,
          eff: ts.efficiency,
        });
        this.logger?.scoreBreakdown(`Judge run ${i + 1} diag`, {
          root_cause: ds.root_cause_identification,
          evidence: ds.evidence_quality,
          remediation: ds.remediation_accuracy,
          compl: ds.completeness,
          clarity: ds.clarity,
        });
      } finally {
        await (session.destroy?.() ?? session.disconnect?.());
      }
    }

    return {
      tool_selection: avg(toolScores),
      diagnostic: avg(diagScores),
      reasoning: lastReasoning,
      raw_judge_output: lastRaw,
    };
  }

  async destroy(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
  }
}

// ─── Fallback: Direct API judge (no Copilot CLI needed) ─────────────────────

/**
 * If Copilot CLI isn't installed, you can use BYOK directly via fetch.
 * This avoids the CLI dependency entirely.
 */
export class DirectAPIJudge implements JudgeProvider {
  name = "direct-api";

  private model: string;
  private shuffleCount: number;
  private logger?: EvalLogger;
  private baseUrl: string;
  private apiKey: string;
  private provider: "openai" | "anthropic";

  constructor(opts: {
    provider: "openai" | "anthropic";
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    shuffleCount?: number;
    logger?: EvalLogger;
  }) {
    this.provider = opts.provider;
    this.model = opts.model ?? (opts.provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4.1");
    this.apiKey = opts.apiKey ?? process.env[opts.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"] ?? "";
    this.baseUrl = opts.baseUrl ?? (opts.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com");
    this.shuffleCount = opts.shuffleCount ?? 5;
    this.logger = opts.logger;

    if (!this.apiKey) {
      throw new Error(`API key required for ${opts.provider}. Set env var or pass apiKey.`);
    }
  }

  async judge(params: JudgeParams): Promise<JudgeResult> {
    const toolScores: ToolSelectionScore[] = [];
    const diagScores: DiagnosticScore[] = [];
    let lastReasoning = "";
    let lastRaw = "";

    for (let i = 0; i < this.shuffleCount; i++) {
      this.logger?.judgeStart(i + 1, this.shuffleCount);

      const prompt = buildPrompt(
        params,
        shuffle(TOOL_DIMS) as unknown as string[],
        shuffle(DIAG_DIMS) as unknown as string[]
      );
      this.logger?.traceJudgePrompt(prompt);

      let rawText: string;

      if (this.provider === "anthropic") {
        const res = await fetch(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: 2048,
            temperature: 0,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).substring(0, 300)}`);
        const data = await res.json() as { content: Array<{ type: string; text?: string }> };
        rawText = data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      } else {
        const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            temperature: 0,
            max_tokens: 2048,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).substring(0, 300)}`);
        const data = await res.json() as { choices: Array<{ message: { content: string } }> };
        rawText = data.choices?.[0]?.message?.content ?? "";
      }

      lastRaw = rawText;
      this.logger?.traceJudgeResponse(rawText);

      const parsed = parseResponse(rawText);
      toolScores.push(toToolScore(parsed.tool));
      diagScores.push(toDiagScore(parsed.diag));
      lastReasoning = parsed.reasoning;
    }

    return {
      tool_selection: avg(toolScores),
      diagnostic: avg(diagScores),
      reasoning: lastReasoning,
      raw_judge_output: lastRaw,
    };
  }

  async destroy(): Promise<void> {
    // No cleanup needed for direct API calls
  }
}
