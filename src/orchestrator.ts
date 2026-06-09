/**
 * Orchestrator (spec-claude.md §7, §8, §16).
 *
 * Single authority for scheduling state: poll tick, candidate selection,
 * bounded-concurrency dispatch, retry queue with exponential backoff,
 * stall detection, tracker-state reconciliation, and token/cost accounting.
 */
import { runAgentAttempt, type AgentRunnerDeps } from "./agentRunner.js";
import { validateDispatchConfig } from "./config.js";
import { issueRoutable, type TrackerClient } from "./linear.js";
import { logger } from "./logger.js";
import type { WorkspaceManager } from "./workspace.js";
import type { WorkflowStore } from "./workflowStore.js";
import {
  errorCode,
  SymphonyError,
  type ApiHealthSnapshot,
  type ClaudeEvent,
  type ClaudeTotals,
  type Issue,
  type RetryEntry,
  type RunningEntry,
  type Settings,
} from "./types.js";

const CONTINUATION_RETRY_DELAY_MS = 1000;
const FAILURE_BASE_DELAY_MS = 10000;

// ---------------------------------------------------------------------------
// Pure decision functions (exported for the §17.4 conformance tests)
// ---------------------------------------------------------------------------

export function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

/** §8.2 sorting: priority asc (null last), created_at oldest first, identifier. */
export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    const ca = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
    const cb = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    return a.identifier.localeCompare(b.identifier);
  });
}

/** §8.4 failure backoff: min(10000 * 2^(attempt-1), cap). */
export function computeBackoffMs(attempt: number, capMs: number): number {
  const exp = Math.min(attempt - 1, 30); // avoid overflow
  return Math.min(FAILURE_BASE_DELAY_MS * 2 ** exp, capMs);
}

export function nextAttempt(prev: number | null): number {
  return prev === null ? 1 : prev + 1;
}

/**
 * Issue-level eligibility (§8.2), excluding the orchestrator-state checks
 * (running/claimed/slots), which the orchestrator applies itself.
 */
export function issueEligible(issue: Issue, settings: Settings): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
  const state = normalizeState(issue.state);
  const active = settings.tracker.active_states.map(normalizeState);
  const terminal = settings.tracker.terminal_states.map(normalizeState);
  if (!active.includes(state) || terminal.includes(state)) return false;
  if (!issueRoutable(issue, settings.tracker.required_labels)) return false;

  // Blocker rule: a Todo issue with any non-terminal blocker is not eligible.
  if (state === "todo") {
    const blockedByOpen = issue.blocked_by.some((b) => {
      if (b.state === null) return true; // unknown blocker state: be conservative
      return !terminal.includes(normalizeState(b.state));
    });
    if (blockedByOpen) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface OrchestratorDeps {
  store: WorkflowStore;
  tracker: TrackerClient;
  workspaceManager: WorkspaceManager;
  /** Worker entrypoint; injectable so tests can fake whole runs. */
  runAttempt?: typeof runAgentAttempt;
  runnerDeps: Omit<AgentRunnerDeps, "settings" | "workflow" | "workspaceManager" | "tracker">;
}

export interface Snapshot {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: SnapshotRunningRow[];
  retrying: SnapshotRetryRow[];
  claude_totals: ClaudeTotals;
  /** Latest rate_limit_event payload from the CLI, when the installed version emits one. */
  rate_limits: unknown | null;
  api_health: ApiHealthSnapshot | null;
  validation_error: string | null;
}

export interface SnapshotRunningRow {
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  state: string;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export interface SnapshotRetryRow {
  issue_id: string;
  issue_identifier: string | null;
  issue_url: string | null;
  attempt: number;
  due_at: string;
  error: string | null;
}

export class Orchestrator {
  readonly running = new Map<string, RunningEntry>();
  readonly claimed = new Set<string>();
  readonly retryAttempts = new Map<string, RetryEntry>();
  readonly completed = new Set<string>();
  claudeTotals: ClaudeTotals = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    seconds_running: 0,
  };
  apiHealth: ApiHealthSnapshot | null = null;
  claudeRateLimits: unknown | null = null;
  lastValidationError: string | null = null;

  private tickTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private ticking = false;
  private refreshRequested = false;
  private endedRuntimeSeconds = 0;
  private readonly runAttemptFn: typeof runAgentAttempt;

  constructor(private readonly deps: OrchestratorDeps) {
    this.runAttemptFn = deps.runAttempt ?? runAgentAttempt;
  }

  private settings(): Settings {
    return this.deps.store.settings();
  }

  private runnerDeps(): AgentRunnerDeps {
    return {
      settings: this.deps.store.settings,
      workflow: this.deps.store.workflow,
      workspaceManager: this.deps.workspaceManager,
      tracker: this.deps.tracker,
      ...this.deps.runnerDeps,
    };
  }

  // -- lifecycle ------------------------------------------------------------

  /** §16.1 startup: validate (fatal), terminal cleanup, immediate first tick. */
  async start(): Promise<void> {
    validateDispatchConfig(this.settings()); // throws -> fail startup
    this.deps.store.watch();
    await this.startupTerminalCleanup();
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const entry of this.retryAttempts.values()) clearTimeout(entry.timer_handle);
    this.retryAttempts.clear();
    for (const [issueId] of this.running) {
      this.terminateRunning(issueId, "shutdown");
    }
    this.deps.store.unwatch();
  }

  /** §13.7.2 POST /refresh: queue an immediate poll+reconcile (coalesced). */
  requestRefresh(): { queued: boolean; coalesced: boolean } {
    if (this.ticking || this.refreshRequested) {
      this.refreshRequested = true;
      return { queued: true, coalesced: true };
    }
    this.refreshRequested = true;
    this.scheduleTick(0);
    return { queued: true, coalesced: false };
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  // -- §8.6 startup cleanup ---------------------------------------------------

  private async startupTerminalCleanup(): Promise<void> {
    try {
      const terminal = this.settings().tracker.terminal_states;
      const issues = await this.deps.tracker.fetchIssuesByStates(terminal);
      for (const issue of issues) {
        await this.deps.workspaceManager.cleanupForIssue(issue.identifier).catch((err) => {
          logger.warn("startup cleanup failed for workspace", {
            issue_identifier: issue.identifier,
            error: errorCode(err),
          });
        });
      }
      logger.info("startup terminal workspace cleanup complete", { terminal_issues: issues.length });
    } catch (err) {
      logger.warn("startup terminal cleanup fetch failed; continuing startup", { error: errorCode(err) });
    }
  }

  // -- §16.2 tick -------------------------------------------------------------

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    this.refreshRequested = false;
    try {
      await this.reconcileRunningIssues();

      // Defensive reload + preflight validation (§6.2, §6.3).
      this.deps.store.reload();
      try {
        if (this.deps.store.lastError) throw this.deps.store.lastError;
        validateDispatchConfig(this.settings());
        this.lastValidationError = null;
      } catch (err) {
        this.lastValidationError = errorCode(err);
        logger.error("dispatch preflight validation failed; skipping dispatch this tick", {
          error: this.lastValidationError,
        });
        return;
      }

      let issues: Issue[];
      try {
        issues = await this.deps.tracker.fetchCandidateIssues();
      } catch (err) {
        logger.warn("candidate fetch failed; skipping dispatch this tick", { error: errorCode(err) });
        return;
      }

      for (const issue of sortForDispatch(issues)) {
        if (this.availableSlots() <= 0) break;
        if (this.shouldDispatch(issue)) {
          this.dispatchIssue(issue, null);
        }
      }
    } finally {
      this.ticking = false;
      this.scheduleTick(this.settingsSafe()?.polling.interval_ms ?? 30000);
    }
  }

  private settingsSafe(): Settings | null {
    try {
      return this.settings();
    } catch {
      return null;
    }
  }

  // -- §8.2/§8.3 dispatch decisions -------------------------------------------

  availableSlots(): number {
    return Math.max(this.settings().agent.max_concurrent_agents - this.running.size, 0);
  }

  private perStateSlotsAvailable(issue: Issue): boolean {
    const s = this.settings();
    const limit = s.agent.max_concurrent_agents_by_state[normalizeState(issue.state)];
    if (limit === undefined) return true; // fall back to the global limit
    let runningInState = 0;
    for (const entry of this.running.values()) {
      if (normalizeState(entry.issue.state) === normalizeState(issue.state)) runningInState += 1;
    }
    return runningInState < limit;
  }

  shouldDispatch(issue: Issue, opts: { ignoreClaim?: boolean } = {}): boolean {
    if (!issueEligible(issue, this.settings())) return false;
    if (this.running.has(issue.id)) return false;
    if (!opts.ignoreClaim && this.claimed.has(issue.id)) return false;
    if (this.availableSlots() <= 0) return false;
    if (!this.perStateSlotsAvailable(issue)) return false;
    return true;
  }

  // -- §16.4 dispatch -----------------------------------------------------------

  dispatchIssue(issue: Issue, attempt: number | null): void {
    const abort = new AbortController();
    const entry: RunningEntry = {
      identifier: issue.identifier,
      issue,
      workspace_path: null,
      session_id: null,
      claude_session_id: null,
      claude_pid: null,
      last_claude_message: null,
      last_claude_event: null,
      last_claude_timestamp: null,
      claude_input_tokens: 0,
      claude_output_tokens: 0,
      claude_total_tokens: 0,
      claude_total_cost_usd: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      last_reported_cost_usd: 0,
      turn_count: 0,
      retry_attempt: attempt,
      started_at: Date.now(),
      abort,
    };
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    const existingRetry = this.retryAttempts.get(issue.id);
    if (existingRetry) {
      clearTimeout(existingRetry.timer_handle);
      this.retryAttempts.delete(issue.id);
    }

    logger.info("dispatching issue", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      running: this.running.size,
    });

    void this.runAttemptFn(this.runnerDeps(), issue, attempt, {
      signal: abort.signal,
      onRuntimeInfo: (info) => {
        const e = this.running.get(issue.id);
        if (e) e.workspace_path = info.workspace_path;
      },
      onClaudeEvent: (event) => this.onClaudeUpdate(issue.id, event),
    })
      .then(() => this.onWorkerExit(issue.id, null))
      .catch((err: unknown) => this.onWorkerExit(issue.id, errorCode(err)));
  }

  // -- §7.3 claude update events ----------------------------------------------

  onClaudeUpdate(issueId: string, event: ClaudeEvent): void {
    const entry = this.running.get(issueId);
    if (!entry) return;

    entry.last_claude_event = event.event;
    entry.last_claude_timestamp = Date.now();
    if (event.message) entry.last_claude_message = event.message;
    if (event.claude_pid !== null) entry.claude_pid = event.claude_pid;
    if (event.session_id) {
      entry.claude_session_id = event.session_id;
    }
    if (event.event === "turn_completed" || event.event === "turn_failed") {
      entry.turn_count += 1;
      entry.session_id = entry.claude_session_id ? `${entry.claude_session_id}-${entry.turn_count}` : null;
    } else if (event.event === "session_started") {
      entry.session_id = entry.claude_session_id ? `${entry.claude_session_id}-${Math.max(entry.turn_count, 1)}` : null;
      logger.info("claude session started", {
        issue_id: issueId,
        issue_identifier: entry.identifier,
        session_id: entry.session_id,
      });
    }

    if (event.event === "rate_limit") {
      this.claudeRateLimits = event.payload ?? null;
    }

    if (event.event === "api_retry") {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      this.apiHealth = {
        at: event.timestamp,
        attempt: typeof p["attempt"] === "number" ? p["attempt"] : null,
        max_retries: typeof p["max_retries"] === "number" ? p["max_retries"] : null,
        retry_delay_ms: typeof p["retry_delay_ms"] === "number" ? p["retry_delay_ms"] : null,
        error: typeof p["error"] === "string" ? p["error"] : null,
      };
    }

    // Cumulative usage from `result` messages: apply deltas vs last reported
    // so continuation turns never double-count (§13.5).
    if (event.usage) {
      const dIn = Math.max(event.usage.input_tokens - entry.last_reported_input_tokens, 0);
      const dOut = Math.max(event.usage.output_tokens - entry.last_reported_output_tokens, 0);
      const dTotal = Math.max(event.usage.total_tokens - entry.last_reported_total_tokens, 0);
      entry.claude_input_tokens += dIn;
      entry.claude_output_tokens += dOut;
      entry.claude_total_tokens += dTotal;
      entry.last_reported_input_tokens = event.usage.input_tokens;
      entry.last_reported_output_tokens = event.usage.output_tokens;
      entry.last_reported_total_tokens = event.usage.total_tokens;
      this.claudeTotals.input_tokens += dIn;
      this.claudeTotals.output_tokens += dOut;
      this.claudeTotals.total_tokens += dTotal;
    }
    if (typeof event.total_cost_usd === "number") {
      const dCost = Math.max(event.total_cost_usd - entry.last_reported_cost_usd, 0);
      entry.claude_total_cost_usd += dCost;
      entry.last_reported_cost_usd = event.total_cost_usd;
      this.claudeTotals.total_cost_usd += dCost;
    }
  }

  // -- §16.6 worker exit + retries ----------------------------------------------

  onWorkerExit(issueId: string, error: string | null): void {
    const entry = this.running.get(issueId);
    if (!entry) return; // already terminated by reconciliation/shutdown
    this.running.delete(issueId);
    this.endedRuntimeSeconds += (Date.now() - entry.started_at) / 1000;

    if (error === null) {
      this.completed.add(issueId); // bookkeeping only
      logger.info("worker exited normally; scheduling continuation check", {
        issue_id: issueId,
        issue_identifier: entry.identifier,
      });
      this.scheduleRetry(issueId, 1, {
        identifier: entry.identifier,
        error: null,
        delayMs: CONTINUATION_RETRY_DELAY_MS,
      });
    } else {
      const attempt = nextAttempt(entry.retry_attempt);
      logger.warn("worker exited abnormally; scheduling retry", {
        issue_id: issueId,
        issue_identifier: entry.identifier,
        attempt,
        error,
      });
      this.scheduleRetry(issueId, attempt, { identifier: entry.identifier, error: `worker exited: ${error}` });
    }
  }

  scheduleRetry(
    issueId: string,
    attempt: number,
    info: { identifier: string | null; error: string | null; delayMs?: number },
  ): void {
    if (this.stopped) return;
    const existing = this.retryAttempts.get(issueId);
    if (existing) clearTimeout(existing.timer_handle);

    const delay =
      info.delayMs ?? computeBackoffMs(attempt, this.settingsSafe()?.agent.max_retry_backoff_ms ?? 300000);
    const timer = setTimeout(() => {
      void this.onRetryTimer(issueId);
    }, delay);
    this.retryAttempts.set(issueId, {
      issue_id: issueId,
      identifier: info.identifier,
      attempt,
      due_at_ms: Date.now() + delay,
      timer_handle: timer,
      error: info.error,
    });
    this.claimed.add(issueId);
  }

  async onRetryTimer(issueId: string): Promise<void> {
    const retryEntry = this.retryAttempts.get(issueId);
    if (!retryEntry) return;
    this.retryAttempts.delete(issueId);

    let candidates: Issue[];
    try {
      candidates = await this.deps.tracker.fetchCandidateIssues();
    } catch {
      this.scheduleRetry(issueId, retryEntry.attempt + 1, {
        identifier: retryEntry.identifier,
        error: "retry poll failed",
      });
      return;
    }

    const issue = candidates.find((i) => i.id === issueId);
    if (!issue) {
      this.claimed.delete(issueId); // released (§7.1)
      logger.info("retry: issue no longer an active candidate; releasing claim", { issue_id: issueId });
      return;
    }

    if (!this.shouldDispatch(issue, { ignoreClaim: true })) {
      if (this.availableSlots() <= 0 || !this.perStateSlotsAvailable(issue)) {
        this.scheduleRetry(issueId, retryEntry.attempt + 1, {
          identifier: issue.identifier,
          error: "no available orchestrator slots",
        });
      } else {
        this.claimed.delete(issueId); // not eligible anymore: release
        logger.info("retry: issue no longer eligible; releasing claim", { issue_id: issueId });
      }
      return;
    }

    this.dispatchIssue(issue, retryEntry.attempt);
  }

  // -- §8.5 reconciliation --------------------------------------------------------

  async reconcileRunningIssues(): Promise<void> {
    this.reconcileStalledRuns();

    const runningIds = [...this.running.keys()];
    if (runningIds.length === 0) return;

    let refreshed: Issue[];
    try {
      refreshed = await this.deps.tracker.fetchIssueStatesByIds(runningIds);
    } catch (err) {
      logger.debug("state refresh failed; keeping workers running", { error: errorCode(err) });
      return;
    }

    const s = this.settings();
    const active = s.tracker.active_states.map(normalizeState);
    const terminal = s.tracker.terminal_states.map(normalizeState);

    for (const issue of refreshed) {
      const entry = this.running.get(issue.id);
      if (!entry) continue;
      const state = normalizeState(issue.state);
      if (terminal.includes(state)) {
        logger.info("issue reached terminal state; terminating worker and cleaning workspace", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          state: issue.state,
        });
        this.terminateRunning(issue.id, "terminal state");
        await this.deps.workspaceManager.cleanupForIssue(issue.identifier).catch((err) => {
          logger.warn("workspace cleanup failed", { issue_identifier: issue.identifier, error: errorCode(err) });
        });
      } else if (active.includes(state) && issueRoutable(issue, s.tracker.required_labels)) {
        entry.issue = issue; // refresh in-memory snapshot
      } else {
        logger.info("issue no longer active/routable; terminating worker without cleanup", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          state: issue.state,
        });
        this.terminateRunning(issue.id, "non-active state");
      }
    }
  }

  private reconcileStalledRuns(): void {
    const s = this.settingsSafe();
    if (!s || s.claude.stall_timeout_ms <= 0) return;
    const now = Date.now();
    for (const [issueId, entry] of [...this.running]) {
      const last = entry.last_claude_timestamp ?? entry.started_at;
      if (now - last > s.claude.stall_timeout_ms) {
        logger.warn("stall timeout exceeded; killing worker and scheduling retry", {
          issue_id: issueId,
          issue_identifier: entry.identifier,
          elapsed_ms: now - last,
        });
        const attempt = nextAttempt(entry.retry_attempt);
        this.terminateRunning(issueId, "stalled");
        this.scheduleRetry(issueId, attempt, { identifier: entry.identifier, error: "stalled session" });
      }
    }
  }

  /** Remove from running, release claim, abort the worker task. */
  terminateRunning(issueId: string, reason: string): void {
    const entry = this.running.get(issueId);
    if (!entry) return;
    this.running.delete(issueId);
    this.claimed.delete(issueId);
    this.endedRuntimeSeconds += (Date.now() - entry.started_at) / 1000;
    entry.abort.abort(new SymphonyError("turn_cancelled", reason));
    logger.info("worker terminated", { issue_id: issueId, issue_identifier: entry.identifier, reason });
  }

  // -- §13.3 snapshot ---------------------------------------------------------------

  snapshot(): Snapshot {
    const now = Date.now();
    let activeSeconds = 0;
    const runningRows: SnapshotRunningRow[] = [];
    for (const [issueId, entry] of this.running) {
      activeSeconds += (now - entry.started_at) / 1000;
      runningRows.push({
        issue_id: issueId,
        issue_identifier: entry.identifier,
        issue_url: entry.issue.url,
        state: entry.issue.state,
        session_id: entry.session_id,
        turn_count: entry.turn_count,
        last_event: entry.last_claude_event,
        last_message: entry.last_claude_message,
        started_at: new Date(entry.started_at).toISOString(),
        last_event_at: entry.last_claude_timestamp ? new Date(entry.last_claude_timestamp).toISOString() : null,
        tokens: {
          input_tokens: entry.claude_input_tokens,
          output_tokens: entry.claude_output_tokens,
          total_tokens: entry.claude_total_tokens,
        },
      });
    }

    const retryRows: SnapshotRetryRow[] = [...this.retryAttempts.values()].map((r) => ({
      issue_id: r.issue_id,
      issue_identifier: r.identifier,
      issue_url: null,
      attempt: r.attempt,
      due_at: new Date(r.due_at_ms).toISOString(),
      error: r.error,
    }));

    return {
      generated_at: new Date(now).toISOString(),
      counts: { running: this.running.size, retrying: this.retryAttempts.size },
      running: runningRows,
      retrying: retryRows,
      claude_totals: {
        ...this.claudeTotals,
        seconds_running: this.endedRuntimeSeconds + activeSeconds,
      },
      rate_limits: this.claudeRateLimits, // from rate_limit_event when the CLI emits it (§13.5)
      api_health: this.apiHealth,
      validation_error: this.lastValidationError,
    };
  }
}
