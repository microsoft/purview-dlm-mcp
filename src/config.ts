// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

function parsePositiveInt(envVar: string, defaultValue: number): number {
  const env = process.env[envVar];
  if (env !== undefined) {
    const value = parseInt(env, 10);
    if (!isNaN(value) && value > 0) return value;
  }
  return defaultValue;
}

/** Default timeout (ms) for PowerShell commands executed via run_powershell. */
export const COMMAND_TIMEOUT_MS = parsePositiveInt("DLM_COMMAND_TIMEOUT_MS", 180_000);

function parseBooleanEnv(envVar: string, defaultValue: boolean): boolean {
  const env = process.env[envVar];
  if (env === undefined) return defaultValue;
  return env.toLowerCase() !== "false";
}

/** Whether to collect telemetry at all. Set DLM_COLLECT_TELEMETRY=false to opt out. */
export const COLLECT_TELEMETRY = parseBooleanEnv("DLM_COLLECT_TELEMETRY", true);

/** Whether to send telemetry to the Microsoft 1P App Insights resource. */
export const COLLECT_TELEMETRY_MICROSOFT = parseBooleanEnv("DLM_COLLECT_TELEMETRY_MICROSOFT", true);
