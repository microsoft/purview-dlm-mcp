// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, test, expect } from "vitest";
import {
  stripAnsi,
  parseFormatList,
  parseSingleRecord,
  isEmpty,
  parseSizeToBytes,
  boolVal,
  daysSince,
  parseFailure,
  Severity,
} from "../../src/tsg-diagnostics.js";

describe("OutputParsers", () => {
  test("stripAnsi removes escape codes", () => {
    const input = "\u001b[32;1mName\u001b[0m : TestPolicy";
    expect(stripAnsi(input)).toBe("Name : TestPolicy");
  });

  test("stripAnsi removes non-color CSI sequences pwsh emits on Linux", () => {
    expect(stripAnsi("\u001b[?1lPS_ERROR: boom")).toBe("PS_ERROR: boom");
    expect(stripAnsi("\u001b[?25h\u001b[2K2026")).toBe("2026");
  });

  test("stripAnsi preserves plain text", () => {
    expect(stripAnsi("Hello World")).toBe("Hello World");
  });

  test("parseFormatList single record", () => {
    const input = "Name         : TestPolicy\r\nEnabled      : True\r\nMode         : Enforce";
    const records = parseFormatList(input);
    expect(records).toHaveLength(1);
    expect(records[0]["Name"]).toBe("TestPolicy");
    expect(records[0]["Enabled"]).toBe("True");
    expect(records[0]["Mode"]).toBe("Enforce");
  });

  test("parseFormatList multiple records", () => {
    const input = "Name : Policy1\r\nEnabled : True\r\n\r\nName : Policy2\r\nEnabled : False";
    const records = parseFormatList(input);
    expect(records).toHaveLength(2);
    expect(records[0]["Name"]).toBe("Policy1");
    expect(records[1]["Name"]).toBe("Policy2");
  });

  test("parseFormatList empty input", () => {
    expect(parseFormatList("")).toHaveLength(0);
    expect(parseFormatList("   ")).toHaveLength(0);
  });

  test("parseFormatList with ANSI codes", () => {
    const input = "\u001b[32;1mName\u001b[0m : \u001b[32;1mTestPolicy\u001b[0m";
    const records = parseFormatList(input);
    expect(records).toHaveLength(1);
    expect(records[0]["Name"]).toBe("TestPolicy");
  });

  test("parseSingleRecord returns first", () => {
    const input = "Name : First\r\n\r\nName : Second";
    const record = parseSingleRecord(input);
    expect(record["Name"]).toBe("First");
  });

  test("parseSingleRecord empty returns empty dict", () => {
    const record = parseSingleRecord("");
    expect(Object.keys(record)).toHaveLength(0);
  });

  test.each([
    ["", true],
    ["{}", true],
    ["{},", true],
    ["$null", true],
    [undefined, true],
    [null, true],
    ["All", false],
    ["some value", false],
  ] as [string | undefined | null, boolean][])("isEmpty(%s) = %s", (val, expected) => {
    expect(isEmpty(val)).toBe(expected);
  });

  test.each([
    ["1.234 GB (1,325,400,064 bytes)", 1325400064],
    ["500 MB (524,288,000 bytes)", 524288000],
    ["100 GB (107,374,182,400 bytes)", 107374182400],
  ] as [string, number][])("parseSizeToBytes(%s) = %d", (input, expected) => {
    expect(parseSizeToBytes(input)).toBe(expected);
  });

  test.each(["invalid", "1.5 GB"])("parseSizeToBytes returns null for: %s", (input) => {
    expect(parseSizeToBytes(input)).toBeNull();
  });

  test.each([
    ["True", true],
    ["False", false],
    ["", null],
    ["Maybe", null],
  ] as [string, boolean | null][])("boolVal parses %s correctly", (value, expected) => {
    const record = { Key: value };
    expect(boolVal(record, "Key")).toBe(expected);
  });

  test("boolVal missing key returns null", () => {
    expect(boolVal({}, "Missing")).toBeNull();
  });

  test("daysSince valid date returns positive number", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const days = daysSince(twoDaysAgo);
    expect(days).not.toBeNull();
    expect(days!).toBeGreaterThan(1.5);
    expect(days!).toBeLessThan(2.5);
  });

  test("daysSince invalid date returns null", () => {
    expect(daysSince("not a date")).toBeNull();
  });

  test("parseFailure creates info check", () => {
    const result = parseFailure(1, "Test check", "TestField", "some raw value");
    expect(result.severity).toBe(Severity.Info);
    expect(result.finding).toContain("TestField");
    expect(result.finding).toContain("some raw value");
  });
});
