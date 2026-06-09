/**
 * Structured logging (spec-claude.md §13.1–§13.2).
 *
 * Stable key=value phrasing, one line per event, written to stderr (and an
 * optional file sink). Sink failures must never crash orchestration.
 */
import { appendFileSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: string | number | boolean | null | undefined;
}

let fileSink: string | null = null;
let minLevel: LogLevel = "info";
const levelRank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function configureLogging(opts: { file?: string | null; level?: LogLevel }): void {
  if (opts.file !== undefined) fileSink = opts.file;
  if (opts.level) minLevel = opts.level;
}

function formatValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "null";
  const s = String(value);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}

export function log(level: LogLevel, message: string, ctx: LogContext = {}): void {
  if (levelRank[level] < levelRank[minLevel]) return;
  const ts = new Date().toISOString();
  const fields = Object.entries(ctx)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(" ");
  const line = `${ts} level=${level} msg=${JSON.stringify(message)}${fields ? " " + fields : ""}`;
  try {
    process.stderr.write(line + "\n");
  } catch {
    // stderr failure: nothing else we can do, keep running (§13.2)
  }
  if (fileSink) {
    try {
      appendFileSync(fileSink, line + "\n");
    } catch {
      fileSink = null; // drop the failing sink, keep the remaining one
      try {
        process.stderr.write(`${ts} level=warn msg="log file sink failed; disabled"\n`);
      } catch {
        /* ignore */
      }
    }
  }
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => log("debug", msg, ctx),
  info: (msg: string, ctx?: LogContext) => log("info", msg, ctx),
  warn: (msg: string, ctx?: LogContext) => log("warn", msg, ctx),
  error: (msg: string, ctx?: LogContext) => log("error", msg, ctx),
};
