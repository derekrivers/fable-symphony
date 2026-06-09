import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSettings } from "../src/config.js";
import { WorkflowStore } from "../src/workflowStore.js";
import type { Issue, Settings } from "../src/types.js";

export function tempDir(prefix = "symphony-test-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "MT-1",
    title: "Test issue",
    description: "desc",
    priority: 2,
    state: "Todo",
    branch_name: null,
    url: "https://linear.app/x/issue/MT-1",
    labels: [],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

export function makeSettings(config: Record<string, unknown> = {}, workflowDir = os.tmpdir()): Settings {
  return resolveSettings(config, { workflowDir, env: process.env });
}

/** Write a WORKFLOW.md into a temp dir and return a loaded store. */
export function makeStore(frontMatter: string, body = "Work on {{ issue.identifier }}."): WorkflowStore {
  const dir = tempDir();
  const file = path.join(dir, "WORKFLOW.md");
  writeFileSync(file, `---\n${frontMatter}\n---\n\n${body}\n`);
  const store = new WorkflowStore(file);
  store.load();
  return store;
}

export const VALID_TRACKER_YAML = `
tracker:
  kind: linear
  api_key: test-key
  project_slug: proj-1
`.trim();
