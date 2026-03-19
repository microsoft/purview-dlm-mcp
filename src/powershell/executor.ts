// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { validateCommand } from "./allowlist.js";
import { COMMAND_TIMEOUT_MS } from "../config.js";
import type { Telemetry } from "../telemetry.js";

// ─── Types ───

export interface PsResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface PsJsonResult<T = unknown> {
  success: boolean;
  data?: T;
  raw: string;
  error?: string;
}

// ─── Executor ───

/**
 * Manages a single long-lived PowerShell 7 (pwsh) process.
 * On init it acquires an access token via MSAL interactive browser auth
 * (in a separate short-lived pwsh process), then uses that token to
 * connect to Exchange Online and IPPSSession in the main piped process.
 */
export class PsExecutor {
  private proc: ChildProcess | null = null;
  private buf = "";
  private ready = false;
  private telemetry?: Telemetry;

  get isReady(): boolean {
    return this.ready;
  }

  /* ───────── Lifecycle ───────── */

  async init(telemetry?: Telemetry): Promise<void> {
    this.telemetry = telemetry;
    const initStart = Date.now();
    let lastStage = "spawn";

    try {
      this.proc = spawn("pwsh", ["-NoExit", "-NoProfile", "-Command", "-"], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: { ...process.env },
      });

      this.proc.stdout!.on("data", (d: Buffer) => {
        this.buf += d.toString();
      });
      this.proc.stderr!.on("data", (d: Buffer) => {
        process.stderr.write(d);
      });
      this.proc.on("exit", (code) => {
        process.stderr.write(`[PsExecutor] pwsh exited (code ${code})\n`);
        this.ready = false;
      });

      await this.waitForMarker();

      // Suppress progress bars
      await this.execRaw("$ProgressPreference = 'SilentlyContinue'", 5_000);

      const upn = process.env.DLM_UPN;
      const org = process.env.DLM_ORGANIZATION;
      if (!upn || !org) {
        throw new Error("Environment variables DLM_UPN and DLM_ORGANIZATION are required.");
      }

      // Step 0: Pre-import ExchangeOnlineManagement module
      lastStage = "module-import";
      process.stderr.write("[PsExecutor] Importing ExchangeOnlineManagement module\u2026\n");
      await this.execRaw("Import-Module ExchangeOnlineManagement -ErrorAction Stop", 30_000);
      process.stderr.write("[PsExecutor] Module imported \u2713\n");

      // Step 1: Acquire access token via MSAL interactive browser
      lastStage = "token-acquire";
      process.stderr.write("[PsExecutor] Acquiring access token (browser will open)\u2026\n");
      const token = await this.acquireAccessToken("https://outlook.office365.com/.default", upn, org, 300_000);

      // Step 2: Connect Exchange Online with the token
      lastStage = "exo-connect";
      process.stderr.write("[PsExecutor] Connecting to Exchange Online\u2026\n");
      await this.execRaw(
        `Connect-ExchangeOnline -AccessToken '${token}' ` + `-Organization '${this.escape(org)}' -ShowBanner:$false`,
        120_000,
      );

      // Step 3: Connect IPPSSession with the same token
      lastStage = "ipps-connect";
      process.stderr.write("[PsExecutor] Connecting to Security & Compliance (IPPSSession)\u2026\n");
      await this.execRaw(`$_ippsToken = '${token}'`, 5_000);
      const sccCmdlets = [
        "Get-RetentionCompliancePolicy",
        "Get-RetentionComplianceRule",
        "Get-AdaptiveScope",
        "Get-ComplianceTag",
      ];
      await this.execRaw(
        `Connect-IPPSSession -AccessToken $_ippsToken ` +
          `-Organization '${this.escape(org)}' ` +
          `-CommandName ${sccCmdlets.join(",")} ` +
          `-ShowBanner:$false -ErrorAction Stop`,
        120_000,
      );

      this.ready = true;
      process.stderr.write("[PsExecutor] Sessions connected \u2713\n");
      this.telemetry?.trackEvent(
        "SessionInitialized",
        { success: "true", stage: lastStage },
        { durationMs: Date.now() - initStart },
      );
    } catch (err) {
      this.telemetry?.trackEvent(
        "SessionInitFailed",
        {
          stage: lastStage,
          errorType: err instanceof Error ? err.constructor.name : "Unknown",
        },
        { durationMs: Date.now() - initStart },
      );
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    if (this.proc) {
      this.proc.stdin!.end("exit\n");
      this.proc.kill();
      this.proc = null;
      this.ready = false;
    }
  }

  /* ───────── Token Acquisition ───────── */

  /**
   * Spawn a dedicated short-lived pwsh process to acquire an access token
   * via MSAL's AcquireTokenInteractive. This opens the system browser for
   * sign-in and captures the token from stdout.
   */
  private acquireAccessToken(scope: string, upn: string, org: string, timeoutMs: number): Promise<string> {
    const appId = "fb78d390-0c51-40cd-8e17-fdbfab77341b"; // EXO v3 REST API
    const escapedUpn = this.escape(upn);

    const script = [
      `$ErrorActionPreference = 'Stop'`,
      `$exoModule = Get-Module ExchangeOnlineManagement -ListAvailable | Select-Object -First 1`,
      `if (-not $exoModule) { throw 'ExchangeOnlineManagement module not found' }`,
      `$msalPath = Join-Path $exoModule.ModuleBase 'NetCore' 'Microsoft.Identity.Client.dll'`,
      `if (-not (Test-Path $msalPath)) { $msalPath = Join-Path $exoModule.ModuleBase 'NetFramework' 'Microsoft.Identity.Client.dll' }`,
      `if (-not (Test-Path $msalPath)) { throw 'MSAL DLL not found in EXO module' }`,
      `Add-Type -Path $msalPath -ErrorAction SilentlyContinue`,
      ``,
      `$authority = 'https://login.microsoftonline.com/${this.escape(org)}'`,
      `$appBuilder = [Microsoft.Identity.Client.PublicClientApplicationBuilder]::Create('${appId}')`,
      `$appBuilder = $appBuilder.WithAuthority($authority)`,
      `$appBuilder = $appBuilder.WithRedirectUri('http://localhost')`,
      `$app = $appBuilder.Build()`,
      ``,
      `$scopes = [string[]]@('${scope}')`,
      ``,
      `# Try silent first (cached token)`,
      `$accounts = $app.GetAccountsAsync().GetAwaiter().GetResult()`,
      `$account = $accounts | Where-Object { $_.Username -eq '${escapedUpn}' } | Select-Object -First 1`,
      `if ($account) {`,
      `  try {`,
      `    $silentResult = $app.AcquireTokenSilent($scopes, $account).ExecuteAsync().GetAwaiter().GetResult()`,
      `    [Console]::Error.WriteLine('[PsExecutor] Token acquired silently (cached)')`,
      `    [Console]::Out.Write($silentResult.AccessToken)`,
      `    exit 0`,
      `  } catch { }`,
      `}`,
      ``,
      `# Interactive browser auth`,
      `[Console]::Error.WriteLine('[PsExecutor] Opening browser for sign-in\u2026')`,
      `$builder = $app.AcquireTokenInteractive($scopes)`,
      `$builder = $builder.WithLoginHint('${escapedUpn}')`,
      `$builder = $builder.WithUseEmbeddedWebView($false)`,
      `$tokenResult = $builder.ExecuteAsync().GetAwaiter().GetResult()`,
      ``,
      `[Console]::Error.WriteLine('[PsExecutor] Token acquired successfully')`,
      `[Console]::Out.Write($tokenResult.AccessToken)`,
    ].join("\n");

    return new Promise<string>((resolve, reject) => {
      const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString();
        stderr += msg;
        process.stderr.write(msg);
      });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Token acquisition timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Token acquisition failed (exit ${code}): ${stderr.trim()}`));
          return;
        }
        const token = stdout.trim();
        if (!token || token.length < 100) {
          reject(new Error(`Invalid access token (length=${token?.length}). stderr: ${stderr.trim()}`));
          return;
        }
        process.stderr.write(`[PsExecutor] Access token acquired (${token.length} chars)\n`);
        resolve(token);
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn PowerShell for auth: ${err.message}`));
      });
    });
  }

  /* ───────── Public API ───────── */

  async execute(command: string): Promise<PsResult> {
    if (!this.ready) {
      return { success: false, output: "", error: "PowerShell session not initialized" };
    }
    const v = validateCommand(command);
    if (!v.valid) {
      if (v.blockedVerb) {
        this.telemetry?.trackEvent("CommandValidationBlocked", { blockedVerb: v.blockedVerb });
      }
      return { success: false, output: "", error: v.violation };
    }
    try {
      const out = await this.execRaw(command);
      if (out.startsWith("PS_ERROR:")) {
        return { success: false, output: "", error: out.slice(10).trim() };
      }
      return { success: true, output: out };
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  }

  async executeJson<T = unknown>(command: string): Promise<PsJsonResult<T>> {
    const r = await this.execute(command);
    if (!r.success) return { success: false, raw: r.output, error: r.error };
    try {
      const data = JSON.parse(r.output) as T;
      return { success: true, data, raw: r.output };
    } catch {
      return { success: true, raw: r.output };
    }
  }

  /* ───────── Internals ───────── */

  private execRaw(command: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error("No pwsh process"));

      const marker = `__MCP_END_${randomUUID()}__`;
      this.buf = "";

      const script =
        `try { ${command} } catch { Write-Output "PS_ERROR: $($_.Exception.Message)" }; ` +
        `Write-Output '${marker}'\n`;

      const timeout = setTimeout(() => {
        this.telemetry?.trackEvent("CommandTimeout", {}, { timeoutMs });
        reject(new Error("Command timed out"));
      }, timeoutMs);

      const poll = setInterval(() => {
        const idx = this.buf.indexOf(marker);
        if (idx !== -1) {
          clearInterval(poll);
          clearTimeout(timeout);
          const output = this.buf.substring(0, idx).trim();
          this.buf = this.buf.substring(idx + marker.length);
          resolve(output);
        }
      }, 150);

      this.proc.stdin!.write(script);
    });
  }

  private waitForMarker(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error("No pwsh process"));
      const marker = `__READY_${randomUUID()}__`;
      this.buf = "";
      this.proc.stdin!.write(`Write-Output '${marker}'\n`);

      const timeout = setTimeout(() => reject(new Error("pwsh startup timeout")), 30_000);
      const poll = setInterval(() => {
        if (this.buf.includes(marker)) {
          clearInterval(poll);
          clearTimeout(timeout);
          this.buf = "";
          resolve();
        }
      }, 100);
    });
  }

  private escape(value: string): string {
    return value.replace(/'/g, "''");
  }
}
