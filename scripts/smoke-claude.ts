/**
 * §17.8 Real Integration Profile — Claude smoke test.
 *
 * Launches one real headless session in a temp workspace via our ClaudeClient,
 * runs two turns on the same live process, and asserts successful results with
 * usage fields. Requires an installed, authenticated `claude` CLI.
 *
 *   npx tsx scripts/smoke-claude.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeClient } from "../src/claudeClient.js";
import { resolveSettings } from "../src/config.js";
import type { ClaudeEvent } from "../src/types.js";

const ws = mkdtempSync(path.join(os.tmpdir(), "symphony-real-smoke-"));
const settings = resolveSettings(
  {
    claude: {
      model: "haiku",
      permission_mode: "default",
      read_timeout_ms: 60000,
      turn_timeout_ms: 180000,
    },
  },
  { workflowDir: ws },
);

const events: ClaudeEvent[] = [];
const client = new ClaudeClient(() => settings);

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  console.error("events:", JSON.stringify(events, null, 2));
  process.exit(1);
}

const session = client.startSession(ws, { onEvent: (e) => events.push(e) });

const r1 = await session.runTurn(
  "Reply with exactly the text SYMPHONY_OK and nothing else.",
  settings.claude.turn_timeout_ms,
  settings.claude.read_timeout_ms,
);
if (!r1.ok) fail(`turn 1 failed: ${r1.errorCode}`);
if (!session.claudeSessionId) fail("no session_id captured from system/init");
if (!r1.usage || r1.usage.total_tokens <= 0) fail("turn 1 result carried no usage");

const r2 = await session.runTurn(
  "Now reply with exactly the text TURN_TWO_OK and nothing else.",
  settings.claude.turn_timeout_ms,
  settings.claude.read_timeout_ms,
);
if (!r2.ok) fail(`turn 2 (continuation on live process) failed: ${r2.errorCode}`);

await session.stop();

const notifications = events.filter((e) => e.event === "notification").map((e) => e.message);
const turn1Ok = notifications.some((m) => m?.includes("SYMPHONY_OK"));
const turn2Ok = notifications.some((m) => m?.includes("TURN_TWO_OK"));

console.log("session_id        :", session.claudeSessionId);
console.log("turn1             :", JSON.stringify({ ok: r1.ok, usage: r1.usage, cost: r1.totalCostUsd }));
console.log("turn2             :", JSON.stringify({ ok: r2.ok, usage: r2.usage, cost: r2.totalCostUsd }));
console.log("assistant replies :", JSON.stringify(notifications));
console.log("event sequence    :", events.map((e) => e.event).join(" -> "));

if (!turn1Ok || !turn2Ok) fail("expected reply text not observed in assistant notifications");
if ((r2.usage?.total_tokens ?? 0) < (r1.usage?.total_tokens ?? 0)) {
  console.warn("note: turn 2 usage not cumulative-growing; check result.usage semantics");
}

rmSync(ws, { recursive: true, force: true });
console.log("SMOKE PASS");
