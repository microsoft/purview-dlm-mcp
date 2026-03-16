// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Scenario Loader & Reporters
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYamlContent } from "yaml";
import type { EvalScenario, EvalReport, Difficulty } from "./types.js";

export function parseScenarioFile(filePath: string): EvalScenario {
  const content = fs.readFileSync(filePath, "utf-8");
  return parseYamlContent(content) as EvalScenario;
}

// ─── Loader ─────────────────────────────────────────────────────────────────

export function loadScenarios(opts: {
  scenariosDir: string;
  fixturesDir: string;
  tsgFilter?: string[];
  difficultyFilter?: Difficulty[];
  maxScenarios?: number;
}): EvalScenario[] {
  const scenarios: EvalScenario[] = [];
  const tsgDirs = fs.readdirSync(opts.scenariosDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => !opts.tsgFilter || opts.tsgFilter.includes(d.name));

  for (const dir of tsgDirs) {
    const tsgPath = path.join(opts.scenariosDir, dir.name);
    for (const file of fs.readdirSync(tsgPath).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))) {
      try {
        const scenario = parseScenarioFile(path.join(tsgPath, file));
        if (opts.difficultyFilter && !opts.difficultyFilter.includes(scenario.difficulty)) continue;
        if (scenario.fixtures && !path.isAbsolute(scenario.fixtures)) {
          scenario.fixtures = path.join(opts.fixturesDir, scenario.fixtures);
        }
        scenarios.push(scenario);
      } catch (err) {
        console.warn(`Warning: failed to parse ${dir.name}/${file}: ${err}`);
      }
    }
  }

  return opts.maxScenarios ? scenarios.slice(0, opts.maxScenarios) : scenarios;
}

// ─── Reporters ──────────────────────────────────────────────────────────────

export function reportConsole(r: EvalReport): string {
  const s = r.summary;
  const lines = [
    "",
    "╔══════════════════════════════════════════════════════════╗",
    "║      Purview DLM MCP — Eval Report                      ║",
    "╚══════════════════════════════════════════════════════════╝",
    "",
    `  Scenarios: ${s.total_scenarios}`,
    "",
    `  Tool Selection:      ${pct(s.avg_tool_selection)}  ${ok(s.avg_tool_selection, 0.9)}`,
    `  Diagnostic Accuracy: ${pct(s.avg_diagnostic_accuracy)}  ${ok(s.avg_diagnostic_accuracy, 0.85)}`,
    `  Security:            ${pct(s.security_pass_rate)}  ${ok(s.security_pass_rate, 1)}`,
    `  Overall:             ${pct(s.overall_score)}  ${ok(s.overall_score, 0.85)}`,
    "",
  ];

  for (const [tsg, results] of Object.entries(r.results_by_tsg)) {
    const t = results.reduce((a, x) => a + x.tool_selection.weighted_total, 0) / results.length;
    const d = results.reduce((a, x) => a + x.diagnostic.weighted_total, 0) / results.length;
    lines.push(`  ${tsg.padEnd(42)} T:${pct(t)} D:${pct(d)} (${results.length})`);
  }

  if (r.regressions.length) {
    lines.push("", "  Regressions:");
    for (const reg of r.regressions) {
      lines.push(`    ⚠️ ${reg.scenario_id}: ${reg.dimension} ${pct(reg.previous_score)}→${pct(reg.current_score)}`);
    }
  }
  return lines.join("\n");
}

export function reportMarkdown(r: EvalReport): string {
  const s = r.summary;
  const lines = [
    `## Purview DLM MCP Eval — ${r.timestamp.split("T")[0]}`,
    "",
    "| Layer | Score | Status |",
    "|-------|-------|--------|",
    `| Tool Selection | ${pct(s.avg_tool_selection)} | ${emoji(s.avg_tool_selection, 0.9)} |`,
    `| Diagnostic Accuracy | ${pct(s.avg_diagnostic_accuracy)} | ${emoji(s.avg_diagnostic_accuracy, 0.85)} |`,
    `| Security | ${pct(s.security_pass_rate)} | ${emoji(s.security_pass_rate, 1)} |`,
    `| **Overall** | **${pct(s.overall_score)}** | ${emoji(s.overall_score, 0.85)} |`,
    "",
    "### By TSG",
    "",
    "| TSG | Tool | Diag | N |",
    "|-----|------|------|---|",
  ];
  for (const [tsg, results] of Object.entries(r.results_by_tsg)) {
    const t = results.reduce((a, x) => a + x.tool_selection.weighted_total, 0) / results.length;
    const d = results.reduce((a, x) => a + x.diagnostic.weighted_total, 0) / results.length;
    lines.push(`| ${tsg} | ${pct(t)} | ${pct(d)} | ${results.length} |`);
  }
  return lines.join("\n");
}

export function reportJSON(r: EvalReport): string {
  return JSON.stringify(r, null, 2);
}

function pct(v: number): string { return `${(v * 100).toFixed(1)}%`; }
function ok(v: number, t: number): string { return v >= t ? "✅" : "⚠️"; }
function emoji(v: number, t: number): string { return v >= t ? "✅" : "⚠️"; }
