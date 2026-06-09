/** §17.1 prompt template strictness; §12 rendering rules */
import { describe, expect, it } from "vitest";
import { buildTurnPrompt, FALLBACK_PROMPT, renderPrompt } from "../src/template.js";
import { makeIssue } from "./helpers.js";

describe("prompt rendering", () => {
  it("renders issue and attempt, including nested labels/blockers", () => {
    const issue = makeIssue({
      labels: ["bug", "agent"],
      blocked_by: [{ id: "b1", identifier: "MT-9", state: "Done" }],
    });
    const out = renderPrompt(
      "Issue {{ issue.identifier }} ({{ issue.title }}) attempt={{ attempt }} labels:{% for l in issue.labels %} {{ l }}{% endfor %} blocker={{ issue.blocked_by[0].identifier }}",
      issue,
      3,
    );
    expect(out).toBe("Issue MT-1 (Test issue) attempt=3 labels: bug agent blocker=MT-9");
  });

  it("fails on unknown variables (strict mode)", () => {
    expect(() => renderPrompt("{{ nope }}", makeIssue(), null)).toThrowError(
      expect.objectContaining({ code: "template_render_error" }),
    );
  });

  it("fails on unknown filters (strict mode)", () => {
    // liquidjs flags unknown filters at parse time; both parse and render
    // failures are typed errors that fail the run attempt (§5.5).
    expect(() => renderPrompt("{{ issue.title | bogusfilter }}", makeIssue(), null)).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/^template_(parse|render)_error$/) }),
    );
  });

  it("uses the minimal fallback prompt when the body is empty (§5.4)", () => {
    expect(renderPrompt("", makeIssue(), null)).toBe(FALLBACK_PROMPT);
  });

  it("turn 1 renders the task prompt; later turns send continuation guidance only", () => {
    const issue = makeIssue();
    const t1 = buildTurnPrompt("Task: {{ issue.identifier }}", issue, null, 1, 5);
    expect(t1).toBe("Task: MT-1");
    const t2 = buildTurnPrompt("Task: {{ issue.identifier }}", issue, null, 2, 5);
    expect(t2).toContain("Continuation guidance:");
    expect(t2).toContain("continuation turn #2 of 5");
    expect(t2).not.toContain("MT-1"); // does not resend the original prompt
  });
});
