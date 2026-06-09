#!/usr/bin/env node
/**
 * CLI entry (spec-claude.md §17.7).
 *
 *   symphony [path-to-WORKFLOW.md] [--port N] [--log-file PATH] [--log-level LEVEL]
 *   symphony mcp-linear [path-to-WORKFLOW.md]
 *
 * Defaults to ./WORKFLOW.md. Exits nonzero on startup failure.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { ClaudeClient } from "./claudeClient.js";
import { startHttpServer } from "./httpServer.js";
import { LinearClient } from "./linear.js";
import { configureLogging, logger, type LogLevel } from "./logger.js";
import { runMcpServer } from "./mcp/linearGraphql.js";
import { Orchestrator } from "./orchestrator.js";
import { errorCode } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { WorkflowStore } from "./workflowStore.js";

interface CliArgs {
  command: "run" | "mcp-linear";
  workflowPath: string;
  port: number | null;
  logFile: string | null;
  logLevel: LogLevel;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: "run",
    workflowPath: "./WORKFLOW.md",
    port: null,
    logFile: null,
    logLevel: "info",
  };
  const rest = [...argv];
  if (rest[0] === "mcp-linear") {
    args.command = "mcp-linear";
    rest.shift();
  }
  const positional: string[] = [];
  while (rest.length > 0) {
    const arg = rest.shift()!;
    if (arg === "--port") {
      const v = rest.shift();
      if (v === undefined || !Number.isInteger(Number(v)) || Number(v) < 0) {
        throw new Error(`--port requires a non-negative integer, got ${v}`);
      }
      args.port = Number(v);
    } else if (arg === "--log-file") {
      const v = rest.shift();
      if (!v) throw new Error("--log-file requires a path");
      args.logFile = v;
    } else if (arg === "--log-level") {
      const v = rest.shift();
      if (v !== "debug" && v !== "info" && v !== "warn" && v !== "error") {
        throw new Error(`--log-level must be debug|info|warn|error, got ${v}`);
      }
      args.logLevel = v;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error(`too many positional arguments: ${positional.join(" ")}`);
  if (positional.length === 1) args.workflowPath = positional[0]!;
  return args;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`symphony: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const workflowPath = path.resolve(args.workflowPath);
  if (!existsSync(workflowPath)) {
    process.stderr.write(`symphony: workflow file not found: ${workflowPath}\n`);
    process.exit(1);
  }

  if (args.command === "mcp-linear") {
    runMcpServer(workflowPath);
    return; // serves until stdin closes
  }

  configureLogging({ file: args.logFile, level: args.logLevel });

  const store = new WorkflowStore(workflowPath);
  try {
    store.load();
  } catch (err) {
    logger.error("startup failed: workflow could not be loaded", { error: errorCode(err) });
    process.exit(1);
  }

  const tracker = new LinearClient(store.settings);
  const workspaceManager = new WorkspaceManager(store.settings);
  const claudeClient = new ClaudeClient(store.settings);
  const orchestrator = new Orchestrator({
    store,
    tracker,
    workspaceManager,
    runnerDeps: { claudeClient },
  });

  // HTTP extension: CLI --port overrides server.port (§13.7).
  const effectivePort = args.port ?? store.settings().server.port;

  try {
    await orchestrator.start();
  } catch (err) {
    logger.error("startup failed: dispatch preflight validation", { error: errorCode(err) });
    process.exit(1);
  }

  if (effectivePort !== null) {
    try {
      await startHttpServer(effectivePort, orchestrator, store);
    } catch (err) {
      logger.error("startup failed: http server", { error: errorCode(err) });
      await orchestrator.stop();
      process.exit(1);
    }
  }

  logger.info("symphony started", {
    workflow: workflowPath,
    workspace_root: store.settings().workspace.root,
    poll_interval_ms: store.settings().polling.interval_ms,
  });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    await orchestrator.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/cli.js") || process.argv[1].endsWith("/cli.ts") || process.argv[1].endsWith("symphony"));
if (isDirectRun) {
  void main();
}
