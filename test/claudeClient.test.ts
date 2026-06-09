/** §17.5 Claude Code Headless Client — against a fake `claude` subprocess */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeClient, extractUsage } from "../src/claudeClient.js";
import { makeSettings, tempDir } from "./helpers.js";
import type { ClaudeEvent, Settings } from "../src/types.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.cjs");

function fakeSettings(mode: string, overrides: Record<string, unknown> = {}): Settings {
  return makeSettings({
    claude: {
      command: `FAKE_MODE=${mode} node ${FAKE}`,
      read_timeout_ms: 1500,
      turn_timeout_ms: 5000,
      ...overrides,
    },
  });
}

function collectEvents(): { events: ClaudeEvent[]; onEvent: (e: ClaudeEvent) => void } {
  const events: ClaudeEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

describe("launch contract (§10.1, §9.5)", () => {
  it("launches via bash -lc with the workspace as cwd and captures session_id from init", async () => {
    const ws = tempDir();
    const { events, onEvent } = collectEvents();
    const client = new ClaudeClient(() => fakeSettings("ok"));
    const session = client.startSession(ws, { onEvent });

    const result = await session.runTurn("do the thing", 5000, 1500);
    expect(result.ok).toBe(true);
    expect(session.claudeSessionId).toBe("sess-fake-1");

    // The fake process wrote proof of its cwd into the workspace.
    expect(existsSync(path.join(ws, "launched_here.txt"))).toBe(true);
    expect(readFileSync(path.join(ws, "launched_here.txt"), "utf8")).toBe(ws);

    expect(events.map((e) => e.event)).toContain("session_started");
    expect(events.map((e) => e.event)).toContain("turn_completed");
    await session.stop();
  });
});

describe("turn processing (§10.3, §10.6)", () => {
  it("completes on a success result with cumulative usage and cost", async () => {
    const ws = tempDir();
    const { onEvent } = collectEvents();
    const session = new ClaudeClient(() => fakeSettings("ok")).startSession(ws, { onEvent });
    const r1 = await session.runTurn("turn one", 5000, 1500);
    expect(r1).toMatchObject({ ok: true, totalCostUsd: 0.01 });
    expect(r1.usage).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });

    // Continuation turn on the same live process (§10.2): usage stays cumulative.
    const r2 = await session.runTurn("turn two", 5000, 1500);
    expect(r2.ok).toBe(true);
    expect(r2.usage).toEqual({ input_tokens: 250, output_tokens: 120, total_tokens: 370 });
    expect(r2.totalCostUsd).toBeCloseTo(0.02);
    await session.stop();
  });

  it("maps an error result to turn_failed", async () => {
    const ws = tempDir();
    const { events, onEvent } = collectEvents();
    const session = new ClaudeClient(() => fakeSettings("error")).startSession(ws, { onEvent });
    const r = await session.runTurn("fail please", 5000, 1500);
    expect(r).toMatchObject({ ok: false, errorCode: "turn_failed" });
    expect(events.map((e) => e.event)).toContain("turn_failed");
    await session.stop();
  });

  it("enforces the turn timeout", async () => {
    const ws = tempDir();
    const { onEvent } = collectEvents();
    const session = new ClaudeClient(() => fakeSettings("hang")).startSession(ws, { onEvent });
    const r = await session.runTurn("hang forever", 400, 1500);
    expect(r).toMatchObject({ ok: false, errorCode: "turn_timeout" });
  });

  it("enforces read_timeout while waiting for system/init", async () => {
    const ws = tempDir();
    const { events, onEvent } = collectEvents();
    const session = new ClaudeClient(() => fakeSettings("noinit")).startSession(ws, { onEvent });
    const r = await session.runTurn("hello", 5000, 300);
    expect(r).toMatchObject({ ok: false, errorCode: "response_timeout" });
    expect(events.map((e) => e.event)).toContain("startup_failed");
  });

  it("works when init only arrives after the first input line", async () => {
    const ws = tempDir();
    const { events, onEvent } = collectEvents();
    const session = new ClaudeClient(() => fakeSettings("initafterinput")).startSession(ws, { onEvent });
    const r = await session.runTurn("hello", 5000, 1500);
    expect(r.ok).toBe(true);
    expect(session.claudeSessionId).toBe("sess-fake-1");
    expect(events.map((e) => e.event)).toContain("session_started");
    await session.stop();
  });

  it("maps subprocess death before result to process_exit", async () => {
    const ws = tempDir();
    const { onEvent } = collectEvents();
    const session = new ClaudeClient(() => fakeSettings("die")).startSession(ws, { onEvent });
    const r = await session.runTurn("die now", 5000, 1500);
    expect(r).toMatchObject({ ok: false, errorCode: "process_exit" });
  });

  it("surfaces malformed protocol lines as events without breaking the turn", async () => {
    const ws = tempDir();
    const { events, onEvent } = collectEvents();
    const session = new ClaudeClient(() => fakeSettings("malformed")).startSession(ws, { onEvent });
    const r = await session.runTurn("go", 5000, 1500);
    expect(r.ok).toBe(true);
    expect(events.map((e) => e.event)).toContain("malformed");
    await session.stop();
  });

  it("extracts api_retry and rate_limit telemetry (§13.5)", async () => {
    const ws = tempDir();
    const { events, onEvent } = collectEvents();
    const session = new ClaudeClient(() => fakeSettings("apiretry")).startSession(ws, { onEvent });
    const r = await session.runTurn("go", 5000, 1500);
    expect(r.ok).toBe(true);
    const retry = events.find((e) => e.event === "api_retry");
    expect(retry?.payload).toMatchObject({ attempt: 1, max_retries: 5, retry_delay_ms: 250, error: "overloaded" });
    const rateLimit = events.find((e) => e.event === "rate_limit");
    expect(rateLimit?.payload).toMatchObject({ status: "allowed_warning", rateLimitType: "five_hour" });
    await session.stop();
  });

  it("extracts text from split assistant events sharing one message.id", async () => {
    const ws = tempDir();
    const { events, onEvent } = collectEvents();
    const session = new ClaudeClient(() => fakeSettings("ok")).startSession(ws, { onEvent });
    await session.runTurn("go", 5000, 1500);
    // fake emits thinking, text, and tool_use events all sharing msg_1; only
    // the text-bearing event becomes a notification.
    const notifications = events.filter((e) => e.event === "notification");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.message).toContain("working on turn 1");
    await session.stop();
  });

  it("stop() closes stdin and lets the process exit", async () => {
    const ws = tempDir();
    const { onEvent } = collectEvents();
    const session = new ClaudeClient(() => fakeSettings("ok")).startSession(ws, { onEvent });
    await session.runTurn("go", 5000, 1500);
    await session.stop();
    expect(session.hasExited).toBe(true);
  });
});

describe("usage extraction (§13.5)", () => {
  it("counts cache tokens toward input/total and ignores empty payloads", () => {
    expect(
      extractUsage({ input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 10, cache_read_input_tokens: 50 }),
    ).toEqual({ input_tokens: 160, output_tokens: 40, total_tokens: 200 });
    expect(extractUsage({})).toBeUndefined();
    expect(extractUsage(null)).toBeUndefined();
  });
});
