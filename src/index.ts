#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PsExecutor } from "./powershell/executor.js";
import { ExecutionLog } from "./logger.js";
import { lookup, formatResponse } from "./asklearn.js";
import { GitHubAuth } from "./github/auth.js";
import { buildIssueBody, categoryToLabels, createGitHubIssue } from "./github/issues.js";
import { Telemetry } from "./telemetry.js";
import { COLLECT_TELEMETRY, COLLECT_TELEMETRY_MICROSOFT } from "./config.js";

let telemetry: Telemetry | undefined;

async function main(): Promise<void> {
  const serverStartTime = Date.now();
  process.stderr.write("[DLM Diagnostics MCP] Starting\u2026\n");

  // Create singletons
  const log = new ExecutionLog();
  const executor = new PsExecutor();
  const githubAuth = new GitHubAuth();

  // Initialize telemetry
  telemetry = new Telemetry("2.1.0", COLLECT_TELEMETRY && COLLECT_TELEMETRY_MICROSOFT);
  telemetry.initialize();
  if (COLLECT_TELEMETRY) {
    process.stderr.write("[DLM Diagnostics MCP] Telemetry is enabled. Set DLM_COLLECT_TELEMETRY=false to opt out.\n");
  }

  // Create MCP server
  const server = new McpServer(
    { name: "dlm-diagnostics", version: "2.0.0" },
    {
      instructions:
        "You are a Purview DLM diagnostic assistant with 5 tools.\n\n" +
        "TOOL SELECTION RULES:\n" +
        "1. User reports a PROBLEM, ERROR, or SYMPTOM → use `run_powershell` to investigate.\n" +
        "2. User asks a HOW-TO or WHAT-IS question → use `ask_learn`.\n" +
        "3. User asks to review/audit/summarize commands already run → use `get_execution_log`.\n" +
        "4. User wants to FILE a GitHub issue from the session → use `create_issue`.\n" +
        "5. At the END of a diagnostic session → use `submit_feedback` to collect user satisfaction.\n\n" +
        "Default to `run_powershell` for anything that sounds like troubleshooting.",
    },
  );

  // ─── Tool: run_powershell ───

  server.tool(
    "run_powershell",
    "Diagnose Purview DLM issues by running read-only PowerShell commands against Exchange Online. " +
      "USE THIS TOOL WHEN: the user reports a problem, error, or unexpected behavior — " +
      "e.g., retention policy not applying, items not archiving, mailbox not becoming inactive, " +
      "policy stuck in Error, Teams messages not deleting, SubstrateHolds growing. " +
      "Examples: Get-RetentionCompliancePolicy, Get-Mailbox, Get-MailboxStatistics, Get-ComplianceTag. " +
      "Only Get-*/Test-*/Export-* cmdlets are allowed; mutating commands are blocked. " +
      "Returns JSON: { success, output, error, durationMs, logIndex }.",
    {
      command: z
        .string()
        .describe("The PowerShell cmdlet to execute (e.g., 'Get-RetentionCompliancePolicy \"PolicyName\" | FL')."),
    },
    async ({ command }) => {
      const start = Date.now();
      try {
        const result = await executor.execute(command);
        const durationMs = Date.now() - start;

        log.append({
          timestamp: new Date().toISOString(),
          command,
          success: result.success,
          output: result.output,
          error: result.error,
          durationMs,
        });

        telemetry?.trackEvent(
          "ToolInvoked",
          { toolName: "run_powershell", success: String(result.success) },
          { durationMs },
        );

        const response = {
          success: result.success,
          output: result.output,
          error: result.error ?? null,
          durationMs,
          logIndex: log.count(),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        telemetry?.trackEvent(
          "ToolInvoked",
          { toolName: "run_powershell", success: "false" },
          { durationMs: Date.now() - start },
        );
        throw err;
      }
    },
  );

  // ─── Tool: get_execution_log ───

  server.tool(
    "get_execution_log",
    "Review the audit trail of all PowerShell commands run in this session. " +
      "USE THIS TOOL WHEN: the user asks to review, audit, or summarize the investigation so far. " +
      "Returns Markdown with timestamps, commands, outputs, errors, and durations. " +
      "Do NOT use this for running new diagnostics — use run_powershell instead.",
    {},
    async () => {
      const start = Date.now();
      const md = log.toMarkdown();
      telemetry?.trackEvent(
        "ToolInvoked",
        { toolName: "get_execution_log", success: "true" },
        { durationMs: Date.now() - start },
      );
      return {
        content: [{ type: "text" as const, text: md }],
      };
    },
  );

  // ─── Tool: ask_learn ───

  server.tool(
    "ask_learn",
    "Look up Microsoft Purview documentation from Microsoft Learn. " +
      "USE THIS TOOL WHEN: the user asks a how-to, setup, or conceptual question — " +
      "e.g., 'how do I create a retention policy', 'what is eDiscovery', 'how do adaptive scopes work'. " +
      "Do NOT use this for troubleshooting active issues — use run_powershell instead. " +
      "Covers: retention policies, retention labels, archive mailboxes, inactive mailboxes, " +
      "eDiscovery, audit log, communication compliance, information barriers, " +
      "insider risk management, records management, and adaptive scopes.",
    { question: z.string().describe("The user's how-to or conceptual question about a Purview feature.") },
    async ({ question }) => {
      const start = Date.now();
      try {
        const matches = lookup(question);
        telemetry?.trackEvent(
          "ToolInvoked",
          { toolName: "ask_learn", success: "true" },
          { durationMs: Date.now() - start },
        );
        return {
          content: [{ type: "text" as const, text: formatResponse(matches) }],
        };
      } catch (err) {
        telemetry?.trackEvent(
          "ToolInvoked",
          { toolName: "ask_learn", success: "false" },
          { durationMs: Date.now() - start },
        );
        throw err;
      }
    },
  );

  // ─── Tool: create_issue ───

  const ghOwner = process.env["DLM_GITHUB_OWNER"] ?? "microsoft";
  const ghRepo = process.env["DLM_GITHUB_REPO"] ?? "purview-dlm-mcp";

  server.tool(
    "create_issue",
    "File a GitHub issue from a diagnostic session. " +
      "USE THIS TOOL WHEN: the user wants to report a bug, request a feature, or escalate a finding " +
      "discovered during the diagnostic session. " +
      "Attaches session context (commands run, pass/fail status, durations) but excludes raw outputs to avoid PII leakage. " +
      "Requires GitHub authentication via Device Flow on first use.",
    {
      title: z.string().describe("Issue title — short summary of the problem or request."),
      description: z.string().describe("Detailed description of the issue."),
      category: z
        .enum([
          "retention-policy",
          "retention-label",
          "archive",
          "inactive-mailbox",
          "ediscovery",
          "audit-log",
          "other",
        ])
        .describe("Issue category — used to apply labels."),
      environment: z.string().optional().describe("Environment details (tenant, region, license SKU, etc.)."),
      stepsToReproduce: z.string().optional().describe("Steps to reproduce the issue."),
    },
    async ({ title, description, category, environment, stepsToReproduce }) => {
      const start = Date.now();
      try {
        const token = await githubAuth.getToken();
        const body = buildIssueBody(
          { title, description, category, environment, stepsToReproduce },
          log.getAll(),
          null,
        );
        const labels = categoryToLabels(category);
        const result = await createGitHubIssue(token, ghOwner, ghRepo, title, body, labels);

        const durationMs = Date.now() - start;
        telemetry?.trackEvent("ToolInvoked", { toolName: "create_issue", success: "true" }, { durationMs });
        telemetry?.trackEvent("GitHubIssueCreated", { category }, { durationMs });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, issueUrl: result.url, issueNumber: result.number }, null, 2),
            },
          ],
        };
      } catch (err) {
        telemetry?.trackEvent(
          "ToolInvoked",
          { toolName: "create_issue", success: "false" },
          { durationMs: Date.now() - start },
        );
        throw err;
      }
    },
  );

  // ─── Tool: submit_feedback ───

  server.tool(
    "submit_feedback",
    "Submit structured feedback about a diagnostic session. " +
      "USE THIS TOOL WHEN: a diagnostic investigation has completed and the user has indicated whether it was helpful. " +
      "Emits a TsgFeedback telemetry event (no PII). Returns a confirmation message.",
    {
      tsgId: z
        .string()
        .describe("Identifier of the TSG/diagnostic guide used (e.g., 'retention-policy-not-applying')."),
      rating: z.enum(["helpful", "not-helpful"]).describe("User satisfaction rating."),
      feedbackCategory: z
        .enum(["accuracy", "completeness", "relevance", "other"])
        .optional()
        .describe("Optional category for the feedback."),
    },
    async ({ tsgId, rating, feedbackCategory }) => {
      telemetry?.trackEvent("TsgUsed", { tsgId });
      telemetry?.trackEvent("TsgFeedback", {
        tsgId,
        rating,
        ...(feedbackCategory ? { feedbackCategory } : {}),
      });
      telemetry?.trackEvent("ToolInvoked", { toolName: "submit_feedback", success: "true" }, { durationMs: 0 });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: true, message: "Feedback submitted. Thank you!" }, null, 2),
          },
        ],
      };
    },
  );

  // ─── Prompt: diagnose ───

  server.prompt(
    "diagnose",
    "Start a DLM diagnostic investigation.",
    { symptom: z.string().describe("The reported symptom or question.") },
    async ({ symptom }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Investigate this DLM issue: ${symptom}\n\nUse run_powershell for diagnostic commands. Use get_execution_log at the end for the audit trail.`,
          },
        },
      ],
    }),
  );

  // Connect stdio transport BEFORE background PS init
  const transport = new StdioServerTransport();
  await server.connect(transport);

  telemetry?.trackEvent("ServerStarted", { initDurationMs: String(Date.now() - serverStartTime) });
  process.stderr.write("[DLM Diagnostics MCP] Server running \u2713\n");

  // Graceful shutdown — flush telemetry before exit
  const shutdown = async () => {
    await telemetry?.flush();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Initialize PowerShell sessions in the background
  executor.init(telemetry).catch((ex) => {
    process.stderr.write(`[DLM Diagnostics MCP] Failed to initialize PowerShell sessions: ${ex}\n`);
    process.stderr.write("[DLM Diagnostics MCP] Commands will fail until sessions connect.\n");
  });
}

main().catch(async (err) => {
  if (telemetry) {
    telemetry.trackEvent("UnhandledException", {
      errorType: err?.constructor?.name ?? "Unknown",
      errorMessage: String(err?.message ?? err).slice(0, 200),
    });
    await telemetry.flush();
  }
  process.stderr.write(`[DLM Diagnostics MCP] Fatal error: ${err}\n`);
  process.exit(1);
});
