/**
 * Core domain model (spec-claude.md §4).
 */

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

/** Typed runtime settings (spec §4.1.3, §5.3, §6.4). */
export interface Settings {
  tracker: {
    kind: string | null;
    endpoint: string;
    api_key: string | null;
    project_slug: string | null;
    required_labels: string[];
    active_states: string[];
    terminal_states: string[];
  };
  polling: {
    interval_ms: number;
  };
  workspace: {
    root: string;
  };
  hooks: {
    after_create: string | null;
    before_run: string | null;
    after_run: string | null;
    before_remove: string | null;
    timeout_ms: number;
  };
  agent: {
    max_concurrent_agents: number;
    max_turns: number;
    max_retry_backoff_ms: number;
    max_concurrent_agents_by_state: Record<string, number>;
  };
  claude: {
    command: string;
    permission_mode: string | null;
    allowed_tools: string[];
    disallowed_tools: string[];
    permission_prompt_tool: string | null;
    mcp_config: string | null;
    model: string | null;
    max_agentic_turns: number | null;
    turn_timeout_ms: number;
    read_timeout_ms: number;
    stall_timeout_ms: number;
  };
  server: {
    port: number | null;
  };
}

/** Normalized event emitted upstream from the Claude client (spec §10.4). */
export type ClaudeEventName =
  | "session_started"
  | "startup_failed"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "api_retry"
  | "rate_limit"
  | "permission_denied"
  | "unsupported_tool_call"
  | "notification"
  | "other_message"
  | "malformed";

export interface UsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ClaudeEvent {
  event: ClaudeEventName;
  timestamp: string;
  claude_pid: number | null;
  session_id: string | null;
  /** Cumulative usage for the session, when the payload carries authoritative totals. */
  usage?: UsageSnapshot;
  /** Client-side cumulative cost estimate (result messages only). */
  total_cost_usd?: number;
  message?: string;
  payload?: unknown;
}

/** spec §4.1.7 */
export interface RetryEntry {
  issue_id: string;
  identifier: string | null;
  attempt: number;
  due_at_ms: number;
  timer_handle: NodeJS.Timeout;
  error: string | null;
}

/** One row in orchestrator `running` map (spec §4.1.6, §16.4). */
export interface RunningEntry {
  identifier: string;
  issue: Issue;
  workspace_path: string | null;
  session_id: string | null;
  claude_session_id: string | null;
  claude_pid: number | null;
  last_claude_message: string | null;
  last_claude_event: ClaudeEventName | null;
  last_claude_timestamp: number | null; // ms epoch (monotonic-ish via Date.now)
  claude_input_tokens: number;
  claude_output_tokens: number;
  claude_total_tokens: number;
  claude_total_cost_usd: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  last_reported_cost_usd: number;
  turn_count: number;
  retry_attempt: number | null;
  started_at: number; // ms epoch
  abort: AbortController;
}

export interface ClaudeTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  seconds_running: number;
}

export interface ApiHealthSnapshot {
  at: string;
  attempt: number | null;
  max_retries: number | null;
  retry_delay_ms: number | null;
  error: string | null;
}

/** Typed error used across layers (spec §5.5, §10.6, §11.4). */
export class SymphonyError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(code: string, message?: string, detail?: unknown) {
    super(message ?? code);
    this.code = code;
    this.detail = detail;
    this.name = "SymphonyError";
  }
}

export function errorCode(err: unknown): string {
  if (err instanceof SymphonyError) return err.code;
  if (err instanceof Error) return err.message;
  return String(err);
}
