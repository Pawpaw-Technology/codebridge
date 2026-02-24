import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync } from "node:fs";
import { ClaudeCodeEngine } from "../../src/engines/claude-code.js";
import { OpenCodeEngine } from "../../src/engines/opencode.js";
import { KimiCodeEngine } from "../../src/engines/kimi-code.js";
import { CodexEngine } from "../../src/engines/codex.js";
import { BaseEngine } from "../../src/engines/base-engine.js";
import type { TaskRequest } from "../../src/schemas/request.js";

describe("Engine image support", () => {
  beforeAll(() => {
    mkdirSync("/tmp/cb-img-test", { recursive: true });
  });

  const makeRequest = (overrides?: Partial<TaskRequest>): TaskRequest => ({
    task_id: "task-img-001",
    intent: "coding",
    workspace_path: "/tmp/cb-img-test",
    message: "Fix the layout",
    engine: "claude-code",
    mode: "new",
    session_id: null,
    constraints: { timeout_ms: 5000, allow_network: true },
    images: [],
    ...overrides,
  });

  describe("ClaudeCodeEngine", () => {
    it("includes --image flags for each image", async () => {
      // Use 'sh -c echo' to capture the args claude would receive
      const engine = new ClaudeCodeEngine({
        command: "echo",
        defaultArgs: [], // empty so buildStartArgs is used
      });
      const task = makeRequest({
        images: ["/tmp/a.png", "/tmp/b.jpg"],
      });
      // We can't directly test buildStartArgs (private), but we can test
      // that the engine passes the args to the spawned process by checking stdout
      const result = await engine.start(task);
      // echo receives all args; the output should contain --image flags
      expect(result.output).toContain("--image");
      expect(result.output).toContain("/tmp/a.png");
      expect(result.output).toContain("/tmp/b.jpg");
    });

    it("omits --image when images array is empty", async () => {
      const engine = new ClaudeCodeEngine({
        command: "echo",
        defaultArgs: [],
      });
      const task = makeRequest({ images: [] });
      const result = await engine.start(task);
      expect(result.output).not.toContain("--image");
    });
  });

  describe("OpenCodeEngine", () => {
    it("injects image paths into message text", async () => {
      const engine = new OpenCodeEngine({
        command: "echo",
        defaultArgs: [],
      });
      const task = makeRequest({
        engine: "opencode",
        images: ["/tmp/screenshot.png"],
      });
      const result = await engine.start(task);
      expect(result.output).toContain("[Attached image: /tmp/screenshot.png]");
    });

    it("does not modify message when images is empty", async () => {
      const engine = new OpenCodeEngine({
        command: "echo",
        defaultArgs: [],
      });
      const task = makeRequest({ engine: "opencode", images: [] });
      const result = await engine.start(task);
      expect(result.output).not.toContain("[Attached image:");
    });
  });

  describe("KimiCodeEngine", () => {
    it("injects image paths into message text", async () => {
      const engine = new KimiCodeEngine({
        command: "echo",
        defaultArgs: [],
      });
      const task = makeRequest({
        engine: "kimi-code",
        images: ["/tmp/diagram.webp"],
      });
      const result = await engine.start(task);
      expect(result.output).toContain("[Attached image: /tmp/diagram.webp]");
    });
  });

  describe("CodexEngine", () => {
    it("injects image paths into message text", async () => {
      const engine = new CodexEngine({
        command: "echo",
        defaultArgs: [],
      });
      const task = makeRequest({
        engine: "codex",
        images: ["/tmp/bug.gif"],
      });
      const result = await engine.start(task);
      expect(result.output).toContain("[Attached image: /tmp/bug.gif]");
    });
  });

  describe("BaseEngine.injectImagePaths", () => {
    // Access through a test subclass since the method is protected
    class TestEngine extends BaseEngine {
      inject(message: string, images?: string[]): string {
        return this.injectImagePaths(message, images);
      }
      protected parseOutput(stdout: string, _stderr: string, pid: number) {
        return { output: stdout, pid, exitCode: 0, sessionId: null };
      }
    }

    it("formats image block correctly", () => {
      const engine = new TestEngine();
      const result = engine.inject("Fix bugs", ["/a.png", "/b.jpg"]);
      expect(result).toBe(
        "Fix bugs\n\n[Attached image: /a.png]\n[Attached image: /b.jpg]",
      );
    });

    it("returns message unchanged when images is empty", () => {
      const engine = new TestEngine();
      expect(engine.inject("Hello", [])).toBe("Hello");
    });

    it("returns message unchanged when images is undefined", () => {
      const engine = new TestEngine();
      expect(engine.inject("Hello")).toBe("Hello");
    });
  });
});
