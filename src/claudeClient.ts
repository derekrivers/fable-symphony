/**
 * Claude Code headless client (spec-claude.md §10).
 *
 * Route A: spawns `bash -lc "<claude.command> <derived flags>"` in the
 * per-issue workspace and speaks newline-delimited stream-json on
 * stdin/stdout. Diagnostic stderr is kept separate from the protocol stream.
 *
 * The init wait (`read_timeout_ms`) is enforced once the first user message
 * has been written, so the client behaves correctly whether the installed CLI
 * emits `system`/`init` at spawn or only after the first input line.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { buildClaudeCommand } from "./config.js";
import { logger } from "./logger.js";
import {
  SymphonyError,
  type ClaudeEvent,
  type ClaudeEventName,
  type Settings,
  type UsageSnapshot,
} from "./types.js";

export interface SessionOptions {
  onEvent: (event: ClaudeEvent) => void;
  resumeSessionId?: string;
  signal?: AbortSignal;
}

export interface TurnResult {
  ok: boolean;
  errorCode?: string;
  usage?: UsageSnapshot;
  totalCostUsd?: number;
  numAgenticTurns?: number;
}

interface PendingTurn {
  resolve: (r: TurnResult) => void;
  timer: NodeJS.Timeout;
}

export class ClaudeSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly workspacePath: string;
  claudeSessionId: string | null = null;
  /** Per-step assistant usage, deduplicated by message.id (display only, §13.5). */
  private readonly seenAssistantMessageIds = new Set<string>();
  private pendingTurn: PendingTurn | null = null;
  private initWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private exited = false;
  private exitCode: number | null = null;
  private stopping = false;

  constructor(
    child: ChildProcessWithoutNullStreams,
    workspacePath: string,
    private readonly onEvent: (e: ClaudeEvent) => void,
  ) {
    this.child = child;
    this.workspacePath = workspacePath;

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleLine(line));

    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    child.on("close", (code) => {
      this.exited = true;
      this.exitCode = code;
      for (const w of this.initWaiters.splice(0)) {
        w.reject(new SymphonyError("process_exit", `claude exited (code=${code}) before init`));
      }
      if (this.pendingTurn) {
        const pending = this.pendingTurn;
        this.pendingTurn = null;
        clearTimeout(pending.timer);
        if (this.stopping) {
          pending.resolve({ ok: false, errorCode: "turn_cancelled" });
        } else {
          this.emit("turn_failed", { message: `process exited code=${code}` });
          logger.warn("claude subprocess exited mid-turn", {
            code,
            stderr_tail: stderrTail.slice(-500),
          });
          pending.resolve({ ok: false, errorCode: "process_exit" });
        }
      }
    });
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  private emit(event: ClaudeEventName, extra: Partial<ClaudeEvent> = {}): void {
    this.onEvent({
      event,
      timestamp: new Date().toISOString(),
      claude_pid: this.pid,
      session_id: this.claudeSessionId,
      ...extra,
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.emit("malformed", { message: trimmed.slice(0, 500) });
      return;
    }

    const type = msg["type"];
    switch (type) {
      case "system":
        this.handleSystem(msg);
        break;
      case "assistant":
        this.handleAssistant(msg);
        break;
      case "result":
        this.handleResult(msg);
        break;
      case "rate_limit_event":
        // Emitted by Claude Code >= 2.1.x: latest provider rate-limit snapshot.
        this.emit("rate_limit", { payload: msg["rate_limit_info"] ?? null });
        break;
      case "user":
      case "stream_event":
        // echoes / partial events: liveness only
        this.emit("other_message", { payload: { type } });
        break;
      default:
        this.emit("other_message", { payload: { type } });
    }
  }

  private handleSystem(msg: Record<string, unknown>): void {
    const subtype = msg["subtype"];
    if (subtype === "init") {
      const sid = msg["session_id"];
      if (typeof sid === "string" && sid.length > 0) this.claudeSessionId = sid;
      this.emit("session_started");
      for (const w of this.initWaiters.splice(0)) w.resolve();
      return;
    }
    if (subtype === "api_retry") {
      this.emit("api_retry", {
        payload: {
          attempt: numberOrNull(msg["attempt"]),
          max_retries: numberOrNull(msg["max_retries"]),
          retry_delay_ms: numberOrNull(msg["retry_delay_ms"]),
          error: typeof msg["error"] === "string" ? msg["error"] : null,
        },
      });
      return;
    }
    this.emit("other_message", { payload: { type: "system", subtype } });
  }

  private handleAssistant(msg: Record<string, unknown>): void {
    const inner = (msg["message"] ?? {}) as Record<string, unknown>;
    const messageId = typeof inner["id"] === "string" ? inner["id"] : null;
    // The real CLI splits one assistant message across several events sharing
    // one message.id (thinking block, then text, then tool_use). The repeated
    // id therefore must not gate text extraction; it only matters for
    // per-step usage telemetry, which we don't accumulate (§13.5 uses
    // result.usage). Emit a notification whenever text is present.
    const isRepeatedId = messageId !== null && this.seenAssistantMessageIds.has(messageId);
    if (messageId !== null) this.seenAssistantMessageIds.add(messageId);

    const text = extractAssistantText(inner);
    if (text) {
      this.emit("notification", { message: text.slice(0, 1000) });
    } else {
      this.emit("other_message", { payload: { type: "assistant", repeated_id: isRepeatedId } });
    }
  }

  private handleResult(msg: Record<string, unknown>): void {
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    if (pending) clearTimeout(pending.timer);

    const isError = msg["is_error"] === true || (typeof msg["subtype"] === "string" && msg["subtype"] !== "success");
    const usage = extractUsage(msg["usage"]);
    const totalCostUsd = numberOrNull(msg["total_cost_usd"]) ?? undefined;
    const numAgenticTurns = numberOrNull(msg["num_turns"]) ?? undefined;

    const eventExtra: Partial<ClaudeEvent> = {};
    if (usage) eventExtra.usage = usage;
    if (totalCostUsd !== undefined) eventExtra.total_cost_usd = totalCostUsd;

    if (isError) {
      this.emit("turn_failed", {
        ...eventExtra,
        message: typeof msg["subtype"] === "string" ? msg["subtype"] : "error result",
      });
      pending?.resolve({ ok: false, errorCode: "turn_failed", usage, totalCostUsd, numAgenticTurns });
    } else {
      this.emit("turn_completed", eventExtra);
      pending?.resolve({ ok: true, usage, totalCostUsd, numAgenticTurns });
    }
  }

  waitForInit(timeoutMs: number): Promise<void> {
    if (this.claudeSessionId !== null) return Promise.resolve();
    if (this.exited) {
      return Promise.reject(new SymphonyError("process_exit", `claude exited (code=${this.exitCode}) before init`));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.initWaiters = this.initWaiters.filter((w) => w.resolve !== wrappedResolve);
        reject(new SymphonyError("response_timeout", `no system/init within ${timeoutMs}ms`));
      }, timeoutMs);
      const wrappedResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      const wrappedReject = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      this.initWaiters.push({ resolve: wrappedResolve, reject: wrappedReject });
    });
  }

  /** Write one stream-json user message to stdin (§10.2). */
  writeUserMessage(text: string): void {
    if (this.exited) throw new SymphonyError("process_exit", "cannot write to exited claude process");
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });
    this.child.stdin.write(line + "\n");
  }

  /**
   * Run one prompt→result cycle: write the user message, await the matching
   * `result` (turn_timeout_ms cap). Exactly one turn may be in flight.
   */
  runTurn(prompt: string, turnTimeoutMs: number, readTimeoutMs: number): Promise<TurnResult> {
    if (this.pendingTurn) {
      return Promise.resolve({ ok: false, errorCode: "response_error" });
    }
    return new Promise<TurnResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingTurn?.resolve === resolveOnce) {
          this.pendingTurn = null;
          this.emit("turn_failed", { message: "turn timeout" });
          this.kill();
          resolve({ ok: false, errorCode: "turn_timeout" });
        }
      }, turnTimeoutMs);
      const resolveOnce = (r: TurnResult) => resolve(r);
      this.pendingTurn = { resolve: resolveOnce, timer };

      try {
        this.writeUserMessage(prompt);
      } catch (err) {
        this.pendingTurn = null;
        clearTimeout(timer);
        resolve({ ok: false, errorCode: err instanceof SymphonyError ? err.code : "response_error" });
        return;
      }

      // Enforce read_timeout_ms for session startup on the first turn (§10.6).
      if (this.claudeSessionId === null) {
        this.waitForInit(readTimeoutMs).catch((err: Error) => {
          if (this.pendingTurn?.resolve === resolveOnce) {
            this.pendingTurn = null;
            clearTimeout(timer);
            this.emit("startup_failed", { message: err.message });
            this.kill();
            resolve({
              ok: false,
              errorCode: err instanceof SymphonyError ? err.code : "response_timeout",
            });
          }
        });
      }
    });
  }

  /** Close stdin so the process can exit; escalate to SIGTERM/SIGKILL (§10.3). */
  async stop(graceMs = 3000): Promise<void> {
    this.stopping = true;
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    const exited = await waitFor(() => this.exited, graceMs);
    if (!exited) {
      this.child.kill("SIGTERM");
      const exitedAfterTerm = await waitFor(() => this.exited, 2000);
      if (!exitedAfterTerm) this.child.kill("SIGKILL");
    }
  }

  kill(): void {
    this.stopping = true;
    if (!this.exited) this.child.kill("SIGKILL");
  }
}

export class ClaudeClient {
  constructor(private readonly settings: () => Settings) {}

  /**
   * Launch contract (§10.1): `bash -lc <command + derived flags>` with the
   * workspace as cwd. Invariant 1 (§9.5) — the agent runs only in the
   * workspace path.
   */
  startSession(workspacePath: string, opts: SessionOptions): ClaudeSession {
    const s = this.settings();
    const cmdOpts = opts.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : undefined;
    const command = buildClaudeCommand(s, cmdOpts);
    logger.info("launching claude", { cwd: workspacePath, command });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("bash", ["-lc", command], {
        cwd: workspacePath,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch (err) {
      throw new SymphonyError("claude_not_found", `failed to spawn claude: ${(err as Error).message}`, err);
    }

    const session = new ClaudeSession(child, workspacePath, opts.onEvent);

    child.on("error", (err) => {
      logger.error("claude spawn error", { error: String(err) });
    });

    if (opts.signal) {
      const onAbort = () => session.kill();
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    return session;
  }
}

function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (check()) return resolve(true);
    const started = Date.now();
    const iv = setInterval(() => {
      if (check()) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(iv);
        resolve(false);
      }
    }, 25);
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractAssistantText(inner: Record<string, unknown>): string | null {
  const content = inner["content"];
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((b): b is { type: string; text: string } => {
      const block = b as Record<string, unknown>;
      return block?.["type"] === "text" && typeof block?.["text"] === "string";
    })
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0);
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Lenient cumulative-usage extraction from `result.usage` (§13.5). Cache
 * tokens count toward input/total so totals reflect real context volume.
 */
export function extractUsage(raw: unknown): UsageSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const input =
    (numberOrNull(u["input_tokens"]) ?? 0) +
    (numberOrNull(u["cache_creation_input_tokens"]) ?? 0) +
    (numberOrNull(u["cache_read_input_tokens"]) ?? 0);
  const output = numberOrNull(u["output_tokens"]) ?? 0;
  if (input === 0 && output === 0) return undefined;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}
