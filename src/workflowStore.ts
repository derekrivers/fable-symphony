/**
 * Workflow store: load + dynamic reload (spec-claude.md §6.2).
 *
 * Watches WORKFLOW.md (stat polling — reliable on WSL/NFS where inotify is
 * not) and re-applies config and prompt on change. Invalid reloads keep the
 * last known good configuration and surface an operator-visible error. The
 * orchestrator also calls reload() defensively before each dispatch cycle.
 */
import { unwatchFile, watchFile } from "node:fs";
import path from "node:path";
import { resolveSettings } from "./config.js";
import { loadWorkflow } from "./workflow.js";
import { logger } from "./logger.js";
import { SymphonyError, type Settings, type WorkflowDefinition } from "./types.js";

export interface EffectiveConfig {
  workflow: WorkflowDefinition;
  settings: Settings;
}

export class WorkflowStore {
  private good: EffectiveConfig | null = null;
  lastError: SymphonyError | null = null;
  private watching = false;

  constructor(
    readonly workflowPath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Initial load: throws so startup can fail loudly (§6.3). */
  load(): EffectiveConfig {
    const workflow = loadWorkflow(this.workflowPath);
    const settings = resolveSettings(workflow.config, {
      workflowDir: path.dirname(path.resolve(this.workflowPath)),
      env: this.env,
    });
    this.good = { workflow, settings };
    this.lastError = null;
    return this.good;
  }

  /** Re-read and re-apply; invalid reloads keep last known good (§6.2). */
  reload(): void {
    try {
      this.load();
    } catch (err) {
      const e =
        err instanceof SymphonyError ? err : new SymphonyError("workflow_parse_error", String(err), err);
      // Only log on transition to (or change of) error so ticks stay quiet.
      if (this.lastError?.message !== e.message) {
        logger.error("workflow reload failed; keeping last known good config", {
          code: e.code,
          error: e.message,
        });
      }
      this.lastError = e;
    }
  }

  current(): EffectiveConfig {
    if (!this.good) throw new SymphonyError("missing_workflow_file", "workflow not loaded");
    return this.good;
  }

  settings = (): Settings => this.current().settings;
  workflow = (): WorkflowDefinition => this.current().workflow;

  watch(intervalMs = 1000): void {
    if (this.watching) return;
    this.watching = true;
    watchFile(this.workflowPath, { interval: intervalMs }, () => {
      logger.info("workflow file change detected; reloading", { path: this.workflowPath });
      this.reload();
    });
  }

  unwatch(): void {
    if (!this.watching) return;
    this.watching = false;
    unwatchFile(this.workflowPath);
  }
}
