import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdirSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import {
  GeminiCodeEngine,
  GEMINI_DEFAULT_MODEL,
} from "../../src/engines/gemini-code.js";
import type { TaskRequest } from "../../src/schemas/request.js";

describe("GeminiCodeEngine", () => {
  beforeAll(() => {
    mkdirSync("/tmp/cb-test-project", { recursive: true });
  });

  afterEach(() => {
    delete process.env.CODEBRIDGE_GEMINI_APPROVAL_MODE;
  });

  const makeRequest = (overrides?: Partial<TaskRequest>): TaskRequest => ({
    task_id: "task-001",
    intent: "coding",
    workspace_path: "/tmp/cb-test-project",
    message: "Hello world",
    engine: "gemini-code",
    mode: "new",
    session_id: null,
    constraints: { timeout_ms: 30000, allow_network: true },
    ...overrides,
  });

  it("starts a new session and returns pid and output", async () => {
    const engine = new GeminiCodeEngine({
      command: "echo",
      defaultArgs: ["hello from gemini"],
    });
    const result = await engine.start(makeRequest());
    expect(result.pid).toBeTypeOf("number");
    expect(result.output).toContain("hello from gemini");
    expect(result.error).toBeUndefined();
  });

  it("parses JSON output for response, session_id, and token usage", async () => {
    const payload = JSON.stringify({
      session_id: "sess-gem-1",
      response: "hello ok",
      stats: {
        models: {
          "gemini-3-flash-preview": {
            tokens: {
              input: 100,
              candidates: 20,
              thoughts: 5,
              total: 125,
            },
          },
        },
      },
    });
    const engine = new GeminiCodeEngine({
      command: "echo",
      defaultArgs: [payload],
    });
    const result = await engine.start(makeRequest());
    expect(result.output).toBe("hello ok");
    expect(result.sessionId).toBe("sess-gem-1");
    expect(result.tokenUsage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
    });
  });

  it("sums tokens across multiple models (utility_router + main)", async () => {
    const payload = JSON.stringify({
      session_id: "sess-multi",
      response: "multi-model reply",
      stats: {
        models: {
          "gemini-2.5-flash-lite": {
            tokens: { input: 9546, candidates: 26, thoughts: 82, total: 9654 },
          },
          "gemini-3-flash-preview": {
            tokens: { input: 400, candidates: 50, thoughts: 10, total: 460 },
          },
        },
      },
    });
    const engine = new GeminiCodeEngine({
      command: "echo",
      defaultArgs: [payload],
    });
    const result = await engine.start(makeRequest());
    expect(result.tokenUsage).toEqual({
      prompt_tokens: 9946,
      completion_tokens: 168,
      total_tokens: 10114,
    });
  });

  it("parses trailing JSON after YOLO warning preface", async () => {
    const scriptPath = "/tmp/cb-gemini-yolo-preface.sh";
    const payload = JSON.stringify({
      session_id: "sess-pref",
      response: "after warning",
      stats: {
        models: {
          "gemini-3-flash-preview": {
            tokens: { input: 10, candidates: 5, total: 15 },
          },
        },
      },
    });
    writeFileSync(
      scriptPath,
      [
        "#!/bin/sh",
        'echo "YOLO mode is enabled. All tool calls will be automatically approved."',
        'echo "YOLO mode is enabled. All tool calls will be automatically approved."',
        `cat <<'EOF'\n${payload}\nEOF`,
      ].join("\n"),
    );
    chmodSync(scriptPath, 0o755);
    try {
      const engine = new GeminiCodeEngine({ command: scriptPath });
      const result = await engine.start(makeRequest());
      expect(result.output).toBe("after warning");
      expect(result.sessionId).toBe("sess-pref");
      expect(result.tokenUsage?.total_tokens).toBe(15);
    } finally {
      unlinkSync(scriptPath);
    }
  });

  it("returns raw stdout when output is not JSON", async () => {
    const engine = new GeminiCodeEngine({
      command: "echo",
      defaultArgs: ["plain text output"],
    });
    const result = await engine.start(makeRequest());
    expect(result.output).toBe("plain text output");
    expect(result.sessionId).toBeNull();
    expect(result.tokenUsage).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it("returns ENGINE_CRASH on non-zero exit code", async () => {
    const engine = new GeminiCodeEngine({ command: "false" });
    const result = await engine.start(makeRequest());
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("ENGINE_CRASH");
    expect(result.error?.retryable).toBe(true);
  });

  it("kills process on timeout and returns ENGINE_TIMEOUT", async () => {
    const engine = new GeminiCodeEngine({
      command: "sleep",
      defaultArgs: ["10"],
    });
    const result = await engine.start(
      makeRequest({ constraints: { timeout_ms: 500, allow_network: true } }),
    );
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("ENGINE_TIMEOUT");
    expect(result.error?.retryable).toBe(true);
  }, 10000);

  it("handles command not found error", async () => {
    const engine = new GeminiCodeEngine({
      command: "nonexistent-command-xyz",
    });
    const result = await engine.start(makeRequest());
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("ENGINE_CRASH");
  });

  it("stop() does not throw for non-existent pid", async () => {
    const engine = new GeminiCodeEngine();
    await expect(engine.stop(999999)).resolves.not.toThrow();
  });

  it("includes --model flag when model is specified", async () => {
    const scriptPath = "/tmp/cb-gemini-model.sh";
    writeFileSync(scriptPath, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(scriptPath, 0o755);
    try {
      const engine = new GeminiCodeEngine({ command: scriptPath });
      const result = await engine.start(
        makeRequest({ model: "gemini-3-flash-preview" }),
      );
      expect(result.output).toContain("--model");
      expect(result.output).toContain("gemini-3-flash-preview");
    } finally {
      unlinkSync(scriptPath);
    }
  });

  it("defaults to gemini-3.1-pro-preview when no model is specified", async () => {
    const scriptPath = "/tmp/cb-gemini-default-model.sh";
    writeFileSync(scriptPath, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(scriptPath, 0o755);
    try {
      const engine = new GeminiCodeEngine({ command: scriptPath });
      const result = await engine.start(makeRequest());
      expect(GEMINI_DEFAULT_MODEL).toBe("gemini-3.1-pro-preview");
      expect(result.output).toContain("--model");
      expect(result.output).toContain(GEMINI_DEFAULT_MODEL);
    } finally {
      unlinkSync(scriptPath);
    }
  });

  it("uses caller-provided model over the default", async () => {
    const scriptPath = "/tmp/cb-gemini-override-model.sh";
    writeFileSync(scriptPath, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(scriptPath, 0o755);
    try {
      const engine = new GeminiCodeEngine({ command: scriptPath });
      const result = await engine.start(
        makeRequest({ model: "gemini-3-flash-preview" }),
      );
      expect(result.output).toContain("gemini-3-flash-preview");
      expect(result.output).not.toContain(GEMINI_DEFAULT_MODEL);
    } finally {
      unlinkSync(scriptPath);
    }
  });

  it("defaults to --yolo when CODEBRIDGE_GEMINI_APPROVAL_MODE is unset", async () => {
    const scriptPath = "/tmp/cb-gemini-yolo-default.sh";
    writeFileSync(scriptPath, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(scriptPath, 0o755);
    try {
      const engine = new GeminiCodeEngine({ command: scriptPath });
      const result = await engine.start(makeRequest());
      expect(result.output).toContain("--yolo");
      expect(result.output).toContain("--output-format");
      expect(result.output).toContain("json");
      expect(result.output).toContain("--prompt");
    } finally {
      unlinkSync(scriptPath);
    }
  });

  it("uses --approval-mode plan when env var is set to 'plan'", async () => {
    process.env.CODEBRIDGE_GEMINI_APPROVAL_MODE = "plan";
    const scriptPath = "/tmp/cb-gemini-approval-plan.sh";
    writeFileSync(scriptPath, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(scriptPath, 0o755);
    try {
      const engine = new GeminiCodeEngine({ command: scriptPath });
      const result = await engine.start(makeRequest());
      expect(result.output).toContain("--approval-mode");
      expect(result.output).toContain("plan");
      expect(result.output).not.toContain("--yolo");
    } finally {
      unlinkSync(scriptPath);
    }
  });

  it("falls back to --yolo when env var contains an invalid mode", async () => {
    process.env.CODEBRIDGE_GEMINI_APPROVAL_MODE = "unsafe_mode";
    const scriptPath = "/tmp/cb-gemini-invalid-mode.sh";
    writeFileSync(scriptPath, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(scriptPath, 0o755);
    try {
      const engine = new GeminiCodeEngine({ command: scriptPath });
      const result = await engine.start(makeRequest());
      expect(result.output).toContain("--yolo");
      expect(result.output).not.toContain("unsafe_mode");
    } finally {
      unlinkSync(scriptPath);
    }
  });

  it("send() includes --resume with session ID for resumption", async () => {
    const scriptPath = "/tmp/cb-gemini-send-args.sh";
    writeFileSync(scriptPath, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(scriptPath, 0o755);
    try {
      const engine = new GeminiCodeEngine({ command: scriptPath });
      const result = await engine.send(
        "c71d5611-c66c-42d5-97d8-a83d20c287e9",
        "follow up",
        { cwd: "/tmp/cb-test-project" },
      );
      expect(result.output).toContain("--resume");
      expect(result.output).toContain("c71d5611-c66c-42d5-97d8-a83d20c287e9");
      expect(result.output).toContain("--prompt");
      expect(result.output).toContain("follow up");
      expect(result.output).toContain("--output-format");
      expect(result.output).toContain("json");
    } finally {
      unlinkSync(scriptPath);
    }
  });

  it("send() parses JSON response correctly", async () => {
    const scriptPath = "/tmp/cb-gemini-send-parse.sh";
    const payload = JSON.stringify({
      session_id: "sess-resumed",
      response: "resumed response",
      stats: {
        models: {
          "gemini-3-flash-preview": {
            tokens: { input: 50, candidates: 10, total: 60 },
          },
        },
      },
    });
    writeFileSync(
      scriptPath,
      ["#!/bin/sh", `cat <<'EOF'\n${payload}\nEOF`].join("\n"),
    );
    chmodSync(scriptPath, 0o755);
    try {
      const engine = new GeminiCodeEngine({ command: scriptPath });
      const result = await engine.send("sess-resumed", "follow up", {
        cwd: "/tmp/cb-test-project",
      });
      expect(result.output).toBe("resumed response");
      expect(result.sessionId).toBe("sess-resumed");
      expect(result.tokenUsage?.total_tokens).toBe(60);
      expect(result.error).toBeUndefined();
    } finally {
      unlinkSync(scriptPath);
    }
  });

  it("returns null sessionId when session_id is empty string", async () => {
    const payload = JSON.stringify({
      session_id: "",
      response: "ok",
    });
    const engine = new GeminiCodeEngine({
      command: "echo",
      defaultArgs: [payload],
    });
    const result = await engine.start(makeRequest());
    expect(result.sessionId).toBeNull();
  });

  it("returns null tokenUsage when stats field is missing", async () => {
    const payload = JSON.stringify({
      session_id: "sess-notoken",
      response: "no stats",
    });
    const engine = new GeminiCodeEngine({
      command: "echo",
      defaultArgs: [payload],
    });
    const result = await engine.start(makeRequest());
    expect(result.tokenUsage).toBeNull();
  });

  it("returns null tokenUsage when negative token counts are present", async () => {
    const payload = JSON.stringify({
      session_id: "sess-neg",
      response: "neg",
      stats: {
        models: {
          m1: { tokens: { input: -10, candidates: 5, total: -5 } },
        },
      },
    });
    const engine = new GeminiCodeEngine({
      command: "echo",
      defaultArgs: [payload],
    });
    const result = await engine.start(makeRequest());
    expect(result.tokenUsage).toBeNull();
  });

  it("accepts zero token counts as valid", async () => {
    const payload = JSON.stringify({
      session_id: "sess-zero",
      response: "zero",
      stats: {
        models: {
          m1: { tokens: { input: 0, candidates: 0, total: 0 } },
        },
      },
    });
    const engine = new GeminiCodeEngine({
      command: "echo",
      defaultArgs: [payload],
    });
    const result = await engine.start(makeRequest());
    expect(result.tokenUsage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("caps oversized output and returns ENGINE_CRASH", async () => {
    const bytes = 11 * 1024 * 1024; // > 10MB cap
    const engine = new GeminiCodeEngine({
      command: "node",
      defaultArgs: ["-e", `process.stdout.write('x'.repeat(${bytes}))`],
    });
    const result = await engine.start(
      makeRequest({
        constraints: { timeout_ms: 30000, allow_network: true },
      }),
    );
    expect(result.error?.code).toBe("ENGINE_CRASH");
    expect(result.error?.message).toContain("exceeded");
  }, 15000);
});
