/** §17.4 Orchestrator Dispatch, Reconciliation, and Retry */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeBackoffMs,
  issueEligible,
  nextAttempt,
  Orchestrator,
  sortForDispatch,
} from "../src/orchestrator.js";
import { WorkspaceManager } from "../src/workspace.js";
import type { TrackerClient } from "../src/linear.js";
import type { Issue } from "../src/types.js";
import { makeIssue, makeStore, tempDir, VALID_TRACKER_YAML } from "./helpers.js";

class FakeTracker implements TrackerClient {
  candidates: Issue[] = [];
  refreshed: Issue[] = [];
  terminalIssues: Issue[] = [];
  failCandidates = false;
  failRefresh = false;
  async fetchCandidateIssues(): Promise<Issue[]> {
    if (this.failCandidates) throw new Error("candidate fetch failed");
    return this.candidates;
  }
  async fetchIssuesByStates(): Promise<Issue[]> {
    return this.terminalIssues;
  }
  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (this.failRefresh) throw new Error("refresh failed");
    return this.refreshed.filter((i) => ids.includes(i.id));
  }
}

interface Built {
  orch: Orchestrator;
  tracker: FakeTracker;
  cleanupCalls: string[];
  runs: { issue: Issue; attempt: number | null; finish: (err?: string) => void }[];
}

function build(extraYaml = ""): Built {
  const root = tempDir();
  const store = makeStore(`${VALID_TRACKER_YAML}\nworkspace:\n  root: ${root}\n${extraYaml}`);
  const tracker = new FakeTracker();
  const wsm = new WorkspaceManager(store.settings);
  const cleanupCalls: string[] = [];
  const origCleanup = wsm.cleanupForIssue.bind(wsm);
  wsm.cleanupForIssue = async (identifier: string) => {
    cleanupCalls.push(identifier);
    return origCleanup(identifier);
  };

  const runs: Built["runs"] = [];
  const orch = new Orchestrator({
    store,
    tracker,
    workspaceManager: wsm,
    runnerDeps: { claudeClient: {} as never },
    runAttempt: (_deps, issue, attempt) =>
      new Promise<void>((resolve, reject) => {
        runs.push({
          issue,
          attempt,
          finish: (err?: string) => (err ? reject(new Error(err)) : resolve()),
        });
      }),
  });
  return { orch, tracker, cleanupCalls, runs };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  vi.useRealTimers();
});

describe("pure decision functions", () => {
  it("sorts by priority asc (null last), then created_at oldest, then identifier (§8.2)", () => {
    const issues = [
      makeIssue({ id: "a", identifier: "MT-3", priority: null, created_at: "2026-01-01T00:00:00Z" }),
      makeIssue({ id: "b", identifier: "MT-2", priority: 2, created_at: "2026-01-03T00:00:00Z" }),
      makeIssue({ id: "c", identifier: "MT-1", priority: 2, created_at: "2026-01-02T00:00:00Z" }),
      makeIssue({ id: "d", identifier: "MT-0", priority: 1, created_at: "2026-01-09T00:00:00Z" }),
      makeIssue({ id: "e", identifier: "MT-4", priority: 2, created_at: "2026-01-02T00:00:00Z" }),
    ];
    expect(sortForDispatch(issues).map((i) => i.identifier)).toEqual(["MT-0", "MT-1", "MT-4", "MT-2", "MT-3"]);
  });

  it("computes 10s-based exponential backoff with a cap (§8.4)", () => {
    expect(computeBackoffMs(1, 300000)).toBe(10000);
    expect(computeBackoffMs(2, 300000)).toBe(20000);
    expect(computeBackoffMs(3, 300000)).toBe(40000);
    expect(computeBackoffMs(6, 300000)).toBe(300000); // capped
    expect(computeBackoffMs(50, 120000)).toBe(120000); // custom cap, no overflow
    expect(nextAttempt(null)).toBe(1);
    expect(nextAttempt(3)).toBe(4);
  });

  it("blocker rule: Todo with non-terminal blockers is not eligible (§8.2)", () => {
    const { orch } = build();
    void orch; // settings come from the store inside issueEligible
    const settings = makeSettingsFromStore();
    const blockedOpen = makeIssue({ blocked_by: [{ id: "x", identifier: "MT-9", state: "In Progress" }] });
    const blockedDone = makeIssue({ blocked_by: [{ id: "x", identifier: "MT-9", state: "Done" }] });
    const blockedUnknown = makeIssue({ blocked_by: [{ id: "x", identifier: "MT-9", state: null }] });
    const inProgressBlocked = makeIssue({
      state: "In Progress",
      blocked_by: [{ id: "x", identifier: "MT-9", state: "Todo" }],
    });
    expect(issueEligible(blockedOpen, settings)).toBe(false);
    expect(issueEligible(blockedDone, settings)).toBe(true);
    expect(issueEligible(blockedUnknown, settings)).toBe(false);
    // blocker rule applies to Todo only
    expect(issueEligible(inProgressBlocked, settings)).toBe(true);

    function makeSettingsFromStore() {
      return makeStore(VALID_TRACKER_YAML).settings();
    }
  });

  it("rejects issues missing required fields or in terminal/unknown states", () => {
    const settings = makeStore(VALID_TRACKER_YAML).settings();
    expect(issueEligible(makeIssue({ title: "" }), settings)).toBe(false);
    expect(issueEligible(makeIssue({ state: "Done" }), settings)).toBe(false);
    expect(issueEligible(makeIssue({ state: "Weird" }), settings)).toBe(false);
    expect(issueEligible(makeIssue({ state: "in progress" }), settings)).toBe(true); // normalized
  });
});

describe("dispatch and claims", () => {
  it("dispatches eligible issues up to the global limit and claims them", async () => {
    const { orch, tracker, runs } = build("agent:\n  max_concurrent_agents: 2");
    tracker.candidates = [
      makeIssue({ id: "i1", identifier: "MT-1" }),
      makeIssue({ id: "i2", identifier: "MT-2" }),
      makeIssue({ id: "i3", identifier: "MT-3" }),
    ];
    await orch.tick();
    expect(runs.map((r) => r.issue.id)).toEqual(["i1", "i2"]);
    expect(orch.running.size).toBe(2);
    expect(orch.claimed.has("i1")).toBe(true);
    expect(orch.availableSlots()).toBe(0);
    await orch.stop();
  });

  it("does not double-dispatch running or claimed issues", async () => {
    const { orch, tracker, runs } = build();
    tracker.candidates = [makeIssue({ id: "i1", identifier: "MT-1" })];
    await orch.tick();
    await orch.tick();
    expect(runs).toHaveLength(1);
    await orch.stop();
  });

  it("enforces per-state concurrency overrides (§8.3)", async () => {
    const { orch, tracker, runs } = build(
      "agent:\n  max_concurrent_agents: 5\n  max_concurrent_agents_by_state:\n    todo: 1",
    );
    tracker.candidates = [
      makeIssue({ id: "i1", identifier: "MT-1", state: "Todo" }),
      makeIssue({ id: "i2", identifier: "MT-2", state: "Todo" }),
      makeIssue({ id: "i3", identifier: "MT-3", state: "In Progress" }),
    ];
    await orch.tick();
    expect(runs.map((r) => r.issue.id).sort()).toEqual(["i1", "i3"]);
    await orch.stop();
  });

  it("validation failure skips dispatch but keeps the service alive (§6.3)", async () => {
    const { orch, tracker, runs } = build();
    // Break the workflow on disk so the defensive reload fails validation.
    const fs = await import("node:fs");
    fs.writeFileSync(orchestratorStorePath(orch), "---\n- broken\n---\nbody");
    tracker.candidates = [makeIssue({ id: "i1" })];
    await orch.tick();
    expect(runs).toHaveLength(0);
    expect(orch.lastValidationError).not.toBeNull();
    await orch.stop();

    function orchestratorStorePath(o: Orchestrator): string {
      return (o as unknown as { deps: { store: { workflowPath: string } } }).deps.store.workflowPath;
    }
  });

  it("candidate fetch failure skips the tick without crashing (§11.4)", async () => {
    const { orch, tracker, runs } = build();
    tracker.failCandidates = true;
    await orch.tick();
    expect(runs).toHaveLength(0);
    await orch.stop();
  });
});

describe("worker exit and retries (§8.4, §16.6)", () => {
  it("normal exit schedules a short continuation retry with attempt 1", async () => {
    const { orch, tracker, runs } = build();
    tracker.candidates = [makeIssue({ id: "i1", identifier: "MT-1" })];
    await orch.tick();
    const before = Date.now();
    runs[0]!.finish();
    await flush();
    expect(orch.running.size).toBe(0);
    expect(orch.completed.has("i1")).toBe(true);
    const retry = orch.retryAttempts.get("i1")!;
    expect(retry.attempt).toBe(1);
    expect(retry.due_at_ms - before).toBeLessThanOrEqual(1100);
    expect(orch.claimed.has("i1")).toBe(true); // still claimed while retry pending
    await orch.stop();
  });

  it("abnormal exit increments attempts with exponential backoff", async () => {
    const { orch, tracker, runs } = build();
    tracker.candidates = [makeIssue({ id: "i1", identifier: "MT-1" })];
    await orch.tick();
    runs[0]!.finish("boom");
    await flush();
    const retry = orch.retryAttempts.get("i1")!;
    expect(retry.attempt).toBe(1);
    expect(retry.error).toContain("worker exited");
    expect(retry.due_at_ms - Date.now()).toBeGreaterThan(8000); // ~10s backoff
    await orch.stop();
  });

  it("retry timer: missing issue releases the claim; slot exhaustion requeues with reason", async () => {
    const { orch, tracker } = build("agent:\n  max_concurrent_agents: 1");
    // Seed a retry entry directly.
    orch.scheduleRetry("gone", 1, { identifier: "MT-GONE", error: "x", delayMs: 60_000 });
    tracker.candidates = [];
    await orch.onRetryTimer("gone");
    expect(orch.claimed.has("gone")).toBe(false);
    expect(orch.retryAttempts.has("gone")).toBe(false);

    // Slot exhaustion: occupy the single slot, then retry another issue.
    tracker.candidates = [makeIssue({ id: "busy", identifier: "MT-B" }), makeIssue({ id: "i2", identifier: "MT-2" })];
    await orch.tick(); // dispatches "busy" (sorted by identifier MT-2 first actually — both priority 2 same created_at)
    // Whichever got the slot, retry the other one.
    const runningId = [...orch.running.keys()][0]!;
    const otherId = runningId === "busy" ? "i2" : "busy";
    orch.scheduleRetry(otherId, 2, { identifier: "MT-X", error: "x", delayMs: 60_000 });
    await orch.onRetryTimer(otherId);
    const requeued = orch.retryAttempts.get(otherId)!;
    expect(requeued.attempt).toBe(3);
    expect(requeued.error).toBe("no available orchestrator slots");
    await orch.stop();
  });

  it("retry timer re-dispatches an eligible issue with the retry attempt number", async () => {
    const { orch, tracker, runs } = build();
    tracker.candidates = [makeIssue({ id: "i1", identifier: "MT-1" })];
    orch.scheduleRetry("i1", 2, { identifier: "MT-1", error: "previous failure", delayMs: 60_000 });
    await orch.onRetryTimer("i1");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.attempt).toBe(2);
    await orch.stop();
  });
});

describe("reconciliation (§8.5)", () => {
  it("terminal state stops the worker and cleans the workspace", async () => {
    const { orch, tracker, runs, cleanupCalls } = build();
    tracker.candidates = [makeIssue({ id: "i1", identifier: "MT-1", state: "In Progress" })];
    await orch.tick();
    expect(runs).toHaveLength(1);
    tracker.refreshed = [makeIssue({ id: "i1", identifier: "MT-1", state: "Done" })];
    await orch.reconcileRunningIssues();
    expect(orch.running.size).toBe(0);
    expect(orch.claimed.has("i1")).toBe(false);
    expect(cleanupCalls).toEqual(["MT-1"]);
    await orch.stop();
  });

  it("non-active state stops the worker without cleanup", async () => {
    const { orch, tracker, cleanupCalls } = build();
    tracker.candidates = [makeIssue({ id: "i1", identifier: "MT-1", state: "In Progress" })];
    await orch.tick();
    tracker.refreshed = [makeIssue({ id: "i1", identifier: "MT-1", state: "Blocked" })];
    await orch.reconcileRunningIssues();
    expect(orch.running.size).toBe(0);
    expect(cleanupCalls).toEqual([]);
    await orch.stop();
  });

  it("active refresh updates the in-memory snapshot; refresh failure keeps workers", async () => {
    const { orch, tracker } = build();
    tracker.candidates = [makeIssue({ id: "i1", identifier: "MT-1", state: "Todo" })];
    await orch.tick();
    tracker.refreshed = [makeIssue({ id: "i1", identifier: "MT-1", state: "In Progress", title: "updated" })];
    await orch.reconcileRunningIssues();
    expect(orch.running.get("i1")!.issue.state).toBe("In Progress");

    tracker.failRefresh = true;
    await orch.reconcileRunningIssues();
    expect(orch.running.size).toBe(1); // kept
    await orch.stop();
  });

  it("reconciliation with no running issues is a no-op", async () => {
    const { orch, tracker } = build();
    tracker.failRefresh = true; // would throw if called
    await expect(orch.reconcileRunningIssues()).resolves.toBeUndefined();
    await orch.stop();
  });

  it("stall detection kills stalled sessions and schedules a retry", async () => {
    const { orch, tracker } = build("claude:\n  stall_timeout_ms: 50");
    tracker.candidates = [makeIssue({ id: "i1", identifier: "MT-1", state: "In Progress" })];
    await orch.tick();
    await new Promise((r) => setTimeout(r, 80)); // exceed the stall timeout
    await orch.reconcileRunningIssues();
    expect(orch.running.size).toBe(0);
    expect(orch.retryAttempts.get("i1")?.error).toBe("stalled session");
    await orch.stop();
  });

  it("stall detection disabled when stall_timeout_ms <= 0", async () => {
    const { orch, tracker } = build("claude:\n  stall_timeout_ms: 0");
    tracker.candidates = [makeIssue({ id: "i1", identifier: "MT-1", state: "In Progress" })];
    await orch.tick();
    await new Promise((r) => setTimeout(r, 50));
    await orch.reconcileRunningIssues();
    expect(orch.running.size).toBe(1);
    await orch.stop();
  });
});

describe("token accounting and snapshot (§13.3, §13.5, §17.6)", () => {
  it("applies cumulative-usage deltas without double-counting across turns", async () => {
    const { orch, tracker } = build();
    tracker.candidates = [makeIssue({ id: "i1", identifier: "MT-1" })];
    await orch.tick();

    const base = { timestamp: new Date().toISOString(), claude_pid: 123, session_id: "sess-1" } as const;
    orch.onClaudeUpdate("i1", { ...base, event: "session_started" });
    orch.onClaudeUpdate("i1", {
      ...base,
      event: "turn_completed",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      total_cost_usd: 0.01,
    });
    orch.onClaudeUpdate("i1", {
      ...base,
      event: "turn_completed",
      usage: { input_tokens: 250, output_tokens: 120, total_tokens: 370 },
      total_cost_usd: 0.025,
    });

    const entry = orch.running.get("i1")!;
    expect(entry.claude_input_tokens).toBe(250);
    expect(entry.claude_output_tokens).toBe(120);
    expect(entry.claude_total_tokens).toBe(370);
    expect(entry.turn_count).toBe(2);
    expect(entry.session_id).toBe("sess-1-2");
    expect(orch.claudeTotals.total_tokens).toBe(370);
    expect(orch.claudeTotals.total_cost_usd).toBeCloseTo(0.025);

    const snap = orch.snapshot();
    expect(snap.counts).toEqual({ running: 1, retrying: 0 });
    expect(snap.running[0]).toMatchObject({
      issue_id: "i1",
      issue_identifier: "MT-1",
      turn_count: 2,
      tokens: { input_tokens: 250, output_tokens: 120, total_tokens: 370 },
    });
    expect(snap.rate_limits).toBeNull(); // not exposed by Claude headless (§13.3)
    expect(snap.claude_totals.seconds_running).toBeGreaterThanOrEqual(0);
    await orch.stop();
  });

  it("tracks api_retry events in the api_health snapshot", async () => {
    const { orch, tracker } = build();
    tracker.candidates = [makeIssue({ id: "i1", identifier: "MT-1" })];
    await orch.tick();
    orch.onClaudeUpdate("i1", {
      event: "api_retry",
      timestamp: new Date().toISOString(),
      claude_pid: 1,
      session_id: null,
      payload: { attempt: 2, max_retries: 5, retry_delay_ms: 500, error: "overloaded" },
    });
    expect(orch.snapshot().api_health).toMatchObject({ attempt: 2, error: "overloaded" });
    await orch.stop();
  });

  it("tracks the latest rate_limit_event payload in the snapshot", async () => {
    const { orch, tracker } = build();
    tracker.candidates = [makeIssue({ id: "i1", identifier: "MT-1" })];
    await orch.tick();
    orch.onClaudeUpdate("i1", {
      event: "rate_limit",
      timestamp: new Date().toISOString(),
      claude_pid: 1,
      session_id: null,
      payload: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1781046000 },
    });
    expect(orch.snapshot().rate_limits).toMatchObject({ status: "rejected", rateLimitType: "five_hour" });
    await orch.stop();
  });
});
