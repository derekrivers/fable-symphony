/** §17.2 Workspace Manager and Safety */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertInsideRoot,
  sanitizeWorkspaceKey,
  WorkspaceManager,
  workspacePathFor,
} from "../src/workspace.js";
import { makeSettings, tempDir } from "./helpers.js";
import type { Settings } from "../src/types.js";

function manager(root: string, hooks: Record<string, unknown> = {}): { wsm: WorkspaceManager; settings: Settings } {
  const settings = makeSettings({ workspace: { root }, hooks });
  return { wsm: new WorkspaceManager(() => settings), settings };
}

describe("sanitization and containment (§9.5)", () => {
  it("replaces all characters outside [A-Za-z0-9._-] with _", () => {
    expect(sanitizeWorkspaceKey("ABC-123")).toBe("ABC-123");
    expect(sanitizeWorkspaceKey("a/b\\c d:e*f")).toBe("a_b_c_d_e_f");
    expect(sanitizeWorkspaceKey("../../etc/passwd")).toBe(".._.._etc_passwd");
  });

  it("workspace path is deterministic per identifier", () => {
    expect(workspacePathFor("/ws", "MT-1")).toBe("/ws/MT-1");
    expect(workspacePathFor("/ws", "MT 1")).toBe("/ws/MT_1");
  });

  it("rejects paths outside the workspace root", () => {
    expect(() => assertInsideRoot("/ws/root", "/ws/root/MT-1")).not.toThrow();
    expect(() => assertInsideRoot("/ws/root", "/ws/root")).toThrow();
    expect(() => assertInsideRoot("/ws/root", "/ws/other")).toThrow();
    expect(() => assertInsideRoot("/ws/root", "/etc")).toThrow();
  });
});

describe("creation, reuse, and hooks (§9.2, §9.4)", () => {
  it("creates a missing directory and reuses an existing one", async () => {
    const root = tempDir();
    const { wsm } = manager(root);
    const ws1 = await wsm.createForIssue("MT-7");
    expect(ws1.created_now).toBe(true);
    expect(existsSync(ws1.path)).toBe(true);
    const ws2 = await wsm.createForIssue("MT-7");
    expect(ws2.created_now).toBe(false);
    expect(ws2.path).toBe(ws1.path);
  });

  it("fails safely when a non-directory occupies the workspace path", async () => {
    const root = tempDir();
    writeFileSync(path.join(root, "MT-8"), "i am a file");
    const { wsm } = manager(root);
    await expect(wsm.createForIssue("MT-8")).rejects.toMatchObject({ code: "invalid_workspace_cwd" });
  });

  it("after_create runs only on creation; failure is fatal and removes the new dir", async () => {
    const root = tempDir();
    const marker = path.join(root, "created.log");
    const ok = manager(root, { after_create: `echo ran >> ${marker}` });
    await ok.wsm.createForIssue("MT-9");
    await ok.wsm.createForIssue("MT-9"); // reuse: hook must not run again
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);

    const failing = manager(root, { after_create: "exit 1" });
    await expect(failing.wsm.createForIssue("MT-10")).rejects.toMatchObject({ code: "workspace_hook_failed" });
    expect(existsSync(path.join(root, "MT-10"))).toBe(false);
  });

  it("before_run failure/timeout aborts the attempt; after_run/before_remove failures are ignored", async () => {
    const root = tempDir();
    const failingBefore = manager(root, { before_run: "exit 2" });
    const ws = await failingBefore.wsm.createForIssue("MT-11");
    await expect(failingBefore.wsm.runBeforeRun(ws)).rejects.toMatchObject({ code: "workspace_hook_failed" });

    const timeoutBefore = manager(root, { before_run: "sleep 5", timeout_ms: 100 });
    await expect(timeoutBefore.wsm.runBeforeRun(ws)).rejects.toMatchObject({ code: "workspace_hook_failed" });

    const failingAfter = manager(root, { after_run: "exit 3", before_remove: "exit 4" });
    await expect(failingAfter.wsm.runAfterRun(ws.path)).resolves.toBeUndefined();
    await expect(failingAfter.wsm.cleanupForIssue("MT-11")).resolves.toBeUndefined();
    expect(existsSync(ws.path)).toBe(false); // cleanup proceeds despite before_remove failure
  });

  it("hooks run with the workspace as cwd", async () => {
    const root = tempDir();
    const { wsm } = manager(root, { after_create: "pwd > here.txt" });
    const ws = await wsm.createForIssue("MT-12");
    expect(readFileSync(path.join(ws.path, "here.txt"), "utf8").trim()).toBe(ws.path);
  });

  it("cleanup is a no-op for a missing workspace and respects containment", async () => {
    const root = tempDir();
    const { wsm } = manager(root);
    await expect(wsm.cleanupForIssue("NEVER-MADE")).resolves.toBeUndefined();
    mkdirSync(path.join(root, "MT-13"));
    await wsm.cleanupForIssue("MT-13");
    expect(existsSync(path.join(root, "MT-13"))).toBe(false);
  });
});
