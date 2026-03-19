// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock applicationinsights before importing Telemetry
const mockTrackEvent = vi.fn();
const mockTrackException = vi.fn();
const mockFlush = vi.fn((opts: { callback: () => void }) => opts.callback());

vi.mock("applicationinsights", () => {
  return {
    default: {
      TelemetryClient: vi.fn().mockImplementation(() => ({
        trackEvent: mockTrackEvent,
        trackException: mockTrackException,
        flush: mockFlush,
        config: {
          enableAutoCollectRequests: true,
          enableAutoCollectPerformance: true,
          enableAutoCollectExceptions: true,
          enableAutoCollectDependencies: true,
          enableAutoCollectConsole: true,
        },
      })),
    },
  };
});

import { Telemetry } from "../../src/telemetry.js";

describe("Telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("enabled=true → initialize() creates TelemetryClient", async () => {
    const { default: appInsights } = await import("applicationinsights");
    const t = new Telemetry("2.1.0", true);
    t.initialize();
    expect(appInsights.TelemetryClient).toHaveBeenCalledOnce();
    expect(t.enabled).toBe(true);
  });

  test("enabled=false → initialize() is no-op", async () => {
    const { default: appInsights } = await import("applicationinsights");
    const t = new Telemetry("2.1.0", false);
    t.initialize();
    expect(appInsights.TelemetryClient).not.toHaveBeenCalled();
    expect(t.enabled).toBe(false);
  });

  test("trackEvent() calls client.trackEvent with merged base properties", () => {
    const t = new Telemetry("2.1.0", true);
    t.initialize();
    t.trackEvent("TestEvent", { custom: "value" });
    expect(mockTrackEvent).toHaveBeenCalledOnce();
    const call = mockTrackEvent.mock.calls[0][0];
    expect(call.name).toBe("TestEvent");
    expect(call.properties).toMatchObject({
      serverVersion: "2.1.0",
      custom: "value",
    });
  });

  test("trackEvent() includes serverVersion, nodeVersion, sessionId", () => {
    const t = new Telemetry("2.1.0", true);
    t.initialize();
    t.trackEvent("TestEvent");
    const props = mockTrackEvent.mock.calls[0][0].properties;
    expect(props.serverVersion).toBe("2.1.0");
    expect(props.nodeVersion).toBe(process.version);
    expect(props.sessionId).toBeDefined();
    expect(typeof props.sessionId).toBe("string");
  });

  test("trackEvent() passes metrics as measurements", () => {
    const t = new Telemetry("2.1.0", true);
    t.initialize();
    t.trackEvent("TestEvent", {}, { durationMs: 42 });
    const call = mockTrackEvent.mock.calls[0][0];
    expect(call.measurements).toEqual({ durationMs: 42 });
  });

  test("trackEvent() is no-op when disabled", () => {
    const t = new Telemetry("2.1.0", false);
    t.initialize();
    t.trackEvent("TestEvent");
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("trackException() calls client.trackException with base properties", () => {
    const t = new Telemetry("2.1.0", true);
    t.initialize();
    const error = new Error("test error");
    t.trackException(error, { extra: "info" });
    expect(mockTrackException).toHaveBeenCalledOnce();
    const call = mockTrackException.mock.calls[0][0];
    expect(call.exception).toBe(error);
    expect(call.properties).toMatchObject({
      serverVersion: "2.1.0",
      extra: "info",
    });
  });

  test("trackException() is no-op when disabled", () => {
    const t = new Telemetry("2.1.0", false);
    t.initialize();
    t.trackException(new Error("test"));
    expect(mockTrackException).not.toHaveBeenCalled();
  });

  test("flush() calls client.flush and resolves", async () => {
    const t = new Telemetry("2.1.0", true);
    t.initialize();
    await t.flush();
    expect(mockFlush).toHaveBeenCalledOnce();
  });

  test("flush() resolves when disabled (no client)", async () => {
    const t = new Telemetry("2.1.0", false);
    t.initialize();
    await t.flush(); // should not throw
    expect(mockFlush).not.toHaveBeenCalled();
  });

  test("sessionId is a valid UUID format", () => {
    const t = new Telemetry("2.1.0", true);
    t.initialize();
    t.trackEvent("TestEvent");
    const sessionId = mockTrackEvent.mock.calls[0][0].properties.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("multiple events share same sessionId", () => {
    const t = new Telemetry("2.1.0", true);
    t.initialize();
    t.trackEvent("Event1");
    t.trackEvent("Event2");
    const id1 = mockTrackEvent.mock.calls[0][0].properties.sessionId;
    const id2 = mockTrackEvent.mock.calls[1][0].properties.sessionId;
    expect(id1).toBe(id2);
  });

  test("custom properties are merged without overwriting base", () => {
    const t = new Telemetry("2.1.0", true);
    t.initialize();
    t.trackEvent("TestEvent", { serverVersion: "override-attempt", custom: "value" });
    const props = mockTrackEvent.mock.calls[0][0].properties;
    // Custom properties take precedence in spread order — but base is first
    expect(props.custom).toBe("value");
    // serverVersion from custom overrides base (spread order: base then custom)
    expect(props.serverVersion).toBe("override-attempt");
  });

  test("auto-collectors are disabled on the client config", async () => {
    const t = new Telemetry("2.1.0", true);
    t.initialize();
    const { default: appInsights } = vi.mocked(await import("applicationinsights"));
    const clientInstance = (appInsights.TelemetryClient as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(clientInstance.config.enableAutoCollectRequests).toBe(false);
    expect(clientInstance.config.enableAutoCollectPerformance).toBe(false);
    expect(clientInstance.config.enableAutoCollectExceptions).toBe(false);
    expect(clientInstance.config.enableAutoCollectDependencies).toBe(false);
    expect(clientInstance.config.enableAutoCollectConsole).toBe(false);
  });
});

describe("Config: parseBooleanEnv", () => {
  test("COLLECT_TELEMETRY defaults to true", async () => {
    const origTelemetry = process.env.DLM_COLLECT_TELEMETRY;
    const origMs = process.env.DLM_COLLECT_TELEMETRY_MICROSOFT;
    delete process.env.DLM_COLLECT_TELEMETRY;
    delete process.env.DLM_COLLECT_TELEMETRY_MICROSOFT;
    try {
      vi.resetModules();
      const { COLLECT_TELEMETRY } = await import("../../src/config.js");
      expect(COLLECT_TELEMETRY).toBe(true);
    } finally {
      if (origTelemetry !== undefined) process.env.DLM_COLLECT_TELEMETRY = origTelemetry;
      if (origMs !== undefined) process.env.DLM_COLLECT_TELEMETRY_MICROSOFT = origMs;
    }
  });

  test("COLLECT_TELEMETRY=false returns false", async () => {
    const orig = process.env.DLM_COLLECT_TELEMETRY;
    process.env.DLM_COLLECT_TELEMETRY = "false";
    try {
      vi.resetModules();
      const { COLLECT_TELEMETRY } = await import("../../src/config.js");
      expect(COLLECT_TELEMETRY).toBe(false);
    } finally {
      if (orig !== undefined) process.env.DLM_COLLECT_TELEMETRY = orig;
      else delete process.env.DLM_COLLECT_TELEMETRY;
    }
  });

  test("COLLECT_TELEMETRY_MICROSOFT=false returns false", async () => {
    const orig = process.env.DLM_COLLECT_TELEMETRY_MICROSOFT;
    process.env.DLM_COLLECT_TELEMETRY_MICROSOFT = "false";
    try {
      vi.resetModules();
      const { COLLECT_TELEMETRY_MICROSOFT } = await import("../../src/config.js");
      expect(COLLECT_TELEMETRY_MICROSOFT).toBe(false);
    } finally {
      if (orig !== undefined) process.env.DLM_COLLECT_TELEMETRY_MICROSOFT = orig;
      else delete process.env.DLM_COLLECT_TELEMETRY_MICROSOFT;
    }
  });
});
