/**
 * Typed config layer (spec-claude.md §5.3, §6).
 *
 * Resolution pipeline (§6.1): raw front-matter map -> defaults -> $VAR
 * indirection (only for values that explicitly reference $VAR) -> coercion and
 * validation. Environment variables never globally override YAML values.
 */
import os from "node:os";
import path from "node:path";
import { SymphonyError, type Settings } from "./types.js";

export const DEFAULT_CLAUDE_COMMAND =
  "claude -p --input-format stream-json --output-format stream-json --verbose";

const LINEAR_DEFAULT_ENDPOINT = "https://api.linear.app/graphql";

export interface ResolveOptions {
  /** Directory containing the selected WORKFLOW.md (for relative workspace.root). */
  workflowDir: string;
  env?: NodeJS.ProcessEnv;
}

function asMap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((v): v is string => typeof v === "string");
}

function asInteger(value: unknown, fallback: number, field: string, opts?: { min?: number }): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(n) || (opts?.min !== undefined && n < opts.min)) {
    throw new SymphonyError("invalid_config_value", `${field} must be an integer${opts?.min !== undefined ? ` >= ${opts.min}` : ""}, got ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * $VAR indirection (§6.1 step 4): applied only when the configured value is
 * exactly `$NAME`. Empty env resolution means "missing" (§5.3.1).
 */
export function resolveEnvIndirection(value: string | null, env: NodeJS.ProcessEnv): string | null {
  if (value === null) return null;
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (!m) return value;
  const resolved = env[m[1]!] ?? "";
  return resolved.length > 0 ? resolved : null;
}

/** `~` and `$VAR` expansion for local filesystem path values (§6.1). */
export function expandPath(value: string, env: NodeJS.ProcessEnv): string {
  let out = resolveEnvIndirection(value, env) ?? value;
  if (out === "~") out = os.homedir();
  else if (out.startsWith("~/")) out = path.join(os.homedir(), out.slice(2));
  return out;
}

export function resolveSettings(config: Record<string, unknown>, opts: ResolveOptions): Settings {
  const env = opts.env ?? process.env;
  const tracker = asMap(config["tracker"]);
  const polling = asMap(config["polling"]);
  const workspace = asMap(config["workspace"]);
  const hooks = asMap(config["hooks"]);
  const agent = asMap(config["agent"]);
  const claude = asMap(config["claude"]);
  const server = asMap(config["server"]);

  // workspace.root: ~ expansion, $VAR, relative-to-workflow-dir, absolute (§5.3.3, §6.1).
  const rawRoot = asStringOrNull(workspace["root"]) ?? path.join(os.tmpdir(), "symphony_workspaces");
  const expandedRoot = expandPath(rawRoot, env);
  const workspaceRoot = path.resolve(
    path.isAbsolute(expandedRoot) ? expandedRoot : path.join(opts.workflowDir, expandedRoot),
  );

  // Per-state concurrency map: normalize keys, drop invalid entries (§5.3.5).
  const byStateRaw = asMap(agent["max_concurrent_agents_by_state"]);
  const byState: Record<string, number> = {};
  for (const [key, value] of Object.entries(byStateRaw)) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      byState[key.trim().toLowerCase()] = value;
    }
  }

  const settings: Settings = {
    tracker: {
      kind: asStringOrNull(tracker["kind"]),
      endpoint: asStringOrNull(tracker["endpoint"]) ?? LINEAR_DEFAULT_ENDPOINT,
      api_key: resolveEnvIndirection(asStringOrNull(tracker["api_key"]), env),
      project_slug: asStringOrNull(tracker["project_slug"]),
      required_labels: asStringList(tracker["required_labels"], []),
      active_states: asStringList(tracker["active_states"], ["Todo", "In Progress"]),
      terminal_states: asStringList(tracker["terminal_states"], [
        "Closed",
        "Cancelled",
        "Canceled",
        "Duplicate",
        "Done",
      ]),
    },
    polling: {
      interval_ms: asInteger(polling["interval_ms"], 30000, "polling.interval_ms", { min: 1 }),
    },
    workspace: { root: workspaceRoot },
    hooks: {
      after_create: asStringOrNull(hooks["after_create"]),
      before_run: asStringOrNull(hooks["before_run"]),
      after_run: asStringOrNull(hooks["after_run"]),
      before_remove: asStringOrNull(hooks["before_remove"]),
      timeout_ms: asInteger(hooks["timeout_ms"], 60000, "hooks.timeout_ms", { min: 1 }),
    },
    agent: {
      max_concurrent_agents: asInteger(agent["max_concurrent_agents"], 10, "agent.max_concurrent_agents", { min: 0 }),
      max_turns: asInteger(agent["max_turns"], 20, "agent.max_turns", { min: 1 }),
      max_retry_backoff_ms: asInteger(agent["max_retry_backoff_ms"], 300000, "agent.max_retry_backoff_ms", { min: 1000 }),
      max_concurrent_agents_by_state: byState,
    },
    claude: {
      command: asStringOrNull(claude["command"]) ?? DEFAULT_CLAUDE_COMMAND,
      permission_mode: asStringOrNull(claude["permission_mode"]),
      allowed_tools: asStringList(claude["allowed_tools"], []),
      disallowed_tools: asStringList(claude["disallowed_tools"], []),
      permission_prompt_tool: asStringOrNull(claude["permission_prompt_tool"]),
      mcp_config: asStringOrNull(claude["mcp_config"]),
      model: asStringOrNull(claude["model"]),
      max_agentic_turns:
        claude["max_agentic_turns"] === undefined || claude["max_agentic_turns"] === null
          ? null
          : asInteger(claude["max_agentic_turns"], 0, "claude.max_agentic_turns", { min: 1 }),
      turn_timeout_ms: asInteger(claude["turn_timeout_ms"], 3600000, "claude.turn_timeout_ms", { min: 1 }),
      read_timeout_ms: asInteger(claude["read_timeout_ms"], 5000, "claude.read_timeout_ms", { min: 1 }),
      stall_timeout_ms: asInteger(claude["stall_timeout_ms"], 300000, "claude.stall_timeout_ms"),
    },
    server: {
      port:
        server["port"] === undefined || server["port"] === null
          ? null
          : asInteger(server["port"], 0, "server.port", { min: 0 }),
    },
  };

  return settings;
}

/** Dispatch preflight validation (spec §6.3). Throws SymphonyError on failure. */
export function validateDispatchConfig(settings: Settings): void {
  if (!settings.tracker.kind) {
    throw new SymphonyError("unsupported_tracker_kind", "tracker.kind is required for dispatch");
  }
  if (settings.tracker.kind.toLowerCase() !== "linear") {
    throw new SymphonyError("unsupported_tracker_kind", `unsupported tracker.kind ${settings.tracker.kind}`);
  }
  if (!settings.tracker.api_key) {
    throw new SymphonyError("missing_tracker_api_key", "tracker.api_key is missing after $ resolution");
  }
  if (!settings.tracker.project_slug) {
    throw new SymphonyError("missing_tracker_project_slug", "tracker.project_slug is required for linear");
  }
  if (!settings.claude.command || settings.claude.command.trim() === "") {
    throw new SymphonyError("invalid_config_value", "claude.command must be present and non-empty");
  }
}

/**
 * Build the full launch command: claude.command plus runtime-appended flags
 * derived from typed config (spec §5.3.6, §10.1).
 */
export function buildClaudeCommand(settings: Settings, opts?: { resumeSessionId?: string }): string {
  const parts: string[] = [settings.claude.command];
  const c = settings.claude;
  if (c.permission_mode) parts.push(`--permission-mode ${shellQuote(c.permission_mode)}`);
  if (c.allowed_tools.length > 0) parts.push(`--allowedTools ${shellQuote(c.allowed_tools.join(","))}`);
  if (c.disallowed_tools.length > 0) parts.push(`--disallowedTools ${shellQuote(c.disallowed_tools.join(","))}`);
  if (c.permission_prompt_tool) parts.push(`--permission-prompt-tool ${shellQuote(c.permission_prompt_tool)}`);
  if (c.mcp_config) parts.push(`--mcp-config ${shellQuote(c.mcp_config)}`);
  if (c.model) parts.push(`--model ${shellQuote(c.model)}`);
  if (c.max_agentic_turns !== null) parts.push(`--max-turns ${c.max_agentic_turns}`);
  if (opts?.resumeSessionId) parts.push(`--resume ${shellQuote(opts.resumeSessionId)}`);
  return parts.join(" ");
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
