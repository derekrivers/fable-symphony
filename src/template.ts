/**
 * Prompt construction (spec-claude.md §5.4, §12).
 *
 * Strict Liquid rendering: unknown variables and unknown filters fail the
 * render. Turn 1 gets the full rendered task prompt; continuation turns get
 * continuation guidance only (§7.1, §10.2), mirroring the reference
 * implementation's PromptBuilder.
 */
import { Liquid } from "liquidjs";
import { SymphonyError, type Issue } from "./types.js";

export const FALLBACK_PROMPT = "You are working on an issue from Linear.";

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

export function renderPrompt(template: string, issue: Issue, attempt: number | null): string {
  const effective = template.trim() === "" ? FALLBACK_PROMPT : template;

  let parsed;
  try {
    parsed = engine.parse(effective);
  } catch (err) {
    throw new SymphonyError("template_parse_error", `template parse failed: ${(err as Error).message}`, err);
  }

  try {
    return engine.renderSync(parsed, {
      issue: issueToScope(issue),
      attempt,
    }) as string;
  } catch (err) {
    throw new SymphonyError("template_render_error", `template render failed: ${(err as Error).message}`, err);
  }
}

/** Plain-JSON view of the issue so templates can iterate labels/blockers (§12.2). */
function issueToScope(issue: Issue): Record<string, unknown> {
  return JSON.parse(JSON.stringify(issue)) as Record<string, unknown>;
}

/**
 * Turn prompt for the worker loop (§16.5): full task prompt on turn 1,
 * continuation guidance afterwards.
 */
export function buildTurnPrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
  turnNumber: number,
  maxTurns: number,
): string {
  if (turnNumber <= 1) return renderPrompt(template, issue, attempt);
  return [
    "Continuation guidance:",
    "",
    "- The previous turn completed normally, but the Linear issue is still in an active state.",
    `- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.`,
    "- Resume from the current workspace state instead of restarting from scratch.",
    "- The original task instructions and prior turn context are already present in this session, so do not restate them before acting.",
    "- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.",
  ].join("\n");
}
