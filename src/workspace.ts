/**
 * Workspace manager (spec-claude.md §9).
 *
 * Deterministic per-issue workspaces under workspace.root, lifecycle hooks
 * with timeouts, and the three safety invariants (§9.5): agent cwd is the
 * workspace path, the workspace stays inside the root, and directory names
 * are sanitized.
 */
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SymphonyError, type Settings } from "./types.js";
import { logger } from "./logger.js";

export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

/** Invariant 3: only [A-Za-z0-9._-]; everything else becomes `_`. */
export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function workspacePathFor(root: string, identifier: string): string {
  return path.join(root, sanitizeWorkspaceKey(identifier));
}

/** Invariant 2: workspace path must remain under the configured root. */
export function assertInsideRoot(root: string, workspacePath: string): void {
  const normRoot = path.resolve(root);
  const normWs = path.resolve(workspacePath);
  const rel = path.relative(normRoot, normWs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SymphonyError(
      "invalid_workspace_cwd",
      `workspace path ${normWs} escapes workspace root ${normRoot}`,
    );
  }
}

export interface HookResult {
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  output: string;
}

const HOOK_LOG_TRUNCATE = 2000;

export async function runHookScript(
  script: string,
  cwd: string,
  timeoutMs: number,
  hookName: string,
): Promise<HookResult> {
  logger.info("hook start", { hook: hookName, cwd });
  return new Promise<HookResult>((resolve) => {
    const child = spawn("bash", ["-lc", script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const capture = (chunk: Buffer) => {
      if (output.length < HOOK_LOG_TRUNCATE * 2) output += chunk.toString();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, timedOut: false, exitCode: null, output: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = !timedOut && code === 0;
      if (!ok) {
        logger.warn("hook failed", {
          hook: hookName,
          exit_code: code,
          timed_out: timedOut,
          output: output.slice(0, HOOK_LOG_TRUNCATE),
        });
      }
      resolve({ ok, timedOut, exitCode: code, output: output.slice(0, HOOK_LOG_TRUNCATE) });
    });
  });
}

export class WorkspaceManager {
  constructor(private readonly settings: () => Settings) {}

  /** §9.2: ensure the per-issue directory, run after_create only on creation. */
  async createForIssue(identifier: string): Promise<Workspace> {
    const s = this.settings();
    const key = sanitizeWorkspaceKey(identifier);
    const wsPath = workspacePathFor(s.workspace.root, identifier);
    assertInsideRoot(s.workspace.root, wsPath);

    let createdNow = false;
    if (existsSync(wsPath)) {
      // Existing non-directory path is handled safely by failing (§17.2 allows replace-or-fail).
      if (!statSync(wsPath).isDirectory()) {
        throw new SymphonyError("invalid_workspace_cwd", `workspace path ${wsPath} exists and is not a directory`);
      }
    } else {
      mkdirSync(wsPath, { recursive: true });
      createdNow = true;
    }

    if (createdNow && s.hooks.after_create) {
      const result = await runHookScript(s.hooks.after_create, wsPath, s.hooks.timeout_ms, "after_create");
      if (!result.ok) {
        // after_create failure is fatal to workspace creation (§9.4); remove the
        // partially prepared brand-new directory (§9.3).
        try {
          rmSync(wsPath, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        throw new SymphonyError(
          "workspace_hook_failed",
          `after_create hook ${result.timedOut ? "timed out" : "failed"} for ${identifier}`,
        );
      }
    }

    return { path: wsPath, workspace_key: key, created_now: createdNow };
  }

  /** before_run: failure aborts the current attempt (§9.4). */
  async runBeforeRun(workspace: Workspace): Promise<void> {
    const s = this.settings();
    if (!s.hooks.before_run) return;
    const result = await runHookScript(s.hooks.before_run, workspace.path, s.hooks.timeout_ms, "before_run");
    if (!result.ok) {
      throw new SymphonyError(
        "workspace_hook_failed",
        `before_run hook ${result.timedOut ? "timed out" : "failed"}`,
      );
    }
  }

  /** after_run: failure is logged and ignored (§9.4). */
  async runAfterRun(workspacePath: string): Promise<void> {
    const s = this.settings();
    if (!s.hooks.after_run) return;
    if (!existsSync(workspacePath)) return;
    await runHookScript(s.hooks.after_run, workspacePath, s.hooks.timeout_ms, "after_run");
  }

  /** §9 cleanup: before_remove (failure ignored), then delete. */
  async cleanupForIssue(identifier: string): Promise<void> {
    const s = this.settings();
    const wsPath = workspacePathFor(s.workspace.root, identifier);
    assertInsideRoot(s.workspace.root, wsPath);
    if (!existsSync(wsPath)) return;
    if (s.hooks.before_remove) {
      await runHookScript(s.hooks.before_remove, wsPath, s.hooks.timeout_ms, "before_remove");
    }
    rmSync(wsPath, { recursive: true, force: true });
    logger.info("workspace removed", { issue_identifier: identifier, path: wsPath });
  }
}
