/**
 * Agent runner: one worker attempt = workspace + prompt + Claude session
 * (spec-claude.md §10.7, §16.5).
 *
 * Runs the in-worker turn loop: full task prompt on turn 1, continuation
 * guidance on later turns, re-checking tracker state after each successful
 * turn, up to agent.max_turns. Any failure throws; the orchestrator converts
 * it into a retry.
 */
import type { ClaudeClient } from "./claudeClient.js";
import { issueRoutable, type TrackerClient } from "./linear.js";
import { logger } from "./logger.js";
import { buildTurnPrompt } from "./template.js";
import type { WorkspaceManager } from "./workspace.js";
import {
  SymphonyError,
  type ClaudeEvent,
  type Issue,
  type Settings,
  type WorkflowDefinition,
} from "./types.js";

export interface AgentRunnerDeps {
  settings: () => Settings;
  workflow: () => WorkflowDefinition;
  workspaceManager: WorkspaceManager;
  claudeClient: ClaudeClient;
  tracker: TrackerClient;
}

export interface RunCallbacks {
  onClaudeEvent: (event: ClaudeEvent) => void;
  onRuntimeInfo?: (info: { workspace_path: string }) => void;
  signal: AbortSignal;
}

export async function runAgentAttempt(
  deps: AgentRunnerDeps,
  issue: Issue,
  attempt: number | null,
  cb: RunCallbacks,
): Promise<void> {
  const ctx = { issue_id: issue.id, issue_identifier: issue.identifier };
  logger.info("starting agent run", { ...ctx, attempt });

  const workspace = await deps.workspaceManager.createForIssue(issue.identifier);
  cb.onRuntimeInfo?.({ workspace_path: workspace.path });

  try {
    await deps.workspaceManager.runBeforeRun(workspace);
    await runClaudeTurns(deps, issue, attempt, workspace.path, cb);
  } finally {
    await deps.workspaceManager.runAfterRun(workspace.path);
  }
}

async function runClaudeTurns(
  deps: AgentRunnerDeps,
  issue: Issue,
  attempt: number | null,
  workspacePath: string,
  cb: RunCallbacks,
): Promise<void> {
  const ctx = { issue_id: issue.id, issue_identifier: issue.identifier };
  const session = deps.claudeClient.startSession(workspacePath, {
    onEvent: cb.onClaudeEvent,
    signal: cb.signal,
  });

  try {
    const maxTurns = deps.settings().agent.max_turns;
    let current = issue;
    let turnNumber = 1;

    for (;;) {
      if (cb.signal.aborted) throw new SymphonyError("turn_cancelled", "worker aborted");
      const s = deps.settings();

      // Prompt failures fail the attempt immediately (§12.4).
      const prompt = buildTurnPrompt(
        deps.workflow().prompt_template,
        current,
        attempt,
        turnNumber,
        maxTurns,
      );

      const result = await session.runTurn(prompt, s.claude.turn_timeout_ms, s.claude.read_timeout_ms);
      if (cb.signal.aborted) throw new SymphonyError("turn_cancelled", "worker aborted");
      if (!result.ok) {
        throw new SymphonyError(result.errorCode ?? "turn_failed", `agent turn failed (${result.errorCode})`);
      }

      const sessionId = `${session.claudeSessionId ?? "unknown"}-${turnNumber}`;
      logger.info("turn completed", { ...ctx, session_id: sessionId, turn: `${turnNumber}/${maxTurns}` });

      // Re-check the tracker after each normal turn (§7.1).
      let refreshed: Issue[];
      try {
        refreshed = await deps.tracker.fetchIssueStatesByIds([current.id]);
      } catch (err) {
        throw new SymphonyError("issue_state_refresh_failed", `issue state refresh failed: ${String(err)}`, err);
      }

      const next = refreshed.find((i) => i.id === current.id);
      if (!next) return; // issue vanished from tracker view: done
      current = next;

      const s2 = deps.settings();
      const stillActive = s2.tracker.active_states.some(
        (a) => a.trim().toLowerCase() === current.state.trim().toLowerCase(),
      );
      if (!stillActive || !issueRoutable(current, s2.tracker.required_labels)) return;

      if (turnNumber >= maxTurns) {
        logger.info("reached agent.max_turns with issue still active; returning control to orchestrator", {
          ...ctx,
          turn: `${turnNumber}/${maxTurns}`,
        });
        return;
      }
      turnNumber += 1;
    }
  } finally {
    await session.stop();
  }
}
