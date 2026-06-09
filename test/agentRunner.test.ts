/** §17.5 worker turn loop: continuation turns on one live process (§7.1, §16.5) */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAgentAttempt, type AgentRunnerDeps } from "../src/agentRunner.js";
import { ClaudeClient } from "../src/claudeClient.js";
import { WorkspaceManager } from "../src/workspace.js";
import type { TrackerClient } from "../src/linear.js";
import type { ClaudeEvent, Issue } from "../src/types.js";
import { makeIssue, makeStore, tempDir, VALID_TRACKER_YAML } from "./helpers.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.cjs");

function buildDeps(opts: {
  mode?: string;
  maxTurns?: number;
  /** State sequence returned by successive refresh calls. */
  states: string[];
  hooksYaml?: string;
}): { deps: AgentRunnerDeps; events: ClaudeEvent[]; refreshCalls: number[] } {
  const root = tempDir();
  const store = makeStore(
    `${VALID_TRACKER_YAML}
workspace:
  root: ${root}
agent:
  max_turns: ${opts.maxTurns ?? 20}
claude:
  command: FAKE_MODE=${opts.mode ?? "ok"} node ${FAKE}
  read_timeout_ms: 2000
  turn_timeout_ms: 8000
${opts.hooksYaml ?? ""}`,
    "Work {{ issue.identifier }} attempt={{ attempt }}",
  );

  let call = 0;
  const refreshCalls: number[] = [];
  const tracker: TrackerClient = {
    fetchCandidateIssues: async () => [],
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async (ids: string[]): Promise<Issue[]> => {
      refreshCalls.push(call);
      const state = opts.states[Math.min(call, opts.states.length - 1)]!;
      call += 1;
      return ids.map((id) => makeIssue({ id, state }));
    },
  };

  const events: ClaudeEvent[] = [];
  const deps: AgentRunnerDeps = {
    settings: store.settings,
    workflow: store.workflow,
    workspaceManager: new WorkspaceManager(store.settings),
    claudeClient: new ClaudeClient(store.settings),
    tracker,
  };
  return { deps, events, refreshCalls };
}

function callbacks(events: ClaudeEvent[]) {
  return {
    onClaudeEvent: (e: ClaudeEvent) => events.push(e),
    signal: new AbortController().signal,
  };
}

describe("agent runner turn loop", () => {
  it("runs continuation turns on the same live session while the issue stays active", async () => {
    const { deps, events } = buildDeps({ states: ["In Progress", "In Progress", "Done"] });
    await runAgentAttempt(deps, makeIssue({ id: "i1", identifier: "MT-1" }), null, callbacks(events));
    const completed = events.filter((e) => e.event === "turn_completed");
    expect(completed).toHaveLength(3); // active, active, then Done stops the loop
    expect(events.filter((e) => e.event === "session_started")).toHaveLength(1); // one process
  });

  it("stops at agent.max_turns even when the issue remains active", async () => {
    const { deps, events } = buildDeps({ maxTurns: 2, states: ["In Progress"] });
    await runAgentAttempt(deps, makeIssue({ id: "i1", identifier: "MT-1" }), null, callbacks(events));
    expect(events.filter((e) => e.event === "turn_completed")).toHaveLength(2);
  });

  it("fails the attempt on an error result", async () => {
    const { deps, events } = buildDeps({ mode: "error", states: ["In Progress"] });
    await expect(
      runAgentAttempt(deps, makeIssue({ id: "i1", identifier: "MT-1" }), null, callbacks(events)),
    ).rejects.toMatchObject({ code: "turn_failed" });
  });

  it("before_run failure aborts the attempt; after_run still runs (§9.4)", async () => {
    const { deps, events } = buildDeps({
      states: ["Done"],
      hooksYaml: `hooks:\n  before_run: "exit 7"\n  after_run: "touch after_ran.txt"`,
    });
    await expect(
      runAgentAttempt(deps, makeIssue({ id: "i1", identifier: "MT-1" }), null, callbacks(events)),
    ).rejects.toMatchObject({ code: "workspace_hook_failed" });
    const wsPath = path.join(deps.settings().workspace.root, "MT-1");
    expect(existsSync(path.join(wsPath, "after_ran.txt"))).toBe(true);
  });

  it("template render errors fail the attempt immediately (§12.4)", async () => {
    const { deps, events } = buildDeps({ states: ["Done"] });
    const broken = { ...deps, workflow: () => ({ config: {}, prompt_template: "{{ not_a_thing }}" }) };
    await expect(
      runAgentAttempt(broken, makeIssue({ id: "i1", identifier: "MT-1" }), null, callbacks(events)),
    ).rejects.toMatchObject({ code: "template_render_error" });
  });

  it("issue state refresh failure fails the attempt (§16.5)", async () => {
    const { deps, events } = buildDeps({ states: ["In Progress"] });
    const failing = {
      ...deps,
      tracker: {
        ...deps.tracker,
        fetchIssueStatesByIds: async () => {
          throw new Error("network down");
        },
      },
    };
    await expect(
      runAgentAttempt(failing, makeIssue({ id: "i1", identifier: "MT-1" }), null, callbacks(events)),
    ).rejects.toMatchObject({ code: "issue_state_refresh_failed" });
  });
});
