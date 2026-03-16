# Purview DLM MCP — Eval Framework

Drop-in evaluation framework for [microsoft/purview-dlm-mcp](https://github.com/microsoft/purview-dlm-mcp). Uses **GitHub Copilot SDK** as the LLM judge with detailed structured logging.

## Quick Start

```bash
# 1. Copy these files into your purview-dlm-mcp repo
cp -r tests/evals/ <your-repo>/tests/evals/
cp .github/workflows/eval.yml <your-repo>/.github/workflows/eval.yml

# 2. Install the Copilot SDK (judge)
cd <your-repo>
npm install @github/copilot-sdk

# 3. Run security tests (no LLM needed)
npx vitest run tests/evals/security/

# 4. Run deterministic eval (no LLM needed)
npx tsx tests/evals/runner.ts --layer tool-selection --layer security

# 5. Run full eval with Copilot SDK judge
npx tsx tests/evals/runner.ts --layer tool-selection --layer diagnostic-accuracy --layer security
```

## Architecture

```
Your MCP Server (purview-dlm-mcp)
  │
  ├── src/                          ← existing server code
  │    ├── powershell/executor.ts   ← real PS executor
  │    └── ...
  │
  └── tests/
       ├── unit/                    ← existing vitest tests
       └── evals/                   ← THIS FRAMEWORK
            ├── runner.ts           ← CLI entry point
            ├── judge.ts            ← Copilot SDK + Direct API judges
            ├── mock-executor.ts    ← replaces real PS executor in tests
            ├── scoring.ts          ← deterministic scoring + allowlist checks
            ├── logger.ts           ← structured logging (4 verbosity levels)
            ├── scenario-loader.ts  ← YAML parser + reporters
            ├── types.ts            ← shared TypeScript types
            ├── scenarios/          ← YAML eval scenarios by TSG
            │    ├── retention-policy-not-applying/
            │    │    └── basic-01.yaml
            │    ├── policy-stuck-error/
            │    │    └── basic-01.yaml
            │    └── ... (11 TSG directories)
            ├── fixtures/           ← mock PowerShell output
            │    ├── policy-states/
            │    ├── archive-states/
            │    ├── mailbox-states/
            │    └── compliance-states/
            └── security/
                 └── allowlist.test.ts  ← vitest security suite
```

## How It Plugs Into Your MCP

The framework is designed to **not modify any existing source files**. It works by:

1. **Mock Executor** (`mock-executor.ts`) — implements the same `execute(command)` interface as your `src/powershell/executor.ts`, but returns fixture data instead of calling Exchange Online. No tenant, no credentials, no licensing needed.

2. **Scenarios** reference your TSG guides — each YAML scenario maps to one of the 11 TSGs in `.github/skills/dlm-diagnostics/references/`.

3. **Scoring** validates your allowlist logic — the `validateAllowlist()` function mirrors the rules in `src/powershell/allowlist.ts`.

### To integrate with the real agent loop:

In `runner.ts`, the current code simulates traces from `expected_tools`. To evaluate a real LLM agent against your MCP server, replace the simulation block with:

```typescript
// Instead of simulating, run the actual MCP agent:
import { McpClient } from "@modelcontextprotocol/sdk/client/index.js";

const client = new McpClient(/* your server config */);
await client.connect(transport);

// Send symptom, capture tool calls
const result = await client.callTool("run_powershell", { command: "..." });
// ... collect trace entries from actual execution
```

## CLI Reference

```
npx tsx tests/evals/runner.ts [options]

Options:
  --layer <name>       Eval layer to run (repeatable)
                       Values: tool-selection, diagnostic-accuracy, security, performance
                       Default: all three main layers

  --tsg <name>         Filter to specific TSG (repeatable)
                       Example: --tsg auto-expanding-archive --tsg inactive-mailbox

  --difficulty <level> Filter by difficulty (repeatable)
                       Values: basic, intermediate, advanced

  --max <n>            Maximum scenarios to run (for smoke tests)

  --judge-model <id>   Model for the Copilot SDK judge
                       Default: gpt-4.1
                       Examples: gpt-4.1, claude-sonnet-4.6, gpt-5

  --shuffle <n>        Number of prompt-shuffled judge runs to average
                       Default: 3 (use 5 for production baselines)

  --byok <provider>    Use direct API instead of Copilot CLI
                       Values: openai, anthropic
                       Reads OPENAI_API_KEY or ANTHROPIC_API_KEY from env

  --report <format>    Output format
                       Values: console (default), markdown, json

  --out <path>         Write report to file

  --log-level <0-3>    Logging verbosity
                       0 = silent
                       1 = summary (scenario pass/fail, final scores)
                       2 = steps (each tool call, judge scores)  [default]
                       3 = trace (full PS output, judge prompts, raw API)
```

## Log Levels Explained

### Level 1 — Summary
```
═══ Running Scenarios ═══
▶ retention-policy-not-applying-basic-01 (retention-policy-not-applying, basic)
✅ PASS retention-policy-not-applying-basic-01 — tool: 95.0% | diag: 88.0% | 3200ms
```

### Level 2 — Steps
```
▶ retention-policy-not-applying-basic-01 (retention-policy-not-applying, basic)
  Step 1: [run_powershell] Get-RetentionCompliancePolicy | Format-List Name, *Status*, Enabled
  Step 1: matched — Name: 7-Year Exchange Retention...
  Step 2: [run_powershell] Get-RetentionComplianceRule | Format-List Name, RetentionDuration...
  Step 2: matched — Name: 7-Year Exchange Retention Rule...
  Deterministic tool: accuracy=100.0%, params=100.0%, seq=100.0%, compl=100.0%
  Judge run 1/3...
  Judge run 1 tool: accuracy=90.0%, params=80.0%, seq=100.0%
  Judge run 1 diag: root_cause=90.0%, evidence=80.0%, remediation=90.0%
✅ PASS — tool: 95.0% | diag: 88.0% | 3200ms
```

### Level 3 — Full Trace
Everything from Level 2 plus:
- Complete PowerShell fixture output
- Full judge prompt text
- Raw judge API response JSON
- All written to `eval-run.log.jsonl` as structured JSON Lines

## Judge Options

### Option A: GitHub Copilot SDK (default)
Requires Copilot CLI installed and authenticated.

```bash
# Install
npm install @github/copilot-sdk
# Authenticate (one-time)
copilot auth login
# Run
npx tsx tests/evals/runner.ts --judge-model gpt-4.1
```

### Option B: BYOK via Copilot SDK
Use your own API keys through the Copilot SDK's BYOK feature.

```bash
# OpenAI
OPENAI_API_KEY=sk-... npx tsx tests/evals/runner.ts --byok openai --judge-model gpt-4.1

# Anthropic
ANTHROPIC_API_KEY=sk-... npx tsx tests/evals/runner.ts --byok anthropic --judge-model claude-sonnet-4-20250514
```

### Option C: Direct API (no Copilot CLI)
Falls back to raw API calls if Copilot CLI isn't available.

```bash
OPENAI_API_KEY=sk-... npx tsx tests/evals/runner.ts --byok openai
```

## Adding Scenarios

Create a YAML file in `tests/evals/scenarios/<tsg-name>/`:

```yaml
id: my-tsg-intermediate-01
tsg: my-tsg-name
difficulty: intermediate
symptom: >
  Natural language description of the user's problem.
symptom_variants:
  - "Alternative phrasing 1"
  - "Alternative phrasing 2"
expected_tools:
  - tool: run_powershell
    command: "Get-Something -Identity user@contoso.com"
  - tool: run_powershell
    command: "Get-SomethingElse | Format-List Prop1, Prop2"
    optional: true
ground_truth:
  root_cause: "Clear description of the actual root cause"
  root_cause_category: timing
  supporting_evidence:
    - "Specific output that proves the cause"
  remediation_steps:
    - "Step 1 to fix"
    - "Step 2 to fix"
  remediation_risk: low
  common_misdiagnoses:
    - "Wrong conclusion someone might jump to"
fixtures: policy-states/my-fixture.json
```

Then create the matching fixture JSON in `tests/evals/fixtures/`:

```json
{
  "name": "my-fixture",
  "description": "What this fixture simulates",
  "commands": [
    {
      "command": "Get-Something -Identity user@contoso.com",
      "command_pattern": "get-something.*user",
      "output": "Property1 : Value1\nProperty2 : Value2",
      "exit_code": 0,
      "duration_ms": 1500
    }
  ]
}
```

## CI/CD

The included `.github/workflows/eval.yml` provides:

- **`security-tests`** — runs on every PR touching `src/` or `tests/evals/`. Fast, no API needed.
- **`eval-deterministic`** — runs tool selection + security scoring without LLM. Posts results as PR comment.
- **`eval-llm-judge`** — runs full LLM-judged eval. Only triggers on `workflow_dispatch` or PRs labeled `run-llm-eval`.

### Gate Criteria

The runner exits with code 1 (failing the CI job) if:
- Tool selection accuracy < 90%
- Diagnostic accuracy < 85%
- Any security test fails

## Scoring Methodology

Based on MCPEval (Salesforce, 2025), MCP-Bench (NeurIPS 2025), and MCP-Radar:

| Dimension | Weight | Description |
|-----------|--------|-------------|
| **Tool Selection** | | |
| Tool accuracy | 30% | Correct MCP tools selected |
| Parameter accuracy | 25% | PS commands correct |
| Sequencing | 20% | Logical TSG-aligned order |
| Completeness | 15% | All required steps performed |
| Efficiency | 10% | No unnecessary commands |
| **Diagnostic Quality** | | |
| Root cause ID | 35% | Correct root cause identified |
| Remediation accuracy | 25% | Fix is correct and actionable |
| Evidence quality | 20% | PS output cited as evidence |
| Completeness | 10% | All issues identified |
| Clarity | 10% | Clear explanation for IT admin |

**Prompt shuffling**: Judge rubric dimension order is randomized across N runs (default 3) and scores averaged, per MCP-Bench methodology for scoring stability.

## Files Reference

| File | Purpose |
|------|---------|
| `runner.ts` | CLI entry point — orchestrates all layers |
| `judge.ts` | `CopilotJudge` (SDK) + `DirectAPIJudge` (fallback) |
| `mock-executor.ts` | Intercepts PS commands, returns fixtures |
| `scoring.ts` | Deterministic scoring, allowlist validation, credential checks |
| `logger.ts` | Structured logging with 4 verbosity levels |
| `scenario-loader.ts` | YAML parser + console/markdown/JSON reporters |
| `types.ts` | All TypeScript interfaces |
| `security/allowlist.test.ts` | Vitest security test suite |
| `scenarios/*/` | YAML eval scenarios per TSG |
| `fixtures/*/` | Mock PowerShell output JSON |
