# Symphony Service Specification — Claude Edition

Status: Draft v1 (language-agnostic, Claude-targeted)

Purpose: Define a service that orchestrates coding agents to get project work done, using
Claude Code (headless mode) or the Claude Agent SDK as the coding agent runtime.

Provenance: This document is a port of the original Symphony specification, which targeted the
OpenAI Codex app-server. Section numbering is kept identical to the original so the two documents
can be diffed side by side. The original reference implementation lives at
https://github.com/openai/symphony and remains a useful reference for orchestration behavior
(polling, retries, reconciliation, workspace lifecycle) — everything except the agent protocol
itself, which this document replaces.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and
`OPTIONAL` in this document are to be interpreted as described in RFC 2119.

`Implementation-defined` means the behavior is part of the implementation contract, but this
specification does not prescribe one universal policy. Implementations MUST document the selected
behavior.

## 1. Problem Statement

Symphony is a long-running automation service that continuously reads work from an issue tracker
(Linear in this specification version), creates an isolated workspace for each issue, and runs a
Claude Code agent session for that issue inside the workspace.

The service solves four operational problems:

- It turns issue execution into a repeatable daemon workflow instead of manual scripts.
- It isolates agent execution in per-issue workspaces so agent commands run only inside per-issue
  workspace directories.
- It keeps the workflow policy in-repo (`WORKFLOW.md`) so teams version the agent prompt and runtime
  settings with their code.
- It provides enough observability to operate and debug multiple concurrent agent runs.

Implementations are expected to document their trust and safety posture explicitly. This
specification does not require a single approval, sandbox, or operator-confirmation policy; some
implementations target trusted environments with a high-trust configuration (for example
`bypassPermissions`), while others require stricter approvals or tool allowlists.

Important boundary:

- Symphony is a scheduler/runner and tracker reader.
- Ticket writes (state transitions, comments, PR links) are typically performed by the coding agent
  using tools available in the workflow/runtime environment.
- A successful run can end at a workflow-defined handoff state (for example `Human Review`), not
  necessarily `Done`.

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll the issue tracker on a fixed cadence and dispatch work with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Create deterministic per-issue workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
- Expose operator-visible observability (at minimum structured logs).
- Support tracker/filesystem-driven restart recovery without requiring a persistent database; exact
  in-memory scheduler state is not restored.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane.
- Prescribing a specific dashboard or terminal UI implementation.
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to edit tickets, PRs, or comments. (That logic lives in the
  workflow prompt and agent tooling.)
- Mandating strong sandbox controls beyond what the coding agent and host OS provide.
- Mandating a single default approval, sandbox, or operator-confirmation posture for all
  implementations.

## 3. System Overview

### 3.1 Main Components

1. `Workflow Loader`
   - Reads `WORKFLOW.md`.
   - Parses YAML front matter and prompt body.
   - Returns `{config, prompt_template}`.

2. `Config Layer`
   - Exposes typed getters for workflow config values.
   - Applies defaults and environment variable indirection.
   - Performs validation used by the orchestrator before dispatch.

3. `Issue Tracker Client`
   - Fetches candidate issues in active states.
   - Fetches current states for specific issue IDs (reconciliation).
   - Fetches terminal-state issues during startup cleanup.
   - Normalizes tracker payloads into a stable issue model.

4. `Orchestrator`
   - Owns the poll tick.
   - Owns the in-memory runtime state.
   - Decides which issues to dispatch, retry, stop, or release.
   - Tracks session metrics and retry queue state.

5. `Workspace Manager`
   - Maps issue identifiers to workspace paths.
   - Ensures per-issue workspace directories exist.
   - Runs workspace lifecycle hooks.
   - Cleans workspaces for terminal issues.

6. `Agent Runner`
   - Creates workspace.
   - Builds prompt from issue + workflow template.
   - Launches the Claude Code headless client (subprocess or Agent SDK).
   - Streams agent updates back to the orchestrator.

7. `Status Surface` (OPTIONAL)
   - Presents human-readable runtime status (for example terminal output, dashboard, or other
     operator-facing view).

8. `Logging`
   - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

Symphony is easiest to port when kept in these layers:

1. `Policy Layer` (repo-defined)
   - `WORKFLOW.md` prompt body.
   - Team-specific rules for ticket handling, validation, and handoff.

2. `Configuration Layer` (typed getters)
   - Parses front matter into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. `Coordination Layer` (orchestrator)
   - Polling loop, issue eligibility, concurrency, retries, reconciliation.

4. `Execution Layer` (workspace + agent subprocess)
   - Filesystem lifecycle, workspace preparation, Claude Code headless protocol.

5. `Integration Layer` (Linear adapter)
   - API calls and normalization for tracker data.

6. `Observability Layer` (logs + OPTIONAL status surface)
   - Operator visibility into orchestrator and agent behavior.

### 3.3 External Dependencies

- Issue tracker API (Linear for `tracker.kind: linear` in this specification version).
- Local filesystem for workspaces and logs.
- OPTIONAL workspace population tooling (for example Git CLI, if used).
- Claude Code CLI (`claude`) supporting headless mode with `stream-json` input/output — or,
  equivalently, the Claude Agent SDK (`claude-agent-sdk` on PyPI,
  `@anthropic-ai/claude-agent-sdk` on npm), which manages the same subprocess.
- Host environment authentication for the issue tracker and for Claude (for example
  `ANTHROPIC_API_KEY`, or a `claude` login on the host).

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Issue

Normalized issue record used by orchestration, prompt rendering, and observability output.

Fields:

- `id` (string)
  - Stable tracker-internal ID.
- `identifier` (string)
  - Human-readable ticket key (example: `ABC-123`).
- `title` (string)
- `description` (string or null)
- `priority` (integer or null)
  - Lower numbers are higher priority in dispatch sorting.
- `state` (string)
  - Current tracker state name.
- `branch_name` (string or null)
  - Tracker-provided branch metadata if available.
- `url` (string or null)
- `labels` (list of strings)
  - Normalized to lowercase.
- `blocked_by` (list of blocker refs)
  - Each blocker ref contains:
    - `id` (string or null)
    - `identifier` (string or null)
    - `state` (string or null)
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 4.1.2 Workflow Definition

Parsed `WORKFLOW.md` payload:

- `config` (map)
  - YAML front matter root object.
- `prompt_template` (string)
  - Markdown body after front matter, trimmed.

#### 4.1.3 Service Config (Typed View)

Typed runtime values derived from `WorkflowDefinition.config` plus environment resolution.

Examples:

- poll interval
- workspace root
- active and terminal issue states
- concurrency limits
- Claude command/permission settings/timeouts
- workspace hooks

#### 4.1.4 Workspace

Filesystem workspace assigned to one issue identifier.

Fields (logical):

- `path` (absolute workspace path)
- `workspace_key` (sanitized issue identifier)
- `created_now` (boolean, used to gate `after_create` hook)

#### 4.1.5 Run Attempt

One execution attempt for one issue.

Fields (logical):

- `issue_id`
- `issue_identifier`
- `attempt` (integer or null, `null` for first run, `>=1` for retries/continuation)
- `workspace_path`
- `started_at`
- `status`
- `error` (OPTIONAL)

#### 4.1.6 Live Session (Agent Session Metadata)

State tracked while a Claude Code subprocess is running.

Fields:

- `session_id` (string, `<claude_session_id>-<turn_number>`)
- `claude_session_id` (string)
  - The `session_id` reported by Claude Code in every stream-json message.
- `turn_number` (integer)
  - 1-based counter of prompt→result cycles within the current worker lifetime, maintained by the
    worker (Claude Code does not emit a turn identifier).
- `claude_pid` (string or null)
  - PID of the `claude` subprocess (or the subprocess managed by the Agent SDK, if exposed).
- `last_claude_event` (string/enum or null)
- `last_claude_timestamp` (timestamp or null)
- `last_claude_message` (summarized payload)
- `claude_input_tokens` (integer)
- `claude_output_tokens` (integer)
- `claude_total_tokens` (integer)
- `last_reported_input_tokens` (integer)
- `last_reported_output_tokens` (integer)
- `last_reported_total_tokens` (integer)
- `claude_total_cost_usd` (number, OPTIONAL)
  - Cumulative client-side cost estimate from `result` messages, if tracked.
- `turn_count` (integer)
  - Number of coding-agent turns started within the current worker lifetime.

#### 4.1.7 Retry Entry

Scheduled retry state for an issue.

Fields:

- `issue_id`
- `identifier` (best-effort human ID for status surfaces/logs)
- `attempt` (integer, 1-based for retry queue)
- `due_at_ms` (monotonic clock timestamp)
- `timer_handle` (runtime-specific timer reference)
- `error` (string or null)

#### 4.1.8 Orchestrator Runtime State

Single authoritative in-memory state owned by the orchestrator.

Fields:

- `poll_interval_ms` (current effective poll interval)
- `max_concurrent_agents` (current effective global concurrency limit)
- `running` (map `issue_id -> running entry`)
- `claimed` (set of issue IDs reserved/running/retrying)
- `retry_attempts` (map `issue_id -> RetryEntry`)
- `completed` (set of issue IDs; bookkeeping only, not dispatch gating)
- `claude_totals` (aggregate tokens + cost estimate + runtime seconds)
- `claude_rate_limits` (latest `rate_limit_event` payload from the CLI, when the installed
  version emits one; OPTIONAL)
- `claude_api_health` (latest API-retry/backoff snapshot derived from `system`/`api_retry`
  events, OPTIONAL)

Note (difference from the Codex-targeted original): rate-limit exposure depends on the installed
Claude Code version. Recent versions (observed on 2.1.x) emit a top-level `rate_limit_event`
message carrying a `rate_limit_info` payload; implementations SHOULD track the latest such
payload when available and report `null` when the installed CLI does not emit it.

### 4.2 Stable Identifiers and Normalization Rules

- `Issue ID`
  - Use for tracker lookups and internal map keys.
- `Issue Identifier`
  - Use for human-readable logs and workspace naming.
- `Workspace Key`
  - Derive from `issue.identifier` by replacing any character not in `[A-Za-z0-9._-]` with `_`.
  - Use the sanitized value for the workspace directory name.
- `Normalized Issue State`
  - Compare states after `lowercase`.
- `Session ID`
  - Compose from the Claude Code `session_id` and the worker-maintained turn counter as
    `<claude_session_id>-<turn_number>`.

## 5. Workflow Specification (Repository Contract)

### 5.1 File Discovery and Path Resolution

Workflow file path precedence:

1. Explicit application/runtime setting (set by CLI startup path).
2. Default: `WORKFLOW.md` in the current process working directory.

Loader behavior:

- If the file cannot be read, return `missing_workflow_file` error.
- The workflow file is expected to be repository-owned and version-controlled.

### 5.2 File Format

`WORKFLOW.md` is a Markdown file with OPTIONAL YAML front matter.

Design note:

- `WORKFLOW.md` SHOULD be self-contained enough to describe and run different workflows (prompt,
  runtime settings, hooks, and tracker selection/config) without requiring out-of-band
  service-specific configuration.

Parsing rules:

- If file starts with `---`, parse lines until the next `---` as YAML front matter.
- Remaining lines become the prompt body.
- If front matter is absent, treat the entire file as prompt body and use an empty config map.
- YAML front matter MUST decode to a map/object; non-map YAML is an error.
- Prompt body is trimmed before use.

Returned workflow object:

- `config`: front matter root object (not nested under a `config` key).
- `prompt_template`: trimmed Markdown body.

### 5.3 Front Matter Schema

Top-level keys:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `claude`

Unknown keys SHOULD be ignored for forward compatibility.

Note:

- The workflow front matter is extensible. Extensions MAY define additional top-level keys without
  changing the core schema above.
- Extensions SHOULD document their field schema, defaults, validation rules, and whether changes
  apply dynamically or require restart.

#### 5.3.1 `tracker` (object)

Fields:

- `kind` (string)
  - REQUIRED for dispatch.
  - Current supported value: `linear`
- `endpoint` (string)
  - Default for `tracker.kind == "linear"`: `https://api.linear.app/graphql`
- `api_key` (string)
  - MAY be a literal token or `$VAR_NAME`.
  - Canonical environment variable for `tracker.kind == "linear"`: `LINEAR_API_KEY`.
  - If `$VAR_NAME` resolves to an empty string, treat the key as missing.
- `project_slug` (string)
  - REQUIRED for dispatch when `tracker.kind == "linear"`.
- `required_labels` (list of strings)
  - Default: `[]`.
  - An issue MUST contain every configured label to dispatch or continue.
  - Matching ignores case and surrounding whitespace.
  - A blank configured label matches no issue.
- `active_states` (list of strings)
  - Default: `Todo`, `In Progress`
- `terminal_states` (list of strings)
  - Default: `Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done`

#### 5.3.2 `polling` (object)

Fields:

- `interval_ms` (integer)
  - Default: `30000`
  - Changes SHOULD be re-applied at runtime and affect future tick scheduling without restart.

#### 5.3.3 `workspace` (object)

Fields:

- `root` (path string or `$VAR`)
  - Default: `<system-temp>/symphony_workspaces`
  - `~` is expanded.
  - Relative paths are resolved relative to the directory containing `WORKFLOW.md`.
  - The effective workspace root is normalized to an absolute path before use.

#### 5.3.4 `hooks` (object)

Fields:

- `after_create` (multiline shell script string, OPTIONAL)
  - Runs only when a workspace directory is newly created.
  - Failure aborts workspace creation.
- `before_run` (multiline shell script string, OPTIONAL)
  - Runs before each agent attempt after workspace preparation and before launching the coding
    agent.
  - Failure aborts the current attempt.
- `after_run` (multiline shell script string, OPTIONAL)
  - Runs after each agent attempt (success, failure, timeout, or cancellation) once the workspace
    exists.
  - Failure is logged but ignored.
- `before_remove` (multiline shell script string, OPTIONAL)
  - Runs before workspace deletion if the directory exists.
  - Failure is logged but ignored; cleanup still proceeds.
- `timeout_ms` (integer, OPTIONAL)
  - Default: `60000`
  - Applies to all workspace hooks.
  - Invalid values fail configuration validation.
  - Changes SHOULD be re-applied at runtime for future hook executions.

#### 5.3.5 `agent` (object)

Fields:

- `max_concurrent_agents` (integer)
  - Default: `10`
  - Changes SHOULD be re-applied at runtime and affect subsequent dispatch decisions.
- `max_turns` (positive integer)
  - Default: `20`
  - Limits the number of Symphony worker turns (prompt→result cycles) within one worker session.
  - This is distinct from Claude Code's own `--max-turns`, which bounds internal tool-use cycles
    within a single prompt; see `claude.max_agentic_turns`.
  - Invalid values fail configuration validation.
- `max_retry_backoff_ms` (integer)
  - Default: `300000` (5 minutes)
  - Changes SHOULD be re-applied at runtime and affect future retry scheduling.
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - Default: empty map.
  - State keys are normalized (`lowercase`) for lookup.
  - Invalid entries (non-positive or non-numeric) are ignored.

#### 5.3.6 `claude` (object)

This object configures the Claude Code headless runtime. For Claude-owned values such as
`permission_mode` and tool rule patterns, supported values are defined by the installed Claude
Code version. Implementors SHOULD treat them as pass-through values rather than relying on a
hand-maintained enum in this spec. The authoritative references are the Claude Code headless and
CLI documentation (`https://code.claude.com/docs/en/headless`,
`https://code.claude.com/docs/en/cli-reference`). Implementations MAY validate these fields
locally if they want stricter startup checks.

- `command` (string shell command)
  - Default: `claude -p --input-format stream-json --output-format stream-json --verbose`
  - The runtime launches this command via `bash -lc` in the workspace directory.
  - The launched process MUST speak the Claude Code headless `stream-json` protocol over stdio.
  - The runtime MUST append flags derived from the typed config values below (permission mode,
    tool rules, MCP config, model, agentic turn cap, session resume) to this command at launch
    time; the `command` value itself SHOULD stay free of those flags so they remain
    config-driven.
- `permission_mode` (Claude Code permission mode value)
  - Passed as `--permission-mode <value>`.
  - Known values at time of writing: `default`, `dontAsk`, `acceptEdits`, `bypassPermissions`,
    `plan`.
  - Default: implementation-defined. A high-trust deployment typically uses `bypassPermissions`;
    stricter deployments use `acceptEdits` or `default` plus a `permission_prompt_tool`.
- `allowed_tools` (list of tool rule strings, OPTIONAL)
  - Passed as `--allowedTools`. Supports Claude Code permission-rule patterns
    (for example `Bash(git *)`, `mcp__linear__*`).
- `disallowed_tools` (list of tool rule strings, OPTIONAL)
  - Passed as `--disallowedTools`.
- `permission_prompt_tool` (MCP tool name string, OPTIONAL)
  - Passed as `--permission-prompt-tool`. Routes permission prompts to an orchestrator-provided
    MCP tool for programmatic allow/deny decisions in headless mode.
- `mcp_config` (path string or inline JSON, OPTIONAL)
  - Passed as `--mcp-config`. Declares MCP servers (including the OPTIONAL `linear_graphql`
    extension tool; see Section 10.5).
- `model` (string, OPTIONAL)
  - Passed as `--model`. Pass-through Claude model name or alias.
- `max_agentic_turns` (positive integer, OPTIONAL)
  - Passed as `--max-turns`. Bounds internal tool-use cycles within one prompt. Distinct from
    `agent.max_turns` (the worker's prompt→result loop).
- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
  - Wall-clock cap on one prompt→result cycle, enforced by the runtime (Claude Code has no
    built-in turn timeout).
- `read_timeout_ms` (integer)
  - Default: `5000`
  - Request/response timeout for startup and synchronous reads (for example waiting for the
    `system`/`init` message).
- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - If `<= 0`, stall detection is disabled.

### 5.4 Prompt Template Contract

The Markdown body of `WORKFLOW.md` is the per-issue prompt template.

Rendering requirements:

- Use a strict template engine (Liquid-compatible semantics are sufficient).
- Unknown variables MUST fail rendering.
- Unknown filters MUST fail rendering.

Template input variables:

- `issue` (object)
  - Includes all normalized issue fields, including labels and blockers.
- `attempt` (integer or null)
  - `null`/absent on first attempt.
  - Integer on retry or continuation run.

Fallback prompt behavior:

- If the workflow prompt body is empty, the runtime MAY use a minimal default prompt
  (`You are working on an issue from Linear.`).
- Workflow file read/parse failures are configuration/validation errors and SHOULD NOT silently fall
  back to a prompt.

### 5.5 Workflow Validation and Error Surface

Error classes:

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error` (during prompt rendering)
- `template_render_error` (unknown variable/filter, invalid interpolation)

Dispatch gating behavior:

- Workflow file read/YAML errors block new dispatches until fixed.
- Template errors fail only the affected run attempt.

## 6. Configuration Specification

### 6.1 Configuration Resolution Pipeline

Configuration is resolved in this order:

1. Select the workflow file path (explicit runtime setting, otherwise cwd default).
2. Parse YAML front matter into a raw config map.
3. Apply built-in defaults for missing OPTIONAL fields.
4. Resolve `$VAR_NAME` indirection only for config values that explicitly contain `$VAR_NAME`.
5. Coerce and validate typed values.

Environment variables do not globally override YAML values. They are used only when a config value
explicitly references them.

Value coercion semantics:

- Path/command fields support:
  - `~` home expansion
  - `$VAR` expansion for env-backed path values
  - Apply expansion only to values intended to be local filesystem paths; do not rewrite URIs or
    arbitrary shell command strings.
- Relative `workspace.root` values resolve relative to the directory containing the selected
  `WORKFLOW.md`.

### 6.2 Dynamic Reload Semantics

Dynamic reload is REQUIRED:

- The software MUST detect `WORKFLOW.md` changes.
- On change, it MUST re-read and re-apply workflow config and prompt template without restart.
- The software MUST attempt to adjust live behavior to the new config (for example polling
  cadence, concurrency limits, active/terminal states, claude settings, workspace paths/hooks, and
  prompt content for future runs).
- Reloaded config applies to future dispatch, retry scheduling, reconciliation decisions, hook
  execution, and agent launches.
- Implementations are not REQUIRED to restart in-flight agent sessions automatically when config
  changes.
- Extensions that manage their own listeners/resources (for example an HTTP server port change) MAY
  require restart unless the implementation explicitly supports live rebind.
- Implementations SHOULD also re-validate/reload defensively during runtime operations (for example
  before dispatch) in case filesystem watch events are missed.
- Invalid reloads MUST NOT crash the service; keep operating with the last known good effective
  configuration and emit an operator-visible error.

### 6.3 Dispatch Preflight Validation

This validation is a scheduler preflight run before attempting to dispatch new work. It validates
the workflow/config needed to poll and launch workers, not a full audit of all possible workflow
behavior.

Startup validation:

- Validate configuration before starting the scheduling loop.
- If startup validation fails, fail startup and emit an operator-visible error.

Per-tick dispatch validation:

- Re-validate before each dispatch cycle.
- If validation fails, skip dispatch for that tick, keep reconciliation active, and emit an
  operator-visible error.

Validation checks:

- Workflow file can be loaded and parsed.
- `tracker.kind` is present and supported.
- `tracker.api_key` is present after `$` resolution.
- `tracker.project_slug` is present when REQUIRED by the selected tracker kind.
- `claude.command` is present and non-empty.

### 6.4 Core Config Fields Summary (Cheat Sheet)

This section is intentionally redundant so a coding agent can implement the config layer quickly.
Extension fields are documented in the extension section that defines them. Core conformance does
not require recognizing or validating extension fields unless that extension is implemented.

- `tracker.kind`: string, REQUIRED, currently `linear`
- `tracker.endpoint`: string, default `https://api.linear.app/graphql` when `tracker.kind=linear`
- `tracker.api_key`: string or `$VAR`, canonical env `LINEAR_API_KEY` when `tracker.kind=linear`
- `tracker.project_slug`: string, REQUIRED when `tracker.kind=linear`
- `tracker.required_labels`: list of strings, default `[]`
- `tracker.active_states`: list of strings, default `["Todo", "In Progress"]`
- `tracker.terminal_states`: list of strings, default `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path resolved to absolute, default `<system-temp>/symphony_workspaces`
- `hooks.after_create`: shell script or null
- `hooks.before_run`: shell script or null
- `hooks.after_run`: shell script or null
- `hooks.before_remove`: shell script or null
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_turns`: integer, default `20`
- `agent.max_retry_backoff_ms`: integer, default `300000` (5m)
- `agent.max_concurrent_agents_by_state`: map of positive integers, default `{}`
- `claude.command`: shell command string, default `claude -p --input-format stream-json --output-format stream-json --verbose`
- `claude.permission_mode`: Claude Code permission mode value, default implementation-defined
- `claude.allowed_tools`: list of tool rule strings, default unset
- `claude.disallowed_tools`: list of tool rule strings, default unset
- `claude.permission_prompt_tool`: MCP tool name, default unset
- `claude.mcp_config`: path or inline JSON, default unset
- `claude.model`: string, default unset (Claude Code default model)
- `claude.max_agentic_turns`: positive integer, default unset (no inner cap)
- `claude.turn_timeout_ms`: integer, default `3600000`
- `claude.read_timeout_ms`: integer, default `5000`
- `claude.stall_timeout_ms`: integer, default `300000`

## 7. Orchestration State Machine

The orchestrator is the only component that mutates scheduling state. All worker outcomes are
reported back to it and converted into explicit state transitions.

### 7.1 Issue Orchestration States

This is not the same as tracker states (`Todo`, `In Progress`, etc.). This is the service's internal
claim state.

1. `Unclaimed`
   - Issue is not running and has no retry scheduled.

2. `Claimed`
   - Orchestrator has reserved the issue to prevent duplicate dispatch.
   - In practice, claimed issues are either `Running` or `RetryQueued`.

3. `Running`
   - Worker task exists and the issue is tracked in `running` map.

4. `RetryQueued`
   - Worker is not running, but a retry timer exists in `retry_attempts`.

5. `Released`
   - Claim removed because issue is terminal, non-active, missing, or retry path completed without
     re-dispatch.

Important nuance:

- A successful worker exit does not mean the issue is done forever.
- The worker MAY continue through multiple back-to-back coding-agent turns before it exits.
- After each normal turn completion, the worker re-checks the tracker issue state.
- If the issue is still in an active state, the worker SHOULD start another turn on the same live
  Claude session in the same workspace, up to `agent.max_turns`.
- The first turn SHOULD use the full rendered task prompt.
- Continuation turns SHOULD send only continuation guidance to the existing session, not resend the
  original task prompt that is already present in session history.
- Once the worker exits normally, the orchestrator still schedules a short continuation retry
  (about 1 second) so it can re-check whether the issue remains active and needs another worker
  session.

### 7.2 Run Attempt Lifecycle

A run attempt transitions through these phases:

1. `PreparingWorkspace`
2. `BuildingPrompt`
3. `LaunchingAgentProcess`
4. `InitializingSession`
5. `StreamingTurn`
6. `Finishing`
7. `Succeeded`
8. `Failed`
9. `TimedOut`
10. `Stalled`
11. `CanceledByReconciliation`

Distinct terminal reasons are important because retry logic and logs differ.

### 7.3 Transition Triggers

- `Poll Tick`
  - Reconcile active runs.
  - Validate config.
  - Fetch candidate issues.
  - Dispatch until slots are exhausted.

- `Worker Exit (normal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule continuation retry (attempt `1`) after the worker exhausts or finishes its in-process
    turn loop.

- `Worker Exit (abnormal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule exponential-backoff retry.

- `Claude Update Event`
  - Update live session fields, token counters, cost estimate, and API-health snapshot.

- `Retry Timer Fired`
  - Re-fetch active candidates and attempt re-dispatch, or release claim if no longer eligible.

- `Reconciliation State Refresh`
  - Stop runs whose issue states are terminal or no longer active.

- `Stall Timeout`
  - Kill worker and schedule retry.

### 7.4 Idempotency and Recovery Rules

- The orchestrator serializes state mutations through one authority to avoid duplicate dispatch.
- `claimed` and `running` checks are REQUIRED before launching any worker.
- Reconciliation runs before dispatch on every tick.
- Restart recovery is tracker-driven and filesystem-driven (without a durable orchestrator DB).
- Startup terminal cleanup removes stale workspaces for issues already in terminal states.

## 8. Polling, Scheduling, and Reconciliation

### 8.1 Poll Loop

At startup, the service validates config, performs startup cleanup, schedules an immediate tick, and
then repeats every `polling.interval_ms`.

The effective poll interval SHOULD be updated when workflow config changes are re-applied.

Tick sequence:

1. Reconcile running issues.
2. Run dispatch preflight validation.
3. Fetch candidate issues from tracker using active states.
4. Sort issues by dispatch priority.
5. Dispatch eligible issues while slots remain.
6. Notify observability/status consumers of state changes.

If per-tick validation fails, dispatch is skipped for that tick, but reconciliation still happens
first.

### 8.2 Candidate Selection Rules

An issue is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`.
- It is routed to this worker by the configured assignee and contains every
  label in `tracker.required_labels`.
- It is not already in `running`.
- It is not already in `claimed`.
- Global concurrency slots are available.
- Per-state concurrency slots are available.
- Blocker rule for `Todo` state passes:
  - If the issue state is `Todo`, do not dispatch when any blocker is non-terminal.

Sorting order (stable intent):

1. `priority` ascending (1..4 are preferred; null/unknown sorts last)
2. `created_at` oldest first
3. `identifier` lexicographic tie-breaker

### 8.3 Concurrency Control

Global limit:

- `available_slots = max(max_concurrent_agents - running_count, 0)`

Per-state limit:

- `max_concurrent_agents_by_state[state]` if present (state key normalized)
- otherwise fallback to global limit

The runtime counts issues by their current tracked state in the `running` map.

### 8.4 Retry and Backoff

Retry entry creation:

- Cancel any existing retry timer for the same issue.
- Store `attempt`, `identifier`, `error`, `due_at_ms`, and new timer handle.

Backoff formula:

- Normal continuation retries after a clean worker exit use a short fixed delay of `1000` ms.
- Failure-driven retries use `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Power is capped by the configured max retry backoff (default `300000` / 5m).

Retry handling behavior:

1. Fetch active candidate issues (not all issues).
2. Find the specific issue by `issue_id`.
3. If not found, release claim.
4. If found and still candidate-eligible:
   - Dispatch if slots are available.
   - Otherwise requeue with error `no available orchestrator slots`.
5. If found but no longer active, release claim.

Note:

- Terminal-state workspace cleanup is handled by startup cleanup and active-run reconciliation
  (including terminal transitions for currently running issues).
- Retry handling mainly operates on active candidates and releases claims when the issue is absent,
  rather than performing terminal cleanup itself.

### 8.5 Active Run Reconciliation

Reconciliation runs every tick and has two parts.

Part A: Stall detection

- For each running issue, compute `elapsed_ms` since:
  - `last_claude_timestamp` if any event has been seen, else
  - `started_at`
- If `elapsed_ms > claude.stall_timeout_ms`, terminate the worker and queue a retry.
- If `stall_timeout_ms <= 0`, skip stall detection entirely.

Part B: Tracker state refresh

- Fetch current issue states for all running issue IDs.
- For each running issue:
  - If tracker state is terminal: terminate worker and clean workspace.
  - If tracker state is still active: update the in-memory issue snapshot.
  - If tracker state is neither active nor terminal: terminate worker without workspace cleanup.
- If state refresh fails, keep workers running and try again on the next tick.

### 8.6 Startup Terminal Workspace Cleanup

When the service starts:

1. Query tracker for issues in terminal states.
2. For each returned issue identifier, remove the corresponding workspace directory.
3. If the terminal-issues fetch fails, log a warning and continue startup.

This prevents stale terminal workspaces from accumulating after restarts.

## 9. Workspace Management and Safety

### 9.1 Workspace Layout

Workspace root:

- `workspace.root` (normalized absolute path)

Per-issue workspace path:

- `<workspace.root>/<sanitized_issue_identifier>`

Workspace persistence:

- Workspaces are reused across runs for the same issue.
- Successful runs do not auto-delete workspaces.

### 9.2 Workspace Creation and Reuse

Input: `issue.identifier`

Algorithm summary:

1. Sanitize identifier to `workspace_key`.
2. Compute workspace path under workspace root.
3. Ensure the workspace path exists as a directory.
4. Mark `created_now=true` only if the directory was created during this call; otherwise
   `created_now=false`.
5. If `created_now=true`, run `after_create` hook if configured.

Notes:

- This section does not assume any specific repository/VCS workflow.
- Workspace preparation beyond directory creation (for example dependency bootstrap, checkout/sync,
  code generation) is implementation-defined and is typically handled via hooks.

### 9.3 OPTIONAL Workspace Population (Implementation-Defined)

The spec does not require any built-in VCS or repository bootstrap behavior.

Implementations MAY populate or synchronize the workspace using implementation-defined logic and/or
hooks (for example `after_create` and/or `before_run`).

Failure handling:

- Workspace population/synchronization failures return an error for the current attempt.
- If failure happens while creating a brand-new workspace, implementations MAY remove the partially
  prepared directory.
- Reused workspaces SHOULD NOT be destructively reset on population failure unless that policy is
  explicitly chosen and documented.

### 9.4 Workspace Hooks

Supported hooks:

- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `hooks.before_remove`

Execution contract:

- Execute in a local shell context appropriate to the host OS, with the workspace directory as
  `cwd`.
- On POSIX systems, `sh -lc <script>` (or a stricter equivalent such as `bash -lc <script>`) is a
  conforming default.
- Hook timeout uses `hooks.timeout_ms`; default: `60000 ms`.
- Log hook start, failures, and timeouts.

Failure semantics:

- `after_create` failure or timeout is fatal to workspace creation.
- `before_run` failure or timeout is fatal to the current run attempt.
- `after_run` failure or timeout is logged and ignored.
- `before_remove` failure or timeout is logged and ignored.

### 9.5 Safety Invariants

This is the most important portability constraint.

Invariant 1: Run the coding agent only in the per-issue workspace path.

- Before launching the coding-agent subprocess, validate:
  - `cwd == workspace_path`

Invariant 2: Workspace path MUST stay inside workspace root.

- Normalize both paths to absolute.
- Require `workspace_path` to have `workspace_root` as a prefix directory.
- Reject any path outside the workspace root.

Invariant 3: Workspace key is sanitized.

- Only `[A-Za-z0-9._-]` allowed in workspace directory names.
- Replace all other characters with `_`.

## 10. Agent Runner Protocol (Claude Code Integration)

This section defines Symphony's language-neutral responsibilities when integrating Claude Code in
headless mode. The Claude Code headless `stream-json` protocol for the installed Claude Code
version is the source of truth for message payloads, transport framing, and field names.

Protocol source of truth:

- Implementations MUST send messages that are valid for the installed Claude Code version.
- Implementations MUST consult the Claude Code headless documentation
  (`https://code.claude.com/docs/en/headless`) and CLI reference
  (`https://code.claude.com/docs/en/cli-reference`) instead of treating this specification as a
  protocol schema.
- If this specification appears to conflict with the installed Claude Code protocol, the Claude
  Code protocol controls protocol shape and transport behavior.
- Symphony-specific requirements in this section still control orchestration behavior, workspace
  selection, prompt construction, continuation handling, and observability extraction.

Implementation routes:

- `Route A — CLI subprocess (normative description below)`: spawn the `claude` CLI in headless
  mode and speak `stream-json` over stdio. This is the closest structural match to the original
  app-server design.
- `Route B — Claude Agent SDK`: use `claude-agent-sdk` (Python) or
  `@anthropic-ai/claude-agent-sdk` (TypeScript). The SDK manages the same subprocess and exposes
  the same concepts as typed options (`cwd`, `max_turns`, `permission_mode`, `allowed_tools`,
  `disallowed_tools`, `mcp_servers`, `resume`, `can_use_tool`, streaming input via an async
  iterable of user messages). An SDK-based runner is conforming as long as it satisfies the
  observable behavior in this section. Route B is RECOMMENDED when the orchestrator is written in
  Python or TypeScript, because it allows in-process MCP tools (Section 10.5) and a typed
  permission callback.

### 10.1 Launch Contract

Subprocess launch parameters:

- Command: `claude.command` plus runtime-appended flags derived from `claude.*` config
  (`--permission-mode`, `--allowedTools`, `--disallowedTools`, `--permission-prompt-tool`,
  `--mcp-config`, `--model`, `--max-turns`, and `--resume <session_id>` when resuming).
- Invocation: `bash -lc <full command>`
- Working directory: workspace path
- Transport/framing: newline-delimited JSON (`stream-json`) on stdin/stdout; diagnostics on stderr

Notes:

- The default command is `claude -p --input-format stream-json --output-format stream-json
  --verbose`.
- `--input-format stream-json` is what keeps the subprocess alive across multiple user turns: the
  process reads JSON-line user messages from stdin and exits when stdin closes.
- Implementations MAY add `--include-partial-messages` to receive raw API `stream_event` messages
  for finer-grained liveness/streaming display; this is OPTIONAL and orchestrator logic MUST NOT
  depend on partial events.

RECOMMENDED additional process settings:

- Max line size: 10 MB (for safe buffering)

### 10.2 Session Startup Responsibilities

Reference: https://code.claude.com/docs/en/headless

Startup MUST follow the installed Claude Code headless contract. Symphony additionally requires
the client to:

- Start the `claude` subprocess in the per-issue workspace (the workspace path is the process
  cwd; Claude Code scopes its file tools to the cwd project).
- Wait for the `system` message with subtype `init` and extract `session_id` from it (the same
  `session_id` appears on every subsequent message).
- Send the first turn as a stream-json user message containing the rendered issue prompt:

  ```json
  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"<rendered prompt>"}]}}
  ```

- Send later in-worker continuation turns as additional user messages on the same live process
  with continuation guidance, rather than resending the original issue prompt.
- Supply the implementation's documented permission posture via the appended `--permission-mode`,
  `--allowedTools`, `--disallowedTools`, and/or `--permission-prompt-tool` flags.
- Advertise implemented client-side tools by passing an MCP configuration (`--mcp-config`, or SDK
  `mcp_servers`) and allowing the corresponding `mcp__<server>__<tool>` names.
- If a previous worker session for the same issue must be resumed after a process restart, pass
  `--resume <claude_session_id>` (the workspace cwd MUST be the same per-issue workspace).

Session identifiers:

- Extract `claude_session_id` from the `system`/`init` message.
- Maintain `turn_number` in the worker (1-based, incremented per prompt→result cycle); Claude
  Code does not emit a turn identifier.
- Emit `session_id = "<claude_session_id>-<turn_number>"`.
- Reuse the same `claude_session_id` for all continuation turns inside one worker run.

Note: Claude Code headless mode has no per-turn title field. The issue-identifying metadata
requirement from the original spec (`<issue.identifier>: <issue.title>`) is satisfied by
including that line at the top of the rendered prompt and in structured logs.

### 10.3 Streaming Turn Processing

The client processes stream-json messages from stdout until the active turn terminates.

Message types (installed-version protocol controls the exact set):

- `system` — lifecycle/diagnostic messages; known subtypes include `init`, `api_retry`, and
  `compact_boundary`.
- `assistant` — a complete assistant message, including text and `tool_use` content blocks, with
  per-step token usage at `message.usage`.
- `user` — echoed user/tool-result messages.
- `stream_event` — raw API streaming events (only when `--include-partial-messages` is set).
- `result` — exactly one per prompt→result cycle; carries `is_error`/subtype, cumulative
  `usage`, `total_cost_usd`, `num_turns`, and duration fields.

Completion conditions:

- `result` message with success subtype -> success
- `result` message with error subtype / `is_error` -> failure
- turn timeout (`claude.turn_timeout_ms`) -> failure
- subprocess exit before a `result` is received -> failure

Continuation processing:

- If the worker decides to continue after a successful turn, it SHOULD write another stream-json
  user message to stdin of the same live process.
- The subprocess SHOULD remain alive across those continuation turns and be stopped (stdin closed,
  then process terminated if needed) only when the worker run is ending.

Transport handling requirements:

- Parse stdout line-by-line as JSON; tolerate and surface (as `malformed`) any line that fails to
  parse.
- Keep protocol stream handling (stdout) separate from diagnostic stderr handling.

### 10.4 Emitted Runtime Events (Upstream to Orchestrator)

The headless client emits structured events to the orchestrator callback. Each event SHOULD
include:

- `event` (enum/string)
- `timestamp` (UTC timestamp)
- `claude_pid` (if available)
- OPTIONAL `usage` map (token counts)
- payload fields as needed

Important emitted events include, for example:

- `session_started` (on `system`/`init`)
- `startup_failed`
- `turn_completed` (on successful `result`)
- `turn_failed` (on error `result`, turn timeout, or premature process exit)
- `turn_cancelled` (orchestrator-initiated termination)
- `api_retry` (on `system`/`api_retry`; feeds the OPTIONAL `claude_api_health` snapshot)
- `rate_limit` (on `rate_limit_event`, when emitted by the installed CLI; feeds the OPTIONAL
  `claude_rate_limits` snapshot)
- `permission_denied` (when a `permission_prompt_tool` or SDK `can_use_tool` callback denies a
  tool call)
- `unsupported_tool_call`
- `notification` (assistant text suitable for status surfaces)
- `other_message`
- `malformed`

Note: the original spec's `turn_input_required` event has no direct Claude equivalent. In
headless mode Claude Code does not pause for free-form user input mid-turn; permission requests
are the only input-like interruption, and they are resolved by the configured permission mode,
the `permission_prompt_tool`, or the SDK permission callback (Section 10.5).

### 10.5 Permissions, Tool Calls, and User Input Policy

Permission and sandbox behavior is implementation-defined.

Policy requirements:

- Each implementation MUST document its chosen permission mode, tool allow/deny rules, and
  operator-confirmation posture.
- Permission requests MUST NOT leave a run stalled indefinitely. An implementation MAY satisfy
  them automatically (`bypassPermissions` / `acceptEdits` / `--allowedTools` rules), resolve them
  programmatically (`--permission-prompt-tool` or SDK `can_use_tool`), surface them to an
  operator, or fail the run according to its documented policy.

Example high-trust behavior:

- Launch with `--permission-mode bypassPermissions`.
- Use `--disallowedTools` to carve out commands that must never run (for example
  `Bash(rm -rf *)`, network-publishing commands).
- Treat any residual permission prompt (which can still occur for explicit `ask` rules) as hard
  failure.

Unsupported dynamic tool calls:

- Tools the runtime advertises via MCP SHOULD be handled according to their extension contract.
- If the agent requests an MCP tool that the orchestrator does not implement, the MCP server MUST
  return a tool error result so the session continues without stalling.

Optional client-side tool extension:

- An implementation MAY expose a limited set of client-side tools to the session via MCP.
- Current standardized optional tool: `linear_graphql`.
- Route A (CLI): run the tool inside an orchestrator-owned MCP server declared in
  `claude.mcp_config`; the tool is visible to the model as `mcp__<server>__linear_graphql` and
  MUST be included in `claude.allowed_tools` (or otherwise permitted) to be callable without
  prompts.
- Route B (SDK): register the tool on an in-process SDK MCP server
  (`create_sdk_mcp_server` / `createSdkMcpServer` + `tool()`), so the tool executes inside the
  orchestrator process.
- Unsupported tool names SHOULD still return a failure result through MCP and continue the
  session.

`linear_graphql` extension contract:

- Purpose: execute a raw GraphQL query or mutation against Linear using Symphony's configured
  tracker auth for the current session.
- Availability: only meaningful when `tracker.kind == "linear"` and valid Linear auth is configured.
- Preferred input shape:

  ```json
  {
    "query": "single GraphQL query or mutation document",
    "variables": {
      "optional": "graphql variables object"
    }
  }
  ```

- `query` MUST be a non-empty string.
- `query` MUST contain exactly one GraphQL operation.
- `variables` is OPTIONAL and, when present, MUST be a JSON object.
- Implementations MAY additionally accept a raw GraphQL query string as shorthand input.
- Execute one GraphQL operation per tool call.
- If the provided document contains multiple operations, reject the tool call as invalid input.
- `operationName` selection is intentionally out of scope for this extension.
- Reuse the configured Linear endpoint and auth from the active Symphony workflow/runtime config; do
  not require the coding agent to read raw tokens from disk. (Both MCP routes satisfy this: the
  token stays inside the orchestrator/MCP-server process and never enters the workspace.)
- Tool result semantics:
  - transport success + no top-level GraphQL `errors` -> `success=true`
  - top-level GraphQL `errors` present -> `success=false`, but preserve the GraphQL response body
    for debugging
  - invalid input, missing auth, or transport failure -> `success=false` with an error payload
- Return the GraphQL response or error payload as structured tool output that the model can inspect
  in-session.

User-input-required policy:

- Implementations MUST document how permission prompts are handled (mode, rules, prompt tool, or
  callback).
- A run MUST NOT stall indefinitely waiting for user input.
- The example high-trust behavior above auto-approves via `bypassPermissions` and fails the run on
  any residual prompt.

### 10.6 Timeouts and Error Mapping

Timeouts:

- `claude.read_timeout_ms`: startup/synchronous read timeout (for example waiting for
  `system`/`init`)
- `claude.turn_timeout_ms`: total per-turn stream timeout, enforced by the runtime
- `claude.stall_timeout_ms`: enforced by orchestrator based on event inactivity

Error mapping (RECOMMENDED normalized categories):

- `claude_not_found` (executable missing / spawn failure)
- `invalid_workspace_cwd`
- `response_timeout`
- `turn_timeout`
- `process_exit` (subprocess died before `result`)
- `response_error` (malformed or unexpected protocol payload)
- `turn_failed` (error `result`)
- `turn_cancelled`
- `permission_denied`

### 10.7 Agent Runner Contract

The `Agent Runner` wraps workspace + prompt + headless client.

Behavior:

1. Create/reuse workspace for issue.
2. Build prompt from workflow template.
3. Start headless session (spawn subprocess or open SDK client) and await `system`/`init`.
4. Forward stream-json messages to the orchestrator as runtime events.
5. On any error, fail the worker attempt (the orchestrator will retry).

Note:

- Workspaces are intentionally preserved after successful runs.

## 11. Issue Tracker Integration Contract (Linear-Compatible)

### 11.1 REQUIRED Operations

An implementation MUST support these tracker adapter operations:

1. `fetch_candidate_issues()`
   - Return issues in configured active states for a configured project.

2. `fetch_issues_by_states(state_names)`
   - Used for startup terminal cleanup.

3. `fetch_issue_states_by_ids(issue_ids)`
   - Used for active-run reconciliation.

### 11.2 Query Semantics (Linear)

Linear-specific requirements for `tracker.kind == "linear"`:

- `tracker.kind == "linear"`
- GraphQL endpoint (default `https://api.linear.app/graphql`)
- Auth token sent in `Authorization` header
- `tracker.project_slug` maps to Linear project `slugId`
- Candidate issue query filters project using `project: { slugId: { eq: $projectSlug } }`
- Candidate and issue-state refresh queries include issue labels. Required
  label filtering happens after normalization so refresh can observe label
  removal and stop or release existing work.
- Issue-state refresh query uses GraphQL issue IDs with variable type `[ID!]`
- Pagination REQUIRED for candidate issues
- Page size default: `50`
- Network timeout: `30000 ms`

Important:

- Linear GraphQL schema details can drift. Keep query construction isolated and test the exact query
  fields/types REQUIRED by this specification.

A non-Linear implementation MAY change transport details, but the normalized outputs MUST match the
domain model in Section 4.

### 11.3 Normalization Rules

Candidate issue normalization SHOULD produce fields listed in Section 4.1.1.

Additional normalization details:

- Label names are trimmed and lowercased.

- `labels` -> lowercase strings
- `blocked_by` -> derived from inverse relations where relation type is `blocks`
- `priority` -> integer only (non-integers become null)
- `created_at` and `updated_at` -> parse ISO-8601 timestamps

### 11.4 Error Handling Contract

RECOMMENDED error categories:

- `unsupported_tracker_kind`
- `missing_tracker_api_key`
- `missing_tracker_project_slug`
- `linear_api_request` (transport failures)
- `linear_api_status` (non-200 HTTP)
- `linear_graphql_errors`
- `linear_unknown_payload`
- `linear_missing_end_cursor` (pagination integrity error)

Orchestrator behavior on tracker errors:

- Candidate fetch failure: log and skip dispatch for this tick.
- Running-state refresh failure: log and keep active workers running.
- Startup terminal cleanup failure: log warning and continue startup.

### 11.5 Tracker Writes (Important Boundary)

Symphony does not require first-class tracker write APIs in the orchestrator.

- Ticket mutations (state transitions, comments, PR metadata) are typically handled by the coding
  agent using tools defined by the workflow prompt.
- The service remains a scheduler/runner and tracker reader.
- Workflow-specific success often means "reached the next handoff state" (for example
  `Human Review`) rather than tracker terminal state `Done`.
- If the `linear_graphql` client-side tool extension is implemented, it is still part of the agent
  toolchain rather than orchestrator business logic.

## 12. Prompt Construction and Context Assembly

### 12.1 Inputs

Inputs to prompt rendering:

- `workflow.prompt_template`
- normalized `issue` object
- OPTIONAL `attempt` integer (retry/continuation metadata)

### 12.2 Rendering Rules

- Render with strict variable checking.
- Render with strict filter checking.
- Convert issue object keys to strings for template compatibility.
- Preserve nested arrays/maps (labels, blockers) so templates can iterate.

### 12.3 Retry/Continuation Semantics

`attempt` SHOULD be passed to the template because the workflow prompt can provide different
instructions for:

- first run (`attempt` null or absent)
- continuation run after a successful prior session
- retry after error/timeout/stall

### 12.4 Failure Semantics

If prompt rendering fails:

- Fail the run attempt immediately.
- Let the orchestrator treat it like any other worker failure and decide retry behavior.

## 13. Logging, Status, and Observability

### 13.1 Logging Conventions

REQUIRED context fields for issue-related logs:

- `issue_id`
- `issue_identifier`

REQUIRED context for coding-agent session lifecycle logs:

- `session_id`

Message formatting requirements:

- Use stable `key=value` phrasing.
- Include action outcome (`completed`, `failed`, `retrying`, etc.).
- Include concise failure reason when present.
- Avoid logging large raw payloads unless necessary.

### 13.2 Logging Outputs and Sinks

The spec does not prescribe where logs are written (stderr, file, remote sink, etc.).

Requirements:

- Operators MUST be able to see startup/validation/dispatch failures without attaching a debugger.
- Implementations MAY write to one or more sinks.
- If a configured log sink fails, the service SHOULD continue running when possible and emit an
  operator-visible warning through any remaining sink.

### 13.3 Runtime Snapshot / Monitoring Interface (OPTIONAL but RECOMMENDED)

If the implementation exposes a synchronous runtime snapshot (for dashboards or monitoring), it
SHOULD return:

- `running` (list of running session rows)
- each running row SHOULD include `turn_count`
- `retrying` (list of retry queue rows)
- session and retry rows SHOULD include the tracker-provided issue URL when available
- `claude_totals`
  - `input_tokens`
  - `output_tokens`
  - `total_tokens`
  - `total_cost_usd` (OPTIONAL, client-side estimate)
  - `seconds_running` (aggregate runtime seconds as of snapshot time, including active sessions)
- `rate_limits` (latest `rate_limit_event` payload when the installed CLI emits one, otherwise
  `null`; implementations MAY additionally expose the OPTIONAL `api_health` snapshot derived
  from `api_retry` events)

RECOMMENDED snapshot error modes:

- `timeout`
- `unavailable`

### 13.4 OPTIONAL Human-Readable Status Surface

A human-readable status surface (terminal output, dashboard, etc.) is OPTIONAL and
implementation-defined.

If present, it SHOULD draw from orchestrator state/metrics only and MUST NOT be REQUIRED for
correctness.

### 13.5 Session Metrics and Token Accounting

Token accounting rules (stream-json):

- Per-step usage appears on each `assistant` message at `message.usage` (fields include
  `input_tokens`, `output_tokens`, and OPTIONAL `cache_creation_input_tokens` /
  `cache_read_input_tokens`).
- Multiple `assistant` messages can share the same `message.id` (parallel tool use);
  implementations MUST deduplicate per-step usage by `message.id` to avoid double-counting.
- The `result` message carries cumulative `usage` for the whole prompt→result cycle plus
  `total_cost_usd`. Prefer these cumulative values as the absolute source of truth.
- For absolute totals, track deltas relative to last reported totals to avoid double-counting
  across continuation turns in one session.
- Treat per-`assistant` usage as incremental/step-level telemetry for live display only; do not
  sum it into dashboard totals when `result` totals are available.
- Accumulate aggregate totals (and OPTIONAL cost estimate) in orchestrator state.
- `total_cost_usd` is a client-side estimate, not authoritative billing; label it accordingly in
  any operator surface.

Runtime accounting:

- Runtime SHOULD be reported as a live aggregate at snapshot/render time.
- Implementations MAY maintain a cumulative counter for ended sessions and add active-session
  elapsed time derived from `running` entries (for example `started_at`) when producing a
  snapshot/status view.
- Add run duration seconds to the cumulative ended-session runtime when a session ends (normal exit
  or cancellation/termination).
- Continuous background ticking of runtime totals is not REQUIRED.

Rate-limit and API-health tracking:

- Recent Claude Code versions (observed on 2.1.x) emit a top-level `rate_limit_event` message
  with a `rate_limit_info` payload (status, reset timestamps, limit type, overage state).
  Implementations SHOULD track the latest payload seen in any agent update, mirroring the
  original spec's rate-limit tracking; treat the payload as opaque/version-defined.
- Implementations MAY additionally track the latest `system`/`api_retry` event (attempt count,
  max retries, retry delay, error category) as an API-health signal.
- When the installed CLI emits neither, report `null`.
- Any human-readable presentation of rate-limit/API-health data is implementation-defined.

### 13.6 Humanized Agent Event Summaries (OPTIONAL)

Humanized summaries of raw agent protocol events are OPTIONAL.

If implemented:

- Treat them as observability-only output.
- Do not make orchestrator logic depend on humanized strings.

### 13.7 OPTIONAL HTTP Server Extension

This section defines an OPTIONAL HTTP interface for observability and operational control.

If implemented:

- The HTTP server is an extension and is not REQUIRED for conformance.
- The implementation MAY serve server-rendered HTML or a client-side application for the dashboard.
- The dashboard/API MUST be observability/control surfaces only and MUST NOT become REQUIRED for
  orchestrator correctness.

Extension config:

- `server.port` (integer, OPTIONAL)
  - Enables the HTTP server extension.
  - `0` requests an ephemeral port for local development and tests.
  - CLI `--port` overrides `server.port` when both are present.

Enablement (extension):

- Start the HTTP server when a CLI `--port` argument is provided.
- Start the HTTP server when `server.port` is present in `WORKFLOW.md` front matter.
- The `server` top-level key is owned by this extension.
- Positive `server.port` values bind that port.
- Implementations SHOULD bind loopback by default (`127.0.0.1` or host equivalent) unless explicitly
  configured otherwise.
- Changes to HTTP listener settings (for example `server.port`) do not need to hot-rebind;
  restart-required behavior is conformant.

#### 13.7.1 Human-Readable Dashboard (`/`)

- Host a human-readable dashboard at `/`.
- The returned document SHOULD depict the current state of the system (for example active sessions,
  retry delays, token consumption, cost estimate, runtime totals, recent events, and health/error
  indicators).
- It is up to the implementation whether this is server-generated HTML or a client-side app that
  consumes the JSON API below.

#### 13.7.2 JSON REST API (`/api/v1/*`)

Provide a JSON REST API under `/api/v1/*` for current runtime state and operational debugging.

Minimum endpoints:

- `GET /api/v1/state`
  - Returns a summary view of the current system state (running sessions, retry queue/delays,
    aggregate token/cost/runtime totals, latest API-health snapshot, and any additional tracked
    summary fields).
  - Suggested response shape:

    ```json
    {
      "generated_at": "2026-02-24T20:15:30Z",
      "counts": {
        "running": 2,
        "retrying": 1
      },
      "running": [
        {
          "issue_id": "abc123",
          "issue_identifier": "MT-649",
          "issue_url": "https://tracker.example/issues/MT-649",
          "state": "In Progress",
          "session_id": "f81c2a3e-...-1",
          "turn_count": 7,
          "last_event": "turn_completed",
          "last_message": "",
          "started_at": "2026-02-24T20:10:12Z",
          "last_event_at": "2026-02-24T20:14:59Z",
          "tokens": {
            "input_tokens": 1200,
            "output_tokens": 800,
            "total_tokens": 2000
          }
        }
      ],
      "retrying": [
        {
          "issue_id": "def456",
          "issue_identifier": "MT-650",
          "issue_url": "https://tracker.example/issues/MT-650",
          "attempt": 3,
          "due_at": "2026-02-24T20:16:00Z",
          "error": "no available orchestrator slots"
        }
      ],
      "claude_totals": {
        "input_tokens": 5000,
        "output_tokens": 2400,
        "total_tokens": 7400,
        "total_cost_usd": 1.42,
        "seconds_running": 1834.2
      },
      "rate_limits": null,
      "api_health": null
    }
    ```

- `GET /api/v1/<issue_identifier>`
  - Returns issue-specific runtime/debug details for the identified issue, including any information
    the implementation tracks that is useful for debugging.
  - Suggested response shape:

    ```json
    {
      "issue_identifier": "MT-649",
      "issue_id": "abc123",
      "status": "running",
      "workspace": {
        "path": "/tmp/symphony_workspaces/MT-649"
      },
      "attempts": {
        "restart_count": 1,
        "current_retry_attempt": 2
      },
      "running": {
        "session_id": "f81c2a3e-...-1",
        "turn_count": 7,
        "state": "In Progress",
        "started_at": "2026-02-24T20:10:12Z",
        "last_event": "notification",
        "last_message": "Working on tests",
        "last_event_at": "2026-02-24T20:14:59Z",
        "tokens": {
          "input_tokens": 1200,
          "output_tokens": 800,
          "total_tokens": 2000
        }
      },
      "retry": null,
      "logs": {
        "claude_session_logs": [
          {
            "label": "latest",
            "path": "/var/log/symphony/claude/MT-649/latest.log",
            "url": null
          }
        ]
      },
      "recent_events": [
        {
          "at": "2026-02-24T20:14:59Z",
          "event": "notification",
          "message": "Working on tests"
        }
      ],
      "last_error": null,
      "tracked": {}
    }
    ```

  - If the issue is unknown to the current in-memory state, return `404` with an error response (for
    example `{"error":{"code":"issue_not_found","message":"..."}}`).

- `POST /api/v1/refresh`
  - Queues an immediate tracker poll + reconciliation cycle (best-effort trigger; implementations
    MAY coalesce repeated requests).
  - Suggested request body: empty body or `{}`.
  - Suggested response (`202 Accepted`) shape:

    ```json
    {
      "queued": true,
      "coalesced": false,
      "requested_at": "2026-02-24T20:15:30Z",
      "operations": ["poll", "reconcile"]
    }
    ```

API design notes:

- The JSON shapes above are the RECOMMENDED baseline for interoperability and debugging ergonomics.
- Implementations MAY add fields, but SHOULD avoid breaking existing fields within a version.
- Endpoints SHOULD be read-only except for operational triggers like `/refresh`.
- Unsupported methods on defined routes SHOULD return `405 Method Not Allowed`.
- API errors SHOULD use a JSON envelope such as `{"error":{"code":"...","message":"..."}}`.
- If the dashboard is a client-side app, it SHOULD consume this API rather than duplicating state
  logic.

## 14. Failure Model and Recovery Strategy

### 14.1 Failure Classes

1. `Workflow/Config Failures`
   - Missing `WORKFLOW.md`
   - Invalid YAML front matter
   - Unsupported tracker kind or missing tracker credentials/project slug
   - Missing `claude` executable or missing Claude authentication

2. `Workspace Failures`
   - Workspace directory creation failure
   - Workspace population/synchronization failure (implementation-defined; can come from hooks)
   - Invalid workspace path configuration
   - Hook timeout/failure

3. `Agent Session Failures`
   - Startup failure (spawn failure, no `system`/`init` within `read_timeout_ms`)
   - Error `result` (turn failed)
   - Turn timeout
   - Permission prompt handled as failure by the implementation's documented policy
   - Subprocess exit before `result`
   - Stalled session (no activity)

4. `Tracker Failures`
   - API transport errors
   - Non-200 status
   - GraphQL errors
   - malformed payloads

5. `Observability Failures`
   - Snapshot timeout
   - Dashboard render errors
   - Log sink configuration failure

### 14.2 Recovery Behavior

- Dispatch validation failures:
  - Skip new dispatches.
  - Keep service alive.
  - Continue reconciliation where possible.

- Worker failures:
  - Convert to retries with exponential backoff.

- Tracker candidate-fetch failures:
  - Skip this tick.
  - Try again on next tick.

- Reconciliation state-refresh failures:
  - Keep current workers.
  - Retry on next tick.

- Dashboard/log failures:
  - Do not crash the orchestrator.

### 14.3 Partial State Recovery (Restart)

Current design is intentionally in-memory for scheduler state.
Restart recovery means the service can resume useful operation by polling tracker state and reusing
preserved workspaces. It does not mean retry timers, running sessions, or live worker state survive
process restart.

After restart:

- No retry timers are restored from prior process memory.
- No running sessions are assumed recoverable.
- Service recovers by:
  - startup terminal workspace cleanup
  - fresh polling of active issues
  - re-dispatching eligible work
- Implementations MAY additionally persist the last `claude_session_id` per issue and pass
  `--resume <claude_session_id>` on re-dispatch so the new worker session retains conversation
  context from before the restart. This is an OPTIONAL optimization, not REQUIRED recovery
  behavior.

### 14.4 Operator Intervention Points

Operators can control behavior by:

- Editing `WORKFLOW.md` (prompt and most runtime settings).
- `WORKFLOW.md` changes are detected and re-applied automatically without restart according to
  Section 6.2.
- Changing issue states in the tracker:
  - terminal state -> running session is stopped and workspace cleaned when reconciled
  - non-active state -> running session is stopped without cleanup
- Restarting the service for process recovery or deployment (not as the normal path for applying
  workflow config changes).

## 15. Security and Operational Safety

### 15.1 Trust Boundary Assumption

Each implementation defines its own trust boundary.

Operational safety requirements:

- Implementations SHOULD state clearly whether they are intended for trusted environments, more
  restrictive environments, or both.
- Implementations SHOULD state clearly whether they rely on auto-approved actions
  (`bypassPermissions` / `acceptEdits`), operator approvals, tool allow/deny rules, or some
  combination of those controls.
- Workspace isolation and path validation are important baseline controls, but they are not a
  substitute for whatever permission policy an implementation chooses.

### 15.2 Filesystem Safety Requirements

Mandatory:

- Workspace path MUST remain under configured workspace root.
- Coding-agent cwd MUST be the per-issue workspace path for the current run.
- Workspace directory names MUST use sanitized identifiers.

RECOMMENDED additional hardening for ports:

- Run under a dedicated OS user.
- Restrict workspace root permissions.
- Mount workspace root on a dedicated volume if possible.

### 15.3 Secret Handling

- Support `$VAR` indirection in workflow config.
- Do not log API tokens or secret env values.
- Validate presence of secrets without printing them.
- Keep tracker tokens inside the orchestrator/MCP-server process; the `linear_graphql` MCP route
  exists specifically so the agent never reads raw tokens from disk or environment inside the
  workspace.

### 15.4 Hook Script Safety

Workspace hooks are arbitrary shell scripts from `WORKFLOW.md`.

Implications:

- Hooks are fully trusted configuration.
- Hooks run inside the workspace directory.
- Hook output SHOULD be truncated in logs.
- Hook timeouts are REQUIRED to avoid hanging the orchestrator.

### 15.5 Harness Hardening Guidance

Running Claude agents against repositories, issue trackers, and other inputs that can contain
sensitive data or externally-controlled content can be dangerous. A permissive deployment can lead
to data leaks, destructive mutations, or full machine compromise if the agent is induced to execute
harmful commands or use overly-powerful integrations.

Implementations SHOULD explicitly evaluate their own risk profile and harden the execution harness
where appropriate. This specification intentionally does not mandate a single hardening posture, but
implementations SHOULD NOT assume that tracker data, repository contents, prompt inputs, or tool
arguments are fully trustworthy just because they originate inside a normal workflow.

Possible hardening measures include:

- Tightening the Claude permission posture described elsewhere in this specification instead of
  running with `bypassPermissions` — for example `acceptEdits` plus explicit `--allowedTools`
  rules, or `default` mode with a `permission_prompt_tool` that applies orchestrator policy per
  tool call.
- Using `--disallowedTools` (with scoped patterns such as `Bash(curl *)` or `WebFetch`) and
  declarative `settings.json` permission rules in the workspace to remove or constrain dangerous
  capabilities.
- Adding external isolation layers such as OS/container/VM sandboxing, network restrictions, or
  separate credentials beyond the built-in Claude Code policy controls.
- Filtering which Linear issues, projects, teams, labels, or other tracker sources are eligible for
  dispatch so untrusted or out-of-scope tasks do not automatically reach the agent.
- Narrowing the `linear_graphql` tool so it can only read or mutate data inside the
  intended project scope, rather than exposing general workspace-wide tracker access.
- Reducing the set of MCP tools, credentials, filesystem paths, and network destinations
  available to the agent to the minimum needed for the workflow.

The correct controls are deployment-specific, but implementations SHOULD document them clearly and
treat harness hardening as part of the core safety model rather than an optional afterthought.

## 16. Reference Algorithms (Language-Agnostic)

### 16.1 Service Startup

```text
function start_service():
  configure_logging()
  start_observability_outputs()
  start_workflow_watch(on_change=reload_and_reapply_workflow)

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    max_concurrent_agents: get_config_max_concurrent_agents(),
    running: {},
    claimed: set(),
    retry_attempts: {},
    completed: set(),
    claude_totals: {input_tokens: 0, output_tokens: 0, total_tokens: 0, total_cost_usd: 0, seconds_running: 0},
    claude_api_health: null
  }

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  startup_terminal_workspace_cleanup()
  schedule_tick(delay_ms=0)

  event_loop(state)
```

### 16.2 Poll-and-Dispatch Tick

```text
on_tick(state):
  state = reconcile_running_issues(state)

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  issues = tracker.fetch_candidate_issues()
  if issues failed:
    log_tracker_error()
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  for issue in sort_for_dispatch(issues):
    if no_available_slots(state):
      break

    if should_dispatch(issue, state):
      state = dispatch_issue(issue, state, attempt=null)

  notify_observers()
  schedule_tick(state.poll_interval_ms)
  return state
```

### 16.3 Reconcile Active Runs

```text
function reconcile_running_issues(state):
  state = reconcile_stalled_runs(state)

  running_ids = keys(state.running)
  if running_ids is empty:
    return state

  refreshed = tracker.fetch_issue_states_by_ids(running_ids)
  if refreshed failed:
    log_debug("keep workers running")
    return state

  for issue in refreshed:
    if issue.state in terminal_states:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=true)
    else if issue.state in active_states:
      state.running[issue.id].issue = issue
    else:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=false)

  return state
```

### 16.4 Dispatch One Issue

```text
function dispatch_issue(issue, state, attempt):
  worker = spawn_worker(
    fn -> run_agent_attempt(issue, attempt, parent_orchestrator_pid) end
  )

  if worker spawn failed:
    return schedule_retry(state, issue.id, next_attempt(attempt), {
      identifier: issue.identifier,
      error: "failed to spawn agent"
    })

  state.running[issue.id] = {
    worker_handle,
    monitor_handle,
    identifier: issue.identifier,
    issue,
    session_id: null,
    claude_session_id: null,
    claude_pid: null,
    last_claude_message: null,
    last_claude_event: null,
    last_claude_timestamp: null,
    claude_input_tokens: 0,
    claude_output_tokens: 0,
    claude_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    retry_attempt: normalize_attempt(attempt),
    started_at: now_utc()
  }

  state.claimed.add(issue.id)
  state.retry_attempts.remove(issue.id)
  return state
```

### 16.5 Worker Attempt (Workspace + Prompt + Agent)

```text
function run_agent_attempt(issue, attempt, orchestrator_channel):
  workspace = workspace_manager.create_for_issue(issue.identifier)
  if workspace failed:
    fail_worker("workspace error")

  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

  session = claude_client.start_session(workspace=workspace.path)
  # start_session: spawn `bash -lc <claude.command + derived flags>` with cwd=workspace.path,
  # then await the `system`/`init` message (read_timeout_ms) and capture claude_session_id.
  if session failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("agent session startup error")

  max_turns = config.agent.max_turns
  turn_number = 1

  while true:
    prompt = build_turn_prompt(workflow_template, issue, attempt, turn_number, max_turns)
    if prompt failed:
      claude_client.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("prompt error")

    turn_result = claude_client.run_turn(
      session=session,
      prompt=prompt,           # written to stdin as a stream-json user message
      issue=issue,
      on_message=(msg) -> send(orchestrator_channel, {claude_update, issue.id, msg})
    )                          # completes on the `result` message, turn timeout, or process exit

    if turn_result failed:
      claude_client.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("agent turn error")

    refreshed_issue = tracker.fetch_issue_states_by_ids([issue.id])
    if refreshed_issue failed:
      claude_client.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("issue state refresh error")

    issue = refreshed_issue[0] or issue

    if issue.state is not active:
      break

    if turn_number >= max_turns:
      break

    turn_number = turn_number + 1

  claude_client.stop_session(session)   # close stdin; terminate process if it does not exit
  run_hook_best_effort("after_run", workspace.path)

  exit_normal()
```

### 16.6 Worker Exit and Retry Handling

```text
on_worker_exit(issue_id, reason, state):
  running_entry = state.running.remove(issue_id)
  state = add_runtime_seconds_to_totals(state, running_entry)

  if reason == normal:
    state.completed.add(issue_id)  # bookkeeping only
    state = schedule_retry(state, issue_id, 1, {
      identifier: running_entry.identifier,
      delay_type: continuation
    })
  else:
    state = schedule_retry(state, issue_id, next_attempt_from(running_entry), {
      identifier: running_entry.identifier,
      error: format("worker exited: %reason")
    })

  notify_observers()
  return state
```

```text
on_retry_timer(issue_id, state):
  retry_entry = state.retry_attempts.pop(issue_id)
  if missing:
    return state

  candidates = tracker.fetch_candidate_issues()
  if fetch failed:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: retry_entry.identifier,
      error: "retry poll failed"
    })

  issue = find_by_id(candidates, issue_id)
  if issue is null:
    state.claimed.remove(issue_id)
    return state

  if available_slots(state) == 0:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: issue.identifier,
      error: "no available orchestrator slots"
    })

  return dispatch_issue(issue, state, attempt=retry_entry.attempt)
```

## 17. Test and Validation Matrix

A conforming implementation SHOULD include tests that cover the behaviors defined in this
specification.

Validation profiles:

- `Core Conformance`: deterministic tests REQUIRED for all conforming implementations.
- `Extension Conformance`: REQUIRED only for OPTIONAL features that an implementation chooses to
  ship.
- `Real Integration Profile`: environment-dependent smoke/integration checks RECOMMENDED before
  production use.

Unless otherwise noted, Sections 17.1 through 17.7 are `Core Conformance`. Bullets that begin with
`If ... is implemented` are `Extension Conformance`.

### 17.1 Workflow and Config Parsing

- Workflow file path precedence:
  - explicit runtime path is used when provided
  - cwd default is `WORKFLOW.md` when no explicit runtime path is provided
- Workflow file changes are detected and trigger re-read/re-apply without restart
- Invalid workflow reload keeps last known good effective configuration and emits an
  operator-visible error
- Missing `WORKFLOW.md` returns typed error
- Invalid YAML front matter returns typed error
- Front matter non-map returns typed error
- Config defaults apply when OPTIONAL values are missing
- `tracker.kind` validation enforces currently supported kind (`linear`)
- `tracker.api_key` works (including `$VAR` indirection)
- `$VAR` resolution works for tracker API key and path values
- `~` path expansion works
- `claude.command` is preserved as a shell command string
- Flags derived from `claude.*` config (permission mode, tool rules, MCP config, model, max
  agentic turns) are appended to the launch command correctly
- Per-state concurrency override map normalizes state names and ignores invalid values
- Prompt template renders `issue` and `attempt`
- Prompt rendering fails on unknown variables (strict mode)

### 17.2 Workspace Manager and Safety

- Deterministic workspace path per issue identifier
- Missing workspace directory is created
- Existing workspace directory is reused
- Existing non-directory path at workspace location is handled safely (replace or fail per
  implementation policy)
- OPTIONAL workspace population/synchronization errors are surfaced
- `after_create` hook runs only on new workspace creation
- `before_run` hook runs before each attempt and failure/timeouts abort the current attempt
- `after_run` hook runs after each attempt and failure/timeouts are logged and ignored
- `before_remove` hook runs on cleanup and failures/timeouts are ignored
- Workspace path sanitization and root containment invariants are enforced before agent launch
- Agent launch uses the per-issue workspace path as cwd and rejects out-of-root paths

### 17.3 Issue Tracker Client

- Candidate issue fetch uses active states and project slug
- Linear query uses the specified project filter field (`slugId`)
- Empty `fetch_issues_by_states([])` returns empty without API call
- Pagination preserves order across multiple pages
- Blockers are normalized from inverse relations of type `blocks`
- Labels are normalized to lowercase
- Issue state refresh by ID returns minimal normalized issues
- Issue state refresh query uses GraphQL ID typing (`[ID!]`) as specified in Section 11.2
- Error mapping for request errors, non-200, GraphQL errors, malformed payloads

### 17.4 Orchestrator Dispatch, Reconciliation, and Retry

- Dispatch sort order is priority then oldest creation time
- `Todo` issue with non-terminal blockers is not eligible
- `Todo` issue with terminal blockers is eligible
- Active-state issue refresh updates running entry state
- Non-active state stops running agent without workspace cleanup
- Terminal state stops running agent and cleans workspace
- Reconciliation with no running issues is a no-op
- Normal worker exit schedules a short continuation retry (attempt 1)
- Abnormal worker exit increments retries with 10s-based exponential backoff
- Retry backoff cap uses configured `agent.max_retry_backoff_ms`
- Retry queue entries include attempt, due time, identifier, and error
- Stall detection kills stalled sessions and schedules retry
- Slot exhaustion requeues retries with explicit error reason
- If a snapshot API is implemented, it returns running rows, retry rows, token totals, and the
  API-health/`rate_limits: null` fields
- If a snapshot API is implemented, timeout/unavailable cases are surfaced

### 17.5 Claude Code Headless Client

- Launch command uses workspace cwd and invokes `bash -lc <claude.command + derived flags>`
- Session startup waits for `system`/`init` and extracts `session_id`
- `read_timeout_ms` is enforced while waiting for `system`/`init` and synchronous reads
- First turn sends the rendered issue prompt as a stream-json user message on stdin
- Continuation turns send continuation guidance on the same live process without resending the
  original prompt
- Turn completion is detected on the `result` message; error `result`/`is_error` maps to
  `turn_failed`
- Turn timeout is enforced (`turn_timeout_ms`)
- Subprocess exit before `result` maps to `process_exit` failure
- stdout JSON-line parsing tolerates malformed lines and surfaces them as `malformed` events
- Diagnostic stderr handling is kept separate from the protocol stream
- Configured permission mode and tool allow/deny rules appear in the launched command per the
  implementation's documented policy
- Permission prompts are resolved per documented policy and do not stall the session
- Per-step usage is extracted from `assistant` `message.usage` with deduplication by `message.id`
- Cumulative usage and `total_cost_usd` are extracted from `result` messages
- `system`/`api_retry` events update the OPTIONAL API-health snapshot
- If MCP client-side tools are implemented, the MCP config is passed at launch and the tools are
  callable as `mcp__<server>__<tool>`
- If session resume is implemented, `--resume <claude_session_id>` restores conversation context
  in the same workspace
- If the `linear_graphql` client-side tool extension is implemented:
  - the tool is exposed via MCP and permitted by the configured tool rules
  - valid `query` / `variables` inputs execute against configured Linear auth
  - top-level GraphQL `errors` produce `success=false` while preserving the GraphQL body
  - invalid arguments, missing auth, and transport failures return structured failure payloads
  - unsupported tool names still fail without stalling the session

### 17.6 Observability

- Validation failures are operator-visible
- Structured logging includes issue/session context fields
- Logging sink failures do not crash orchestration
- Token/cost aggregation remains correct across repeated agent updates and continuation turns
  (no double-counting of per-step usage when `result` totals are applied)
- If a human-readable status surface is implemented, it is driven from orchestrator state and does
  not affect correctness
- If humanized event summaries are implemented, they cover key message classes without changing
  orchestrator behavior

### 17.7 CLI and Host Lifecycle

- CLI accepts a positional workflow path argument (`path-to-WORKFLOW.md`)
- CLI uses `./WORKFLOW.md` when no workflow path argument is provided
- CLI errors on nonexistent explicit workflow path or missing default `./WORKFLOW.md`
- CLI surfaces startup failure cleanly
- CLI exits with success when application starts and shuts down normally
- CLI exits nonzero when startup fails or the host process exits abnormally

### 17.8 Real Integration Profile (RECOMMENDED)

These checks are RECOMMENDED for production readiness and MAY be skipped in CI when credentials,
network access, or external service permissions are unavailable.

- A real tracker smoke test can be run with valid credentials supplied by `LINEAR_API_KEY` or a
  documented local bootstrap mechanism (for example `~/.linear_api_key`).
- A real Claude smoke test can be run on a host with the `claude` CLI installed and authenticated
  (`ANTHROPIC_API_KEY` or `claude` login): launch one headless session in a temp workspace, send
  one trivial prompt, and assert a successful `result` with usage fields.
- Real integration tests SHOULD use isolated test identifiers/workspaces and clean up tracker
  artifacts when practical.
- A skipped real-integration test SHOULD be reported as skipped, not silently treated as passed.
- If a real-integration profile is explicitly enabled in CI or release validation, failures SHOULD
  fail that job.

## 18. Implementation Checklist (Definition of Done)

Use the same validation profiles as Section 17:

- Section 18.1 = `Core Conformance`
- Section 18.2 = `Extension Conformance`
- Section 18.3 = `Real Integration Profile`

### 18.1 REQUIRED for Conformance

- Workflow path selection supports explicit runtime path and cwd default
- `WORKFLOW.md` loader with YAML front matter + prompt body split
- Typed config layer with defaults and `$` resolution
- Dynamic `WORKFLOW.md` watch/reload/re-apply for config and prompt
- Polling orchestrator with single-authority mutable state
- Issue tracker client with candidate fetch + state refresh + terminal fetch
- Workspace manager with sanitized per-issue workspaces
- Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
- Hook timeout config (`hooks.timeout_ms`, default `60000`)
- Claude Code headless subprocess client with JSON line (`stream-json`) protocol — directly
  spawned or via the Claude Agent SDK
- Claude launch command config (`claude.command`, default
  `claude -p --input-format stream-json --output-format stream-json --verbose`) plus
  config-derived flags
- Strict prompt rendering with `issue` and `attempt` variables
- Exponential retry queue with continuation retries after normal exit
- Configurable retry backoff cap (`agent.max_retry_backoff_ms`, default 5m)
- Reconciliation that stops runs on terminal/non-active tracker states
- Workspace cleanup for terminal issues (startup sweep + active transition)
- Structured logs with `issue_id`, `issue_identifier`, and `session_id`
- Operator-visible observability (structured logs; OPTIONAL snapshot/status surface)

### 18.2 RECOMMENDED Extensions (Not REQUIRED for Conformance)

- HTTP server extension honors CLI `--port` over `server.port`, uses a safe default bind host, and
  exposes the baseline endpoints/error semantics in Section 13.7 if shipped.
- `linear_graphql` client-side tool extension exposes raw Linear GraphQL access through an
  orchestrator-owned MCP server using configured Symphony auth.
- Session resume extension persists `claude_session_id` per issue and passes `--resume` on
  re-dispatch after worker or service restarts.
- TODO: Persist retry queue and session metadata across process restarts.
- TODO: Make observability settings configurable in workflow front matter without prescribing UI
  implementation details.
- TODO: Add first-class tracker write APIs (comments/state transitions) in the orchestrator instead
  of only via agent tools.
- TODO: Add pluggable issue tracker adapters beyond Linear.

### 18.3 Operational Validation Before Production (RECOMMENDED)

- Run the `Real Integration Profile` from Section 17.8 with valid credentials and network access.
- Verify hook execution and workflow path resolution on the target host OS/shell environment.
- Verify the `claude` CLI version on the target host supports the headless flags this
  implementation appends (`--input-format stream-json`, `--permission-mode`, `--mcp-config`,
  `--resume`), and pin/document the supported version range.
- If the OPTIONAL HTTP server is shipped, verify the configured port behavior and loopback/default
  bind expectations on the target environment.

## Appendix A. SSH Worker Extension (OPTIONAL)

This appendix describes a common extension profile in which Symphony keeps one central
orchestrator but executes worker runs on one or more remote hosts over SSH.

Extension config:

- `worker.ssh_hosts` (list of SSH host strings, OPTIONAL)
  - When omitted, work runs locally.
- `worker.max_concurrent_agents_per_host` (positive integer, OPTIONAL)
  - Shared per-host cap applied across configured SSH hosts.

### A.1 Execution Model

- The orchestrator remains the single source of truth for polling, claims, retries, and
  reconciliation.
- `worker.ssh_hosts` provides the candidate SSH destinations for remote execution.
- Each worker run is assigned to one host at a time, and that host becomes part of the run's
  effective execution identity along with the issue workspace.
- `workspace.root` is interpreted on the remote host, not on the orchestrator host.
- The Claude Code headless process is launched over SSH stdio instead of as a local subprocess
  (for example `ssh <host> 'cd <workspace> && bash -lc "<claude command + flags>"'`), so the
  orchestrator still owns the session lifecycle even though commands execute remotely. The
  stream-json protocol passes through SSH stdio unchanged.
- Continuation turns inside one worker lifetime SHOULD stay on the same host and workspace.
- A remote host SHOULD satisfy the same basic contract as a local worker environment: reachable
  shell, writable workspace root, an installed and authenticated `claude` executable, and any
  required auth or repository prerequisites.

### A.2 Scheduling Notes

- SSH hosts MAY be treated as a pool for dispatch.
- Implementations MAY prefer the previously used host on retries when that host is still
  available.
- `worker.max_concurrent_agents_per_host` is an OPTIONAL shared per-host cap across configured SSH
  hosts.
- When all SSH hosts are at capacity, dispatch SHOULD wait rather than silently falling back to a
  different execution mode.
- Implementations MAY fail over to another host when the original host is unavailable before work
  has meaningfully started.
- Once a run has already produced side effects, a transparent rerun on another host SHOULD be
  treated as a new attempt, not as invisible failover.

### A.3 Problems to Consider

- Remote environment drift:
  - Each host needs the expected shell environment, `claude` executable and authentication, and
    repository prerequisites.
- Workspace locality:
  - Workspaces are usually host-local, so moving an issue to a different host is typically a cold
    restart unless shared storage exists. (Session resume via `--resume` is also host-local,
    since Claude Code session state lives on the host that ran the session.)
- Path and command safety:
  - Remote path resolution, shell quoting, and workspace-boundary checks matter more once execution
    crosses a machine boundary.
- Startup and failover semantics:
  - Implementations SHOULD distinguish host-connectivity/startup failures from in-workspace agent
    failures so the same ticket is not accidentally re-executed on multiple hosts.
- Host health and saturation:
  - A dead or overloaded host SHOULD reduce available capacity, not cause duplicate execution or an
    accidental fallback to local work.
- Cleanup and observability:
  - Operators need to know which host owns a run, where its workspace lives, and whether cleanup
    happened on the right machine.

## Appendix B. Codex → Claude Mapping Reference (Informative)

This appendix is informative only. It summarizes how the original Codex-targeted spec maps onto
this edition, for readers cross-referencing https://github.com/openai/symphony.

| Original (Codex) | This edition (Claude) |
|---|---|
| `codex` front-matter key | `claude` front-matter key |
| `codex.command` = `codex app-server` | `claude.command` = `claude -p --input-format stream-json --output-format stream-json --verbose` |
| `approval_policy` (`AskForApproval`) | `claude.permission_mode` (`--permission-mode`) |
| `thread_sandbox` / `turn_sandbox_policy` | `claude.allowed_tools` / `claude.disallowed_tools` / `settings.json` permission rules (no per-thread vs per-turn split) |
| `codex app-server generate-json-schema` | Claude Code headless + CLI reference docs |
| `thread_id` + `turn_id` | `session_id` + worker-maintained `turn_number` |
| `session_id = <thread_id>-<turn_id>` | `session_id = <claude_session_id>-<turn_number>` |
| Continuation turn on live thread | stream-json user message on live process stdin; `--resume` across processes |
| Client tool advertisement at session start | MCP (`--mcp-config` / SDK `mcp_servers`), tools named `mcp__<server>__<tool>` |
| `turn_input_required` event | Removed; permission prompts resolved by mode / prompt tool / SDK callback |
| `approval_auto_approved` event | Implied by `bypassPermissions`/`acceptEdits`; explicit only with a permission prompt tool |
| `thread/tokenUsage/updated`, `total_token_usage` | `result.usage` (cumulative) + `result.total_cost_usd` |
| `last_token_usage` (delta payloads) | per-`assistant` `message.usage` (dedupe by `message.id`; display only) |
| `codex_rate_limits` / snapshot `rate_limits` | `claude_rate_limits` from `rate_limit_event` (CLI ≥ 2.1.x); `null` on older CLIs; OPTIONAL `api_health` from `system`/`api_retry` |
| `codex_*` session/state fields | `claude_*` fields (Sections 4.1.6, 4.1.8, 16) |
| `codex_not_found`, `port_exit` errors | `claude_not_found`, `process_exit` |
