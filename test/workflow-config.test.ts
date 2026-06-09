/** §17.1 Workflow and Config Parsing */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeCommand, DEFAULT_CLAUDE_COMMAND, resolveSettings, validateDispatchConfig } from "../src/config.js";
import { loadWorkflow, parseWorkflow } from "../src/workflow.js";
import { WorkflowStore } from "../src/workflowStore.js";
import { SymphonyError } from "../src/types.js";
import { makeSettings, tempDir } from "./helpers.js";

describe("workflow loader", () => {
  it("splits front matter and prompt body", () => {
    const wf = parseWorkflow(`---\ntracker:\n  kind: linear\n---\n\nDo the work for {{ issue.identifier }}.\n`);
    expect((wf.config["tracker"] as { kind: string }).kind).toBe("linear");
    expect(wf.prompt_template).toBe("Do the work for {{ issue.identifier }}.");
  });

  it("treats a file without front matter as pure prompt body", () => {
    const wf = parseWorkflow("Just a prompt.\nSecond line.");
    expect(wf.config).toEqual({});
    expect(wf.prompt_template).toBe("Just a prompt.\nSecond line.");
  });

  it("missing workflow file returns typed error", () => {
    expect(() => loadWorkflow("/nonexistent/WORKFLOW.md")).toThrowError(
      expect.objectContaining({ code: "missing_workflow_file" }),
    );
  });

  it("invalid YAML front matter returns typed error", () => {
    expect(() => parseWorkflow("---\n: : :\n  bad: [unclosed\n---\nbody")).toThrowError(
      expect.objectContaining({ code: "workflow_parse_error" }),
    );
  });

  it("non-map front matter returns typed error", () => {
    expect(() => parseWorkflow("---\n- a\n- b\n---\nbody")).toThrowError(
      expect.objectContaining({ code: "workflow_front_matter_not_a_map" }),
    );
  });

  it("unterminated front matter returns typed error", () => {
    expect(() => parseWorkflow("---\ntracker:\n  kind: linear\nbody")).toThrowError(
      expect.objectContaining({ code: "workflow_parse_error" }),
    );
  });
});

describe("config layer", () => {
  it("applies documented defaults (§6.4)", () => {
    const s = makeSettings({});
    expect(s.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(s.tracker.active_states).toEqual(["Todo", "In Progress"]);
    expect(s.tracker.terminal_states).toEqual(["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]);
    expect(s.polling.interval_ms).toBe(30000);
    expect(s.hooks.timeout_ms).toBe(60000);
    expect(s.agent.max_concurrent_agents).toBe(10);
    expect(s.agent.max_turns).toBe(20);
    expect(s.agent.max_retry_backoff_ms).toBe(300000);
    expect(s.claude.command).toBe(DEFAULT_CLAUDE_COMMAND);
    expect(s.claude.turn_timeout_ms).toBe(3600000);
    expect(s.claude.read_timeout_ms).toBe(5000);
    expect(s.claude.stall_timeout_ms).toBe(300000);
    expect(s.workspace.root).toBe(path.join(os.tmpdir(), "symphony_workspaces"));
  });

  it("resolves $VAR indirection for the tracker api key; empty env means missing", () => {
    process.env["SYMPHONY_TEST_KEY"] = "lin_api_123";
    const s = makeSettings({ tracker: { api_key: "$SYMPHONY_TEST_KEY" } });
    expect(s.tracker.api_key).toBe("lin_api_123");

    process.env["SYMPHONY_TEST_EMPTY"] = "";
    const s2 = makeSettings({ tracker: { api_key: "$SYMPHONY_TEST_EMPTY" } });
    expect(s2.tracker.api_key).toBeNull();
  });

  it("expands ~ and resolves relative workspace.root against the workflow dir", () => {
    const sHome = makeSettings({ workspace: { root: "~/symphony-ws" } });
    expect(sHome.workspace.root).toBe(path.join(os.homedir(), "symphony-ws"));

    const dir = tempDir();
    const sRel = makeSettings({ workspace: { root: "./ws" } }, dir);
    expect(sRel.workspace.root).toBe(path.join(dir, "ws"));
  });

  it("normalizes per-state concurrency keys and drops invalid values (§5.3.5)", () => {
    const s = makeSettings({
      agent: {
        max_concurrent_agents_by_state: {
          " In Progress ": 3,
          Todo: -1,
          Review: "two",
        },
      },
    });
    expect(s.agent.max_concurrent_agents_by_state).toEqual({ "in progress": 3 });
  });

  it("dispatch preflight validation enforces tracker kind/key/slug and claude.command (§6.3)", () => {
    expect(() => validateDispatchConfig(makeSettings({}))).toThrowError(
      expect.objectContaining({ code: "unsupported_tracker_kind" }),
    );
    expect(() =>
      validateDispatchConfig(makeSettings({ tracker: { kind: "jira", api_key: "k", project_slug: "p" } })),
    ).toThrowError(expect.objectContaining({ code: "unsupported_tracker_kind" }));
    expect(() =>
      validateDispatchConfig(makeSettings({ tracker: { kind: "linear", project_slug: "p" } })),
    ).toThrowError(expect.objectContaining({ code: "missing_tracker_api_key" }));
    expect(() =>
      validateDispatchConfig(makeSettings({ tracker: { kind: "linear", api_key: "k" } })),
    ).toThrowError(expect.objectContaining({ code: "missing_tracker_project_slug" }));
    expect(() =>
      validateDispatchConfig(makeSettings({ tracker: { kind: "linear", api_key: "k", project_slug: "p" } })),
    ).not.toThrow();
  });

  it("derives launch flags from typed claude config (§5.3.6, §10.1)", () => {
    const s = makeSettings({
      claude: {
        permission_mode: "bypassPermissions",
        allowed_tools: ["Bash(git *)", "mcp__linear__linear_graphql"],
        disallowed_tools: ["WebFetch"],
        mcp_config: "/etc/symphony/mcp.json",
        model: "opus",
        max_agentic_turns: 40,
      },
    });
    const cmd = buildClaudeCommand(s);
    expect(cmd).toContain(DEFAULT_CLAUDE_COMMAND);
    expect(cmd).toContain("--permission-mode bypassPermissions");
    expect(cmd).toContain("--allowedTools 'Bash(git *),mcp__linear__linear_graphql'");
    expect(cmd).toContain("--disallowedTools WebFetch");
    expect(cmd).toContain("--mcp-config /etc/symphony/mcp.json");
    expect(cmd).toContain("--model opus");
    expect(cmd).toContain("--max-turns 40");
    expect(buildClaudeCommand(s, { resumeSessionId: "sess-9" })).toContain("--resume sess-9");
  });

  it("invalid reload keeps last known good config and records the error (§6.2)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "symphony-store-"));
    const file = path.join(dir, "WORKFLOW.md");
    writeFileSync(file, "---\npolling:\n  interval_ms: 1234\n---\nprompt body");
    const store = new WorkflowStore(file);
    store.load();
    expect(store.settings().polling.interval_ms).toBe(1234);

    writeFileSync(file, "---\n- broken\n- list\n---\nprompt body");
    store.reload();
    expect(store.lastError).toBeInstanceOf(SymphonyError);
    expect(store.settings().polling.interval_ms).toBe(1234); // last known good

    writeFileSync(file, "---\npolling:\n  interval_ms: 4321\n---\nprompt body");
    store.reload();
    expect(store.lastError).toBeNull();
    expect(store.settings().polling.interval_ms).toBe(4321);
  });
});
