// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import appInsights from "applicationinsights";
import { randomUUID } from "crypto";

// 1P Application Insights connection string (write-only ingestion identifier, not a secret).
// See docs/design/telemetry.md §4.1 for rationale on embedding this in source.
const CONNECTION_STRING =
  "InstrumentationKey=470f24ba-d4b2-40cf-b397-dbf8c08bf13d;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=6620ee33-e218-4783-ba30-c407a085f729";

/**
 * Singleton telemetry wrapper around Application Insights.
 * When disabled, all methods are no-ops.
 */
export class Telemetry {
  private client: appInsights.TelemetryClient | null = null;
  private readonly serverVersion: string;
  private readonly _enabled: boolean;
  private readonly sessionId: string;
  private readonly baseProperties: Record<string, string>;

  constructor(serverVersion: string, enabled: boolean) {
    this.serverVersion = serverVersion;
    this._enabled = enabled;
    this.sessionId = randomUUID();
    this.baseProperties = {
      serverVersion: this.serverVersion,
      nodeVersion: process.version,
      sessionId: this.sessionId,
    };
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** Create the TelemetryClient and disable all auto-collectors. */
  initialize(): void {
    if (!this._enabled) return;

    this.client = new appInsights.TelemetryClient(CONNECTION_STRING);

    // Disable all auto-collectors — we only emit explicit custom events.
    this.client.config.enableAutoCollectRequests = false;
    this.client.config.enableAutoCollectPerformance = false;
    this.client.config.enableAutoCollectExceptions = false;
    this.client.config.enableAutoCollectDependencies = false;
    this.client.config.enableAutoCollectConsole = false;
  }

  /** Track a named custom event with optional properties and metrics. */
  trackEvent(name: string, properties?: Record<string, string>, metrics?: Record<string, number>): void {
    if (!this.client) return;
    this.client.trackEvent({
      name,
      properties: { ...this.baseProperties, ...properties },
      measurements: metrics,
    });
  }

  /** Track an exception with optional properties. */
  trackException(error: Error, properties?: Record<string, string>): void {
    if (!this.client) return;
    this.client.trackException({
      exception: error,
      properties: { ...this.baseProperties, ...properties },
    });
  }

  /** Flush pending telemetry with a 5-second safety timeout. */
  async flush(): Promise<void> {
    if (!this.client) return;
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      this.client!.flush({
        callback: () => {
          clearTimeout(timeout);
          resolve();
        },
      });
    });
  }
}
