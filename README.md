# fable-symphony

A TypeScript implementation of the **Symphony** service specification — Claude edition
([spec-claude.md](./spec-claude.md)). Symphony is a long-running daemon that polls a Linear
project for active issues, creates an isolated workspace per issue, and runs a
**Claude Code** agent session (headless `stream-json` mode) inside that workspace until the
issue leaves its active state.

Ported from the original Codex-targeted spec ([spec.md](./spec.md)); the upstream reference
implementation (Elixir, Codex app-server) lives at <https://github.com/openai/symphony>.
Section numbers below refer to `spec-claude.md`.

## Requirements

- Node.js >= 22
- The `claude` CLI installed and authenticated on the host that runs workers
  (`ANTHROPIC_API_KEY` or `claude` login)
- A Linear API key (`LINEAR_API_KEY` by convention)

## Quick start

```sh
npm install
npm run build

cp WORKFLOW.example.md WORKFLOW.md   # edit tracker.project_slug etc.
export LINEAR_API_KEY=lin_api_...

node dist/cli.js ./WORKFLOW.md --port 8787
# or during development: npm start -- ./WORKFLOW.md --port 8787
```

- `symphony [path-to-WORKFLOW.md]` — defaults to `./WORKFLOW.md` (§17.7)
- `--port N` — enable the OPTIONAL observability HTTP server (overrides `server.port`, §13.7)
- `--log-file PATH`, `--log-level debug|info|warn|error`
- `symphony mcp-linear [path-to-WORKFLOW.md]` — stdio MCP server exposing the
  `linear_graphql` client-side tool (§10.5)

Dashboard at `http://127.0.0.1:8787/`, JSON API under `/api/v1/state`,
`/api/v1/<issue-identifier>`, and `POST /api/v1/refresh`.

## How it works

```
WORKFLOW.md ──▶ WorkflowStore (watch + reload, last-known-good)        §5, §6
                    │
                    ▼
              Orchestrator ── poll tick ──▶ LinearClient (GraphQL)     §7, §8, §11
                    │   reconcile / dispatch / retry / stall-detect
                    ▼
              AgentRunner (per issue)                                  §10.7, §16.5
                    │  workspace + hooks                               §9
                    ▼
              ClaudeSession: bash -lc "claude -p --input-format stream-json
                             --output-format stream-json --verbose ..."
                    │  cwd = <workspace.root>/<sanitized issue id>
                    └─ turn loop: task prompt → result → re-check issue →
                       continuation guidance → ... (agent.max_turns cap)
```

- **Workflow contract** — YAML front matter + Liquid prompt body, strict variables/filters
  (§5.4). Edits to `WORKFLOW.md` are detected and re-applied without restart; invalid edits
  keep the last known good config (§6.2).
- **Claude integration** — Route A of §10: a `claude` subprocess per worker, kept alive
  across continuation turns via streaming stdin. Flags (`--permission-mode`,
  `--allowedTools`, `--disallowedTools`, `--mcp-config`, `--model`, `--max-turns`,
  `--resume`) are derived from the `claude:` config block at launch (§5.3.6).
- **Token/cost accounting** — cumulative `result.usage` with delta tracking (no
  double-counting across turns); per-step assistant usage deduplicated by `message.id`;
  `total_cost_usd` is a client-side estimate (§13.5). Rate limits come from the CLI's
  `rate_limit_event` messages (Claude Code ≥ 2.1.x; `null` on older versions), plus an
  optional `api_health` signal from `system/api_retry` events.
- **Recovery** — failure-driven retries back off `10s · 2^(attempt-1)` up to
  `agent.max_retry_backoff_ms`; clean exits schedule a ~1s continuation re-check; tracker
  reconciliation stops workers whose issues went terminal (workspace cleaned) or non-active
  (workspace kept) (§8.4, §8.5, §14).

## Trust and safety posture (§1, §15)

This implementation is **high-trust by default and configuration-driven**:

- The example workflow uses `permission_mode: bypassPermissions` — appropriate only for
  trusted environments where tracker content and repository contents are trusted. For
  stricter postures, set `acceptEdits` or `default` plus `allowed_tools` /
  `disallowed_tools` rules, or route prompts through `permission_prompt_tool` (§10.5).
- Workers run only inside `<workspace.root>/<sanitized-issue-identifier>`; identifiers are
  sanitized to `[A-Za-z0-9._-]` and containment under the workspace root is enforced before
  every launch and cleanup (§9.5).
- Permission prompts never stall a run: in the high-trust posture residual prompts fail the
  turn and the orchestrator retries (§10.5).
- The Linear token stays inside the orchestrator and the `symphony mcp-linear` process; the
  agent never reads raw tokens from disk (§15.3).
- Hooks are trusted configuration executed with the workspace as cwd, bounded by
  `hooks.timeout_ms` (§15.4).

## Status vs. the spec

| Area | Status |
|---|---|
| §18.1 Core conformance | Implemented (loader, config, reload, orchestrator, tracker client, workspaces, hooks, headless client, strict prompts, retries, reconciliation, cleanup, structured logs) |
| §13.7 HTTP server extension | Implemented (dashboard + `/api/v1/*`, loopback bind, CLI `--port` precedence) |
| §10.5 `linear_graphql` MCP extension | Implemented (`symphony mcp-linear`, hand-rolled MCP stdio server) |
| §18.2 session resume on re-dispatch | Plumbed (`buildClaudeCommand` supports `--resume`) but not yet persisted per issue |
| Appendix A SSH workers | Not implemented |

## Development

```sh
npm test            # vitest — §17 core conformance matrix (85 tests)
npm run typecheck
```

Tests exercise the headless protocol against [`test/fake-claude.cjs`](./test/fake-claude.cjs),
a stand-in subprocess with switchable failure modes (error results, hangs, missing init,
mid-turn death, malformed lines, api_retry telemetry). The §17.8 real-integration profile
(real `claude` CLI + real Linear credentials) is intentionally not run in CI.
