#!/usr/bin/env node
/**
 * Fake Claude Code headless process for tests.
 *
 * Speaks just enough stream-json: emits system/init at spawn (unless
 * FAKE_MODE=noinit or initafterinput), then per user message emits assistant
 * + result lines. Modes via FAKE_MODE env var:
 *   ok            - success result with cumulative usage per turn
 *   error         - result with is_error=true
 *   hang          - never emits a result (for turn-timeout tests)
 *   die           - exits without a result after first input
 *   noinit        - never emits init (for read-timeout tests)
 *   initafterinput- emits init only after the first user message
 *   malformed     - emits a garbage line, then a success result
 *   apiretry      - emits a system/api_retry, then a success result
 */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const mode = process.env.FAKE_MODE || "ok";
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// Prove we were launched with the workspace as cwd (spec §9.5 invariant 1).
try {
  fs.writeFileSync(path.join(process.cwd(), "launched_here.txt"), process.cwd());
} catch {}

const SESSION_ID = "sess-fake-1";
if (mode !== "noinit" && mode !== "initafterinput") {
  out({ type: "system", subtype: "init", session_id: SESSION_ID, cwd: process.cwd() });
}

let turns = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type !== "user") return;
  turns += 1;

  if (mode === "initafterinput" && turns === 1) {
    out({ type: "system", subtype: "init", session_id: SESSION_ID, cwd: process.cwd() });
  }
  if (mode === "noinit") return; // silence: client read-timeout should fire
  if (mode === "hang") return;
  if (mode === "die") {
    process.exit(3);
  }
  if (mode === "malformed") {
    process.stdout.write("this is not json\n");
  }
  if (mode === "apiretry") {
    out({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 5, retry_delay_ms: 250, error: "overloaded" });
    out({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", resetsAt: 1781046000, rateLimitType: "five_hour" },
      session_id: SESSION_ID,
    });
  }

  // The real CLI splits one assistant message across several events sharing
  // one message.id: thinking first, then text, then tool_use. Text must still
  // be extracted from the repeated-id event.
  out({
    type: "assistant",
    message: { id: `msg_${turns}`, content: [{ type: "thinking", thinking: "let me think", signature: "sig" }] },
    session_id: SESSION_ID,
  });
  out({
    type: "assistant",
    message: {
      id: `msg_${turns}`,
      content: [{ type: "text", text: `working on turn ${turns}` }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    session_id: SESSION_ID,
  });
  out({
    type: "assistant",
    message: { id: `msg_${turns}`, content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    session_id: SESSION_ID,
  });

  if (mode === "error") {
    out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: SESSION_ID });
    return;
  }

  // Cumulative usage grows across turns: 100/50 then 250/120, etc.
  const cumulative = { input_tokens: 100 * turns + 50 * (turns - 1), output_tokens: 50 * turns + 20 * (turns - 1) };
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    usage: cumulative,
    total_cost_usd: 0.01 * turns,
    num_turns: 2,
    session_id: SESSION_ID,
  });
});
rl.on("close", () => process.exit(0));
