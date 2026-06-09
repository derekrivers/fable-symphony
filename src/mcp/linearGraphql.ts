/**
 * linear_graphql client-side tool extension, served over MCP stdio
 * (spec-claude.md §10.5).
 *
 * Run as `symphony mcp-linear <path-to-WORKFLOW.md>` and reference it from
 * claude.mcp_config so the agent sees `mcp__linear__linear_graphql`. The
 * Linear token stays inside this orchestrator-owned process — the agent never
 * reads raw tokens from disk (§15.3).
 *
 * Hand-rolled JSON-RPC 2.0 over stdio (newline-delimited), implementing the
 * minimal MCP surface: initialize, notifications/initialized, tools/list,
 * tools/call.
 */
import { createInterface } from "node:readline";
import { WorkflowStore } from "../workflowStore.js";

const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOL_DEF = {
  name: "linear_graphql",
  description:
    "Execute exactly one raw GraphQL query or mutation against the Linear API using Symphony's configured tracker auth. " +
    "Input: { query: string (single GraphQL operation), variables?: object }. " +
    "Returns the GraphQL response body; top-level GraphQL errors are reported as a tool failure with the body preserved.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A single GraphQL query or mutation document" },
      variables: { type: "object", description: "Optional GraphQL variables object" },
    },
    required: ["query"],
  },
} as const;

/** Count executable operations; reject multi-operation documents (§10.5). */
export function countOperations(query: string): number {
  const stripped = query
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // string literals
    .replace(/#[^\n]*/g, ""); // comments
  const explicit = stripped.match(/\b(query|mutation|subscription)\b[^{]*\{/g)?.length ?? 0;
  if (explicit > 0) {
    // fragments don't count as operations
    return explicit;
  }
  // Anonymous shorthand `{ ... }` document counts as one operation if it
  // starts with a brace at top level.
  return stripped.trim().startsWith("{") ? 1 : 0;
}

interface ToolPayload {
  success: boolean;
  [key: string]: unknown;
}

export async function executeLinearGraphql(
  store: WorkflowStore,
  args: Record<string, unknown> | string,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolPayload> {
  // Shorthand: a raw GraphQL string is accepted as input (§10.5).
  const input = typeof args === "string" ? { query: args } : args;
  const query = input["query"];
  const variables = input["variables"];

  if (typeof query !== "string" || query.trim() === "") {
    return { success: false, error: { code: "invalid_input", message: "query must be a non-empty string" } };
  }
  if (variables !== undefined && (typeof variables !== "object" || variables === null || Array.isArray(variables))) {
    return { success: false, error: { code: "invalid_input", message: "variables must be a JSON object" } };
  }
  if (countOperations(query) > 1) {
    return {
      success: false,
      error: { code: "invalid_input", message: "query must contain exactly one GraphQL operation" },
    };
  }

  let settings;
  try {
    settings = store.settings();
  } catch (err) {
    return { success: false, error: { code: "missing_auth", message: `workflow unavailable: ${String(err)}` } };
  }
  if (settings.tracker.kind?.toLowerCase() !== "linear" || !settings.tracker.api_key) {
    return {
      success: false,
      error: { code: "missing_auth", message: "linear tracker auth is not configured in WORKFLOW.md" },
    };
  }

  let res: Response;
  try {
    res = await fetchImpl(settings.tracker.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: settings.tracker.api_key },
      body: JSON.stringify({ query, variables: variables ?? undefined }),
    });
  } catch (err) {
    return { success: false, error: { code: "transport_failure", message: String(err) } };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      success: false,
      error: { code: "transport_failure", message: `non-JSON response (HTTP ${res.status})` },
    };
  }

  if (res.status !== 200) {
    return { success: false, error: { code: "http_status", message: `HTTP ${res.status}` }, response: body };
  }
  const errors = (body as { errors?: unknown[] }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    // Preserve the GraphQL body for debugging (§10.5).
    return { success: false, error: { code: "graphql_errors", message: "GraphQL errors present" }, response: body };
  }
  return { success: true, response: body };
}

export function runMcpServer(workflowPath: string): void {
  const store = new WorkflowStore(workflowPath);
  try {
    store.load();
  } catch {
    // tool calls will report missing_auth; keep serving so the session never stalls
  }
  store.watch();

  const write = (msg: Record<string, unknown>) => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  };

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      write({ id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    void handle(req);
  });
  rl.on("close", () => process.exit(0));

  async function handle(req: JsonRpcRequest): Promise<void> {
    switch (req.method) {
      case "initialize":
        write({
          id: req.id ?? null,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "symphony-linear", version: "0.1.0" },
          },
        });
        return;
      case "notifications/initialized":
        return; // notification: no response
      case "tools/list":
        write({ id: req.id ?? null, result: { tools: [TOOL_DEF] } });
        return;
      case "tools/call": {
        const params = req.params ?? {};
        const name = params["name"];
        const args = (params["arguments"] ?? {}) as Record<string, unknown>;
        if (name !== TOOL_DEF.name) {
          // Unsupported tool names fail without stalling the session (§10.5).
          write({
            id: req.id ?? null,
            result: {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: { code: "unsupported_tool", message: `unsupported tool ${String(name)}` } }) }],
              isError: true,
            },
          });
          return;
        }
        store.reload();
        const payload = await executeLinearGraphql(store, args);
        write({
          id: req.id ?? null,
          result: {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            isError: !payload.success,
          },
        });
        return;
      }
      case "ping":
        write({ id: req.id ?? null, result: {} });
        return;
      default:
        if (req.id !== undefined) {
          write({ id: req.id ?? null, error: { code: -32601, message: `method not found: ${req.method}` } });
        }
    }
  }
}
