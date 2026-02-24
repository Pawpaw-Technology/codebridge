/**
 * Tests for stderr capture in BaseEngine.exec()
 *
 * Phase 1: stderr field on EngineResponse
 * Phase 3: stderr surfaced in error.detail
 * Phase 4: process group kill (detached: true)
 */
import { describe, it, expect } from "vitest";
import { ClaudeCodeEngine } from "../../src/engines/claude-code.js";
import type { TaskRequest } from "../../src/schemas/request.js";

const makeRequest = (overrides?: Partial<TaskRequest>): TaskRequest => ({
  task_id: "t1",
  intent: "coding",
  workspace_path: "/tmp",
  message: "test",
  engine: "claude-code",
  mode: "new",
  session_id: null,
  constraints: { timeout_ms: 30000, allow_network: true },
  ...overrides,
});

describe("BaseEngine — stderr capture", () => {
  // Phase 1: stderr field present on all exit paths

  it("includes stderr on success (exit 0)", async () => {
    const engine = new ClaudeCodeEngine({
      command: "bash",
      defaultArgs: ["-c", "echo ok; echo err-msg >&2"],
    });
    const result = await engine.start(makeRequest());
    expect(result.stderr).toBe("err-msg\n");
    expect(result.error).toBeUndefined();
  });

  it("includes stderr on ENGINE_TIMEOUT", { timeout: 15000 }, async () => {
    // Use exec to replace bash with sleep so SIGTERM kills the process directly
    const engine = new ClaudeCodeEngine({
      command: "bash",
      defaultArgs: ["-c", "echo timeout-stderr >&2; exec sleep 30"],
    });
    const result = await engine.start(
      makeRequest({ constraints: { timeout_ms: 500, allow_network: true } }),
    );
    expect(result.error?.code).toBe("ENGINE_TIMEOUT");
    expect(result.stderr).toContain("timeout-stderr");
  });

  it("includes stderr on ENGINE_CRASH (exit 1)", async () => {
    const engine = new ClaudeCodeEngine({
      command: "bash",
      defaultArgs: ["-c", "echo crash-stderr >&2; exit 1"],
    });
    const result = await engine.start(makeRequest());
    expect(result.error?.code).toBe("ENGINE_CRASH");
    expect(result.stderr).toContain("crash-stderr");
  });

  it("includes stderr on output overflow", async () => {
    const engine = new ClaudeCodeEngine({
      command: "bash",
      defaultArgs: [
        "-c",
        "echo overflow-stderr >&2; dd if=/dev/zero bs=1048576 count=11 2>/dev/null",
      ],
    });
    const result = await engine.start(makeRequest());
    expect(result.error?.code).toBe("ENGINE_CRASH");
    expect(result.stderr).toContain("overflow-stderr");
  });

  // Phase 3: stderr surfaced in error.detail

  it(
    "timeout error includes stderr in detail",
    { timeout: 15000 },
    async () => {
      const engine = new ClaudeCodeEngine({
        command: "bash",
        defaultArgs: [
          "-c",
          "echo 'auth-failure: token expired' >&2; exec sleep 30",
        ],
      });
      const result = await engine.start(
        makeRequest({ constraints: { timeout_ms: 500, allow_network: true } }),
      );
      expect(result.error?.code).toBe("ENGINE_TIMEOUT");
      expect(result.error?.detail).toContain("auth-failure: token expired");
    },
  );

  it("stderr is empty string on spawn error (ENOENT)", async () => {
    const engine = new ClaudeCodeEngine({
      command: "/nonexistent-binary-xyz-12345",
      defaultArgs: [],
    });
    const result = await engine.start(makeRequest());
    expect(result.error?.code).toBe("ENGINE_CRASH");
    expect(result.stderr).toBe("");
    expect(result.error?.detail).toBeUndefined();
  });

  it("includes stderr on output parse error (exit 0, non-JSON)", async () => {
    const engine = new ClaudeCodeEngine({
      command: "bash",
      defaultArgs: ["-c", "echo parse-err-stderr >&2; echo 'not-json'"],
    });
    const result = await engine.start(makeRequest());
    // ClaudeCodeEngine.parseOutput doesn't throw on non-JSON — it falls back to raw stdout.
    // But the stderr should still be captured regardless of exit path.
    expect(result.stderr).toContain("parse-err-stderr");
  });

  it("stderr is empty string when no stderr", async () => {
    const engine = new ClaudeCodeEngine({
      command: "echo",
      defaultArgs: ["no-stderr-here"],
    });
    const result = await engine.start(makeRequest());
    expect(result.stderr).toBe("");
  });

  // Phase 4: process group kill (detached: true)

  it("kills child process tree on timeout", { timeout: 15000 }, async () => {
    // Spawn a bash that starts a grandchild (sleep), write grandchild PID to stderr
    // After timeout, both should be dead
    const engine = new ClaudeCodeEngine({
      command: "bash",
      defaultArgs: ["-c", "sleep 60 & echo GRANDCHILD_PID=$! >&2; wait"],
    });
    const result = await engine.start(
      makeRequest({ constraints: { timeout_ms: 500, allow_network: true } }),
    );
    expect(result.error?.code).toBe("ENGINE_TIMEOUT");

    // Extract grandchild PID from stderr
    const match = result.stderr?.match(/GRANDCHILD_PID=(\d+)/);
    expect(match).not.toBeNull();
    const grandchildPid = Number(match![1]);

    // Give OS a moment to reap
    await new Promise((r) => setTimeout(r, 200));

    // Grandchild should be dead
    let alive = false;
    try {
      process.kill(grandchildPid, 0); // signal 0 = probe
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("kills child process tree on overflow", { timeout: 15000 }, async () => {
    const engine = new ClaudeCodeEngine({
      command: "bash",
      defaultArgs: [
        "-c",
        "sleep 60 & echo GRANDCHILD_PID=$! >&2; dd if=/dev/zero bs=1048576 count=11 2>/dev/null; wait",
      ],
    });
    const result = await engine.start(makeRequest());
    expect(result.error?.code).toBe("ENGINE_CRASH");

    const match = result.stderr?.match(/GRANDCHILD_PID=(\d+)/);
    expect(match).not.toBeNull();
    const grandchildPid = Number(match![1]);

    await new Promise((r) => setTimeout(r, 200));

    let alive = false;
    try {
      process.kill(grandchildPid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("normal exit works with detached:true (smoke test)", async () => {
    const engine = new ClaudeCodeEngine({
      command: "echo",
      defaultArgs: ["detached-works"],
    });
    const result = await engine.start(makeRequest());
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("detached-works");
  });
});
