// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { validateCommand } from "./allowlist.js";
import { COMMAND_TIMEOUT_MS } from "../config.js";
import type { Telemetry } from "../telemetry.js";

// ─── Environment Isolation ───

/**
 * Allowlist of environment variables passed through to the pwsh subprocess.
 * Everything else — including DLM_GITHUB_TOKEN, DLM_UPN, DLM_ORGANIZATION,
 * and any AZURE_, AWS_, or GITHUB_ secrets in the operator's shell — is
 * withheld from the child so a successful cmdlet-allowlist bypass cannot
 * exfiltrate them via `$env:NAME`.
 */
const SAFE_ENV_KEYS = [
  // Windows
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "windir",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "TEMP",
  "TMP",
  "COMPUTERNAME",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PUBLIC",
  "ALLUSERSPROFILE",
  // PowerShell-specific
  "PSModulePath",
  "POWERSHELL_DISTRIBUTION_CHANNEL",
  // POSIX (cross-platform support)
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "SHELL",
];

function buildSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

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

// ─── Runspace Hardening ───

/**
 * Cmdlets/functions that `hardenRunspace()` overrides with throwing stubs as a
 * Layer-2 defense-in-depth measure (the cmdlet allowlist is Layer 1). Every
 * name here is also rejected by `validateCommand`; the runspace override exists
 * to catch obfuscated bypasses (e.g. `& ('Invoke' + '-Expression')`) that the
 * Layer-1 regex cannot see.
 *
 * IMPORTANT (issue #44): this list must NOT contain `Invoke-WebRequest`,
 * `Invoke-RestMethod`, or `Add-Type`. ExchangeOnlineManagement v3 generates
 * client-side REST proxy functions for Get- and Test- cmdlets that call those
 * primitives internally; overriding them with throwing stubs breaks every EXO
 * and Security & Compliance cmdlet with a misleading "server side error".
 */
export const HARDENED_COMMAND_OVERRIDES = [
  // NOTE: Invoke-WebRequest, Invoke-RestMethod, and Add-Type are deliberately
  // NOT listed here (issue #44) — EXO v3 REST proxies call them internally.
  // For user input they stay blocked by validateCommand at Layer 1: the literal
  // tokens via its verb-prefix rules (invoke-/add-), and the call-operator
  // obfuscation `& ('Invoke' + '-RestMethod')` via its call-operator check.
  "Invoke-Expression",
  "Invoke-Command",
  "Start-Process",
  "Connect-ExchangeOnline",
  "Connect-IPPSSession",
  "Disconnect-ExchangeOnline",
  "Disconnect-IPPSSession",
];

/**
 * Build the PowerShell statements that harden the long-lived runspace: remove
 * high-risk aliases and override each entry in `HARDENED_COMMAND_OVERRIDES`
 * with a function that throws. Pure (no I/O) so it can be unit-tested.
 */
export function buildHardeningStatements(): string[] {
  const denyMsg = "Disabled by Purview DLM MCP security policy";
  return [
    "Remove-Item Alias:iwr, Alias:irm, Alias:iex, Alias:icm, Alias:curl, Alias:wget, Alias:saps -Force -ErrorAction SilentlyContinue",
    ...HARDENED_COMMAND_OVERRIDES.map((name) => `function global:${name} { throw '${denyMsg}' }`),
  ];
}

/**
 * Build the marker-delimited script piped to the long-lived pwsh process for a
 * single command. The command runs inside a try/catch whose catch emits a
 * `PS_ERROR:` sentinel that `execute()` turns into `{ success: false }`; the
 * trailing marker tells the stdout poller the command has finished.
 *
 * When `stopOnError` is true (user-supplied commands), `$ErrorActionPreference`
 * is forced to 'Stop' so EXO's *non-terminating* `Write-Error` records are
 * promoted to terminating errors and caught here, instead of being silently
 * swallowed and reported as `{ success: true, output: "" }` (issue #44). It is
 * left false for trusted init/internal commands, which run at top scope and
 * must keep their default error semantics.
 *
 * Trade-off (deliberate): under 'Stop', a non-terminating error on one item in
 * a multi-item command (e.g. `Get-Mailbox a,b,c` where `b` is invalid) aborts
 * the whole command instead of returning partial results. For a diagnostics
 * tool, surfacing the failure honestly is preferred over silent empty output.
 */
export function buildMarkedScript(command: string, marker: string, stopOnError = false): string {
  const eap = stopOnError ? "$ErrorActionPreference = 'Stop'; " : "";
  return (
    `try { ${eap}${command} } catch { Write-Output "PS_ERROR: $($_.Exception.Message)" }; ` +
    `Write-Output '${marker}'\n`
  );
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
        env: buildSafeEnv(),
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

      // Step 4: Scrub the access token from session scope. Connect-IPPSSession
      // only needs the token at connection time; afterwards the session uses
      // its own internal credential cache. Removing the variable prevents any
      // future allowlist bypass from exfiltrating `$_ippsToken`.
      lastStage = "token-scrub";
      await this.execRaw(
        "Remove-Variable _ippsToken -Force -ErrorAction SilentlyContinue; [System.GC]::Collect() | Out-Null",
        5_000,
      );

      // Step 5: Harden the runspace before user commands can flow through
      // execute(). Even if validateCommand is ever bypassed, the runspace
      // itself refuses to invoke these primitives.
      lastStage = "runspace-harden";
      await this.hardenRunspace();

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

  /* ───────── Runspace Hardening ───────── */

  /**
   * Lock down the long-lived pwsh session before user commands can run.
   * Removes high-risk aliases and overrides dangerous cmdlets with functions
   * that throw. This is the Node-spawned equivalent of TypeAgent's
   * `InitialSessionState.Commands.Remove()` approach: a defense-in-depth layer
   * that survives any future validateCommand bypass.
   */
  private async hardenRunspace(): Promise<void> {
    await this.execRaw(buildHardeningStatements().join("; "), 10_000);
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
        env: buildSafeEnv(),
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
      // stopOnError=true: promote EXO's non-terminating Write-Error to a
      // terminating error so it surfaces instead of returning empty output.
      const out = await this.execRaw(command, COMMAND_TIMEOUT_MS, true);
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

  private execRaw(command: string, timeoutMs = COMMAND_TIMEOUT_MS, stopOnError = false): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error("No pwsh process"));

      const marker = `__MCP_END_${randomUUID()}__`;
      this.buf = "";

      const script = buildMarkedScript(command, marker, stopOnError);

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
