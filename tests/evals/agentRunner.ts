// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Agent Runner — Copilot SDK Integration
 *
 * Runs eval scenarios against a real AI agent via the Copilot SDK.
 * Tool handlers route to MockPowerShellExecutor for deterministic fixture responses.
 * The agent's tool-calling behavior and final diagnostic are captured for scoring.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import { lookup, formatResponse } from "../../src/asklearn.js";
import type { AgentRunnerConfig, AgentRunResult, AgentTraceEntry, EvalScenario } from "./types.js";
import type { MockPowerShellExecutor } from "./mockExecutor.js";
import type { EvalLogger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SYSTEM_PROMPT = `You are a Microsoft Purview DLM diagnostic assistant. You investigate Data Lifecycle Management issues in Exchange Online using read-only PowerShell commands.

You have 5 tools:
1. run_powershell — Run read-only PowerShell commands against Exchange Online and Security & Compliance. Only Get-*/Test-*/Export-* cmdlets are allowed.
2. get_execution_log — Review the audit trail of all commands run so far.
3. ask_learn — Look up Microsoft Purview documentation from Microsoft Learn. Use sparingly (max 1 call per session).
4. create_issue — File a GitHub issue (disabled in this session).
5. read_skill_file — Read a detailed DLM troubleshooting guide for a specific symptom. ALWAYS read the matching reference file before running commands.

CMDLET REFERENCE (use these directly — do NOT run Get-Command to discover cmdlets):
- Mailbox: Get-Mailbox, Get-MailboxStatistics, Get-MailboxFolderStatistics, Get-Recipient, Get-EXORecipient
- Archive: Get-Mailbox (-Archive properties), Get-MailboxStatistics -Archive, Export-MailboxDiagnosticLogs -ComponentName MRM
- Retention: Get-RetentionCompliancePolicy (-DistributionDetail), Get-RetentionComplianceRule, Get-RetentionPolicyTag, Get-ComplianceTag
- Holds: Get-Mailbox (InPlaceHolds, LitigationHoldEnabled, ComplianceTagHoldApplied, DelayHoldApplied), Get-ComplianceCase
- Scopes: Get-AdaptiveScope, Get-RetentionCompliancePolicy (AdaptiveScopeLocation)
- Inactive: Get-Mailbox -InactiveMailboxOnly, Get-MailboxStatistics
- Org: Get-OrganizationConfig (ElcProcessingDisabled), Get-TransportConfig

HOLD TYPES — Critical for diagnosing retention/archive/quota issues:
- InPlaceHolds: Array of GUIDs — each maps to a compliance policy (match via Get-RetentionCompliancePolicy GUID)
- LitigationHoldEnabled: Explicit litigation hold
- ComplianceTagHoldApplied: True when retention labels with "Mark as Record" or hold actions are applied to items
- DelayHoldApplied: True when a hold was recently REMOVED — persists ~30 days, still blocks item deletion/archive moves
- DelayReleaseHoldApplied: Same as DelayHold for newer hold types

TEMPORAL REASONING:
- MFA (Managed Folder Assistant) processes mailboxes every ~7 days — changes may not take effect for up to 7 days
- Adaptive scopes refresh membership every ~7 days
- Delay holds expire after ~30 days from hold removal
- Policy distribution can take 24-48 hours after creation/modification
- "Recently removed" a policy → check DelayHoldApplied first

SKILL FILES:
- You have access to detailed troubleshooting guides via the read_skill_file tool
- The DLM DIAGNOSTICS SKILL section below maps symptoms to reference files
- ALWAYS read the matching reference file before starting your investigation
- Follow the step-by-step diagnostic sequence in the reference file

DIAGNOSTIC WORKFLOW:
1. Identify the symptom category and run 3-6 targeted commands (not more)
2. Start with Get-Mailbox to check hold properties, then narrow based on findings
3. Interpret each output before the next command — do NOT blindly run a fixed sequence
4. After gathering evidence, provide a structured diagnosis:
   - Root cause with specific evidence from command output
   - Recommended remediation steps (describe for the admin, do NOT execute mutating commands)
   - Additional checks if the root cause is unclear

IMPORTANT:
- Only execute read-only commands (Get-*, Test-*, Export-*)
- Be targeted — run the most informative commands first, avoid exploratory commands
- Cite specific command output values as evidence for your conclusions
- When you see DelayHoldApplied=True, that is almost always the primary or contributing root cause
- When InPlaceHolds has multiple GUIDs, identify each one (policy name + type)

Investigate the following issue thoroughly.`;

export class AgentRunner {
  private client: CopilotClient | null = null;
  private config: AgentRunnerConfig;
  private logger?: EvalLogger;

  constructor(config: AgentRunnerConfig) {
    this.config = config;
    this.logger = config.logger;
  }

  async init(): Promise<void> {
    this.client = new CopilotClient();
    await this.client.start();
  }

  async run(scenario: EvalScenario, executor: MockPowerShellExecutor): Promise<AgentRunResult> {
    if (!this.client) {
      throw new Error("AgentRunner not initialized. Call init() first.");
    }

    // Load SKILL.md to give the agent the full decision tree and workflow
    const skillPath = path.join(__dirname, "../../.github/skills/dlm-diagnostics/SKILL.md");
    let skillContent = "";
    try {
      skillContent = fs.readFileSync(skillPath, "utf-8");
    } catch {
      this.logger?.warn("Could not load SKILL.md — agent will run without skill context");
    }

    const systemPrompt = skillContent
      ? `${SYSTEM_PROMPT}\n\n${"═".repeat(40)}\nDLM DIAGNOSTICS SKILL\n${"═".repeat(40)}\n${skillContent}`
      : SYSTEM_PROMPT;

    const trace: AgentTraceEntry[] = [];
    let step = 0;

    const refDir = path.join(__dirname, "../../.github/skills/dlm-diagnostics/references");

    const tools: Tool[] = [
      {
        name: "run_powershell",
        description: "Run a read-only PowerShell command against Exchange Online and Security & Compliance sessions. Only Get-*/Test-*/Export-* cmdlets are allowed.",
        parameters: {
          type: "object",
          properties: { command: { type: "string", description: "The PowerShell command to execute" } },
          required: ["command"],
        },
        handler: async (args: { command: string }) => {
          step++;
          if (step > this.config.maxTurns) {
            return JSON.stringify({ success: false, output: "ERROR: Maximum tool turns exceeded." });
          }
          const start = Date.now();
          this.logger?.toolCall(step, "run_powershell", args.command);
          const result = await executor.execute(args.command);
          trace.push({
            step,
            tool: "run_powershell",
            input: { command: args.command },
            output: result.output,
            timestamp: new Date().toISOString(),
            duration_ms: Date.now() - start,
          });
          return JSON.stringify({ success: result.exitCode === 0, output: result.output });
        },
      },
      {
        name: "get_execution_log",
        description: "Retrieve the execution log of all commands run so far in this diagnostic session.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
          step++;
          const logTrace = executor.getTrace();
          const md = logTrace
            .map((e) => `Step ${e.step}: [${e.tool}] ${(e.input as { command: string }).command}\n${e.output}`)
            .join("\n\n");
          trace.push({
            step,
            tool: "get_execution_log",
            input: {},
            output: md,
            timestamp: new Date().toISOString(),
            duration_ms: 0,
          });
          return md;
        },
      },
      {
        name: "ask_learn",
        description: "Look up Microsoft Purview documentation from Microsoft Learn. Provide a question or topic to search for.",
        parameters: {
          type: "object",
          properties: { question: { type: "string", description: "The question or topic to look up" } },
          required: ["question"],
        },
        handler: async (args: { question: string }) => {
          step++;
          const matches = lookup(args.question);
          const response = formatResponse(matches);
          trace.push({
            step,
            tool: "ask_learn",
            input: { query: args.question },
            output: response,
            timestamp: new Date().toISOString(),
            duration_ms: 0,
          });
          return response;
        },
      },
      {
        name: "create_issue",
        description: "File a GitHub issue to report a problem with the MCP server (disabled in eval mode).",
        parameters: { type: "object", properties: {} },
        handler: async () => {
          step++;
          const msg = "Issue creation is disabled in eval mode.";
          trace.push({
            step,
            tool: "create_issue",
            input: {},
            output: msg,
            timestamp: new Date().toISOString(),
            duration_ms: 0,
          });
          return msg;
        },
      },
      {
        name: "read_skill_file",
        description:
          "Read a DLM diagnostics reference file. Use this to load the detailed troubleshooting guide for a specific symptom. Available files: adaptive-scope.md, audit-logs-missing.md, auto-apply-labels.md, auto-expanding-archive.md, diagnostic-commands.md, inactive-mailbox.md, items-not-moving-to-archive.md, mrm-purview-conflict.md, policy-stuck-error.md, retention-policy-not-applying.md, sharepoint-site-deletion-blocked.md, substrateholds-quota.md, teams-messages-not-deleting.md",
        parameters: {
          type: "object",
          properties: {
            filename: {
              type: "string",
              description: "The reference filename (e.g. 'items-not-moving-to-archive.md')",
            },
          },
          required: ["filename"],
        },
        handler: async (args: { filename: string }) => {
          step++;
          const filePath = path.join(refDir, path.basename(args.filename));
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            trace.push({
              step,
              tool: "read_skill_file",
              input: { filename: args.filename },
              output: content,
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            });
            return content;
          } catch {
            const msg = `File not found: ${args.filename}`;
            trace.push({
              step,
              tool: "read_skill_file",
              input: { filename: args.filename },
              output: msg,
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            });
            return msg;
          }
        },
      },
    ];

    const session = await this.client.createSession({
      model: this.config.model,
      tools,
      systemMessage: { mode: "replace", content: systemPrompt },
      onPermissionRequest: approveAll,
      availableTools: ["run_powershell", "get_execution_log", "ask_learn", "create_issue", "read_skill_file"],
    });

    const start = Date.now();
    let finalResponse = "";
    let timedOut = false;

    session.on("assistant.message", (event: { data: { content?: string } }) => {
      finalResponse = event.data.content ?? "";
    });

    try {
      const result = await session.sendAndWait(
        { prompt: scenario.symptom },
        this.config.timeoutMs,
      );
      if (result?.data?.content) {
        finalResponse = result.data.content;
      }
    } catch {
      timedOut = true;
      this.logger?.warn(`Timed out after ${this.config.timeoutMs}ms with ${trace.length} tool calls`);
    } finally {
      await session.disconnect();
    }

    return {
      trace,
      finalResponse,
      durationMs: Date.now() - start,
      timedOut,
    };
  }

  async destroy(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
  }
}
