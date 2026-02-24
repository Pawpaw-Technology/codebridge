import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskRunner } from "../../src/core/runner.js";
import { RunManager } from "../../src/core/run-manager.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { ClaudeCodeEngine } from "../../src/engines/claude-code.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("TaskRunner – image validation", () => {
  let runsDir: string;
  let workspaceDir: string;
  let runManager: RunManager;
  let sessionManager: SessionManager;

  beforeEach(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-imgrun-"));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-imgws-"));
    runManager = new RunManager(runsDir);
    sessionManager = new SessionManager(runManager);
  });

  afterEach(() => {
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  const makeRun = async (images: string[]) => {
    const engine = new ClaudeCodeEngine({
      command: "echo",
      defaultArgs: ["image task done"],
    });
    const runner = new TaskRunner(runManager, sessionManager, engine);
    const runId = await runManager.createRun({
      task_id: "task-img-001",
      intent: "coding",
      workspace_path: workspaceDir,
      message: "Fix the layout",
      engine: "claude-code",
      mode: "new",
      images,
    });
    await runner.processRun(runId);
    const resultPath = path.join(runsDir, runId, "result.json");
    return JSON.parse(fs.readFileSync(resultPath, "utf-8"));
  };

  it("passes images through to engine on success", async () => {
    const imgPath = path.join(workspaceDir, "screenshot.png");
    fs.writeFileSync(imgPath, "fake-png-data");
    const result = await makeRun([imgPath]);
    expect(result.status).toBe("completed");
  });

  it("rejects non-existent image file", async () => {
    const result = await makeRun([
      path.join(workspaceDir, "does-not-exist.png"),
    ]);
    expect(result.status).toBe("failed");
    expect(result.error.code).toBe("REQUEST_INVALID");
    expect(result.error.message).toMatch(/does not exist/i);
  });

  it("rejects image outside workspace/allowed_roots", async () => {
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "codebridge-outside-"),
    );
    const imgPath = path.join(outsideDir, "escape.png");
    fs.writeFileSync(imgPath, "fake-png-data");

    const engine = new ClaudeCodeEngine({
      command: "echo",
      defaultArgs: ["image task done"],
    });
    const runner = new TaskRunner(runManager, sessionManager, engine);
    const runId = await runManager.createRun({
      task_id: "task-img-002",
      intent: "coding",
      workspace_path: workspaceDir,
      message: "Fix the layout",
      engine: "claude-code",
      mode: "new",
      images: [imgPath],
      allowed_roots: [workspaceDir],
    });
    await runner.processRun(runId);
    const resultPath = path.join(runsDir, runId, "result.json");
    const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));

    expect(result.status).toBe("failed");
    expect(result.error.code).toBe("REQUEST_INVALID");
    expect(result.error.message).toMatch(/outside.*allowed/i);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("rejects unsupported extension (.txt)", async () => {
    const imgPath = path.join(workspaceDir, "notes.txt");
    fs.writeFileSync(imgPath, "just text");
    const result = await makeRun([imgPath]);
    expect(result.status).toBe("failed");
    expect(result.error.code).toBe("REQUEST_INVALID");
    expect(result.error.message).toMatch(/unsupported.*format/i);
  });

  it("rejects directory path as image", async () => {
    const subDir = path.join(workspaceDir, "subdir");
    fs.mkdirSync(subDir);
    // rename to look like an image to isolate the "is a file" check
    const dirAsImg = path.join(workspaceDir, "fake.png");
    fs.mkdirSync(dirAsImg);
    const result = await makeRun([dirAsImg]);
    expect(result.status).toBe("failed");
    expect(result.error.code).toBe("REQUEST_INVALID");
    expect(result.error.message).toMatch(/not a file/i);
  });

  it("accepts images within allowed_roots (different from workspace)", async () => {
    const altRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "codebridge-altroot-"),
    );
    const imgPath = path.join(altRoot, "diagram.png");
    fs.writeFileSync(imgPath, "fake-png-data");

    const engine = new ClaudeCodeEngine({
      command: "echo",
      defaultArgs: ["image task done"],
    });
    const runner = new TaskRunner(runManager, sessionManager, engine);
    const runId = await runManager.createRun({
      task_id: "task-img-003",
      intent: "coding",
      workspace_path: workspaceDir,
      message: "Fix the layout",
      engine: "claude-code",
      mode: "new",
      images: [imgPath],
      allowed_roots: [workspaceDir, altRoot],
    });
    await runner.processRun(runId);
    const resultPath = path.join(runsDir, runId, "result.json");
    const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));

    expect(result.status).toBe("completed");

    fs.rmSync(altRoot, { recursive: true, force: true });
  });
});
