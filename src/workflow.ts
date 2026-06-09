/**
 * Workflow loader (spec-claude.md §5.1–§5.2, §5.5).
 *
 * Reads WORKFLOW.md, splits YAML front matter from the prompt body, and
 * returns { config, prompt_template }. All failures are typed errors so the
 * orchestrator can gate dispatch on them.
 */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { SymphonyError, type WorkflowDefinition } from "./types.js";

export function loadWorkflow(path: string): WorkflowDefinition {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new SymphonyError("missing_workflow_file", `cannot read workflow file at ${path}`, err);
  }
  return parseWorkflow(raw);
}

export function parseWorkflow(raw: string): WorkflowDefinition {
  // Front matter only when the file starts with a `---` line (spec §5.2).
  const lines = raw.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") {
    return { config: {}, prompt_template: raw.trim() };
  }

  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    throw new SymphonyError("workflow_parse_error", "unterminated YAML front matter (no closing ---)");
  }

  const frontMatter = lines.slice(1, closing).join("\n");
  const body = lines.slice(closing + 1).join("\n");

  let parsed: unknown;
  try {
    parsed = yaml.load(frontMatter) ?? {};
  } catch (err) {
    throw new SymphonyError("workflow_parse_error", `invalid YAML front matter: ${(err as Error).message}`, err);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SymphonyError(
      "workflow_front_matter_not_a_map",
      `front matter must decode to a map, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }

  return { config: parsed as Record<string, unknown>, prompt_template: body.trim() };
}
