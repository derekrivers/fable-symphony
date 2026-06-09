/**
 * OPTIONAL HTTP server extension (spec-claude.md §13.7).
 *
 * Observability/control surface only — never required for orchestrator
 * correctness. Binds loopback by default. Routes: GET / (dashboard),
 * GET /api/v1/state, GET /api/v1/<issue_identifier>, POST /api/v1/refresh.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Orchestrator } from "./orchestrator.js";
import { workspacePathFor } from "./workspace.js";
import type { WorkflowStore } from "./workflowStore.js";
import { logger } from "./logger.js";

export function startHttpServer(
  port: number,
  orchestrator: Orchestrator,
  store: WorkflowStore,
  host = "127.0.0.1",
): Promise<Server> {
  const server = createServer((req, res) => {
    try {
      route(req, res, orchestrator, store);
    } catch (err) {
      sendJson(res, 500, { error: { code: "internal_error", message: String(err) } });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
      logger.info("http server listening", { host, port: boundPort });
      resolve(server);
    });
  });
}

function route(req: IncomingMessage, res: ServerResponse, orchestrator: Orchestrator, store: WorkflowStore): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/") {
    if (req.method !== "GET") return methodNotAllowed(res);
    return sendHtml(res, renderDashboard(orchestrator));
  }

  if (path === "/api/v1/state") {
    if (req.method !== "GET") return methodNotAllowed(res);
    return sendJson(res, 200, orchestrator.snapshot());
  }

  if (path === "/api/v1/refresh") {
    if (req.method !== "POST") return methodNotAllowed(res);
    const result = orchestrator.requestRefresh();
    return sendJson(res, 202, {
      queued: result.queued,
      coalesced: result.coalesced,
      requested_at: new Date().toISOString(),
      operations: ["poll", "reconcile"],
    });
  }

  const issueMatch = /^\/api\/v1\/([^/]+)$/.exec(path);
  if (issueMatch) {
    if (req.method !== "GET") return methodNotAllowed(res);
    return issueDetail(res, decodeURIComponent(issueMatch[1]!), orchestrator, store);
  }

  sendJson(res, 404, { error: { code: "not_found", message: `no route for ${path}` } });
}

function issueDetail(res: ServerResponse, identifier: string, orchestrator: Orchestrator, store: WorkflowStore): void {
  const snap = orchestrator.snapshot();
  const running = snap.running.find((r) => r.issue_identifier === identifier) ?? null;
  const retry = snap.retrying.find((r) => r.issue_identifier === identifier) ?? null;
  if (!running && !retry) {
    return sendJson(res, 404, {
      error: { code: "issue_not_found", message: `issue ${identifier} is not known to in-memory state` },
    });
  }
  let workspacePath: string | null = null;
  try {
    workspacePath = workspacePathFor(store.settings().workspace.root, identifier);
  } catch {
    /* settings unavailable */
  }
  sendJson(res, 200, {
    issue_identifier: identifier,
    issue_id: running?.issue_id ?? retry?.issue_id ?? null,
    status: running ? "running" : "retrying",
    workspace: { path: workspacePath },
    attempts: { current_retry_attempt: retry?.attempt ?? null },
    running,
    retry,
    logs: { claude_session_logs: [] },
    recent_events: [],
    last_error: retry?.error ?? null,
    tracked: {},
  });
}

function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { error: { code: "method_not_allowed", message: "method not allowed" } });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function esc(s: string | null): string {
  return (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function renderDashboard(orchestrator: Orchestrator): string {
  const s = orchestrator.snapshot();
  const runningRows = s.running
    .map(
      (r) =>
        `<tr><td>${esc(r.issue_identifier)}</td><td>${esc(r.state)}</td><td>${r.turn_count}</td><td>${esc(
          r.last_event,
        )}</td><td>${esc(r.last_message)}</td><td>${r.tokens.total_tokens}</td><td>${esc(r.started_at)}</td></tr>`,
    )
    .join("");
  const retryRows = s.retrying
    .map(
      (r) =>
        `<tr><td>${esc(r.issue_identifier)}</td><td>${r.attempt}</td><td>${esc(r.due_at)}</td><td>${esc(
          r.error,
        )}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Symphony</title>
<meta http-equiv="refresh" content="5">
<style>
body{font-family:ui-monospace,monospace;margin:2rem;background:#101418;color:#d8dee6}
h1{font-size:1.2rem} h2{font-size:1rem;margin-top:1.5rem}
table{border-collapse:collapse;width:100%} td,th{border:1px solid #2a323c;padding:4px 8px;text-align:left;font-size:0.85rem}
.err{color:#ff7b72}
</style></head><body>
<h1>Symphony — Claude edition</h1>
<p>generated_at ${esc(s.generated_at)} · running ${s.counts.running} · retrying ${s.counts.retrying}
· tokens ${s.claude_totals.total_tokens} · est. cost $${s.claude_totals.total_cost_usd.toFixed(4)}
· runtime ${Math.round(s.claude_totals.seconds_running)}s</p>
${s.validation_error ? `<p class="err">validation: ${esc(s.validation_error)}</p>` : ""}
<h2>Running</h2>
<table><tr><th>issue</th><th>state</th><th>turns</th><th>last event</th><th>last message</th><th>tokens</th><th>started</th></tr>${runningRows}</table>
<h2>Retrying</h2>
<table><tr><th>issue</th><th>attempt</th><th>due</th><th>error</th></tr>${retryRows}</table>
</body></html>`;
}
