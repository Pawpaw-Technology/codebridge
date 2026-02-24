import { spawn } from "node:child_process";
import path from "node:path";
import type { EngineResponse } from "../core/engine.js";
import { makeError } from "../schemas/errors.js";

export abstract class BaseEngine {
  static readonly MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

  protected exec(
    command: string,
    args: string[],
    timeoutMs: number,
    cwd?: string,
  ): Promise<EngineResponse> {
    return new Promise((resolve) => {
      const extraBins = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
      const home = process.env.HOME;
      if (home) {
        extraBins.push(path.join(home, ".local", "bin"));
        extraBins.push(path.join(home, ".npm-global", "bin"));
      }
      const mergedPath = [
        ...new Set([
          ...(process.env.PATH ?? "").split(":").filter(Boolean),
          ...extraBins,
        ]),
      ].join(":");

      const child = spawn(command, args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, PATH: mergedPath },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let outputOverflow = false;
      let totalBytes = 0;
      let killScheduled = false;

      const killProcessGroup = (signal: NodeJS.Signals) => {
        const pid = child.pid;
        if (!pid) {
          // pid is undefined (spawn failed) or 0 — fall back to direct kill
          // process.kill(-0, signal) would kill the daemon's own process group
          try {
            child.kill(signal);
          } catch {
            /* already dead */
          }
          return;
        }
        try {
          // Kill the entire process group (negative PID)
          process.kill(-pid, signal);
        } catch {
          // Fallback to direct child kill if process group kill fails
          try {
            child.kill(signal);
          } catch {
            /* already dead */
          }
        }
      };

      const escalateKill = () => {
        if (killScheduled) return;
        killScheduled = true;
        killProcessGroup("SIGTERM");
        setTimeout(() => killProcessGroup("SIGKILL"), 3000);
      };

      const captureChunk = (chunk: Buffer, target: "stdout" | "stderr") => {
        if (outputOverflow) return;
        const incomingBytes = chunk.byteLength;
        const remaining = BaseEngine.MAX_OUTPUT_BYTES - totalBytes;

        if (incomingBytes > remaining) {
          if (remaining > 0) {
            const partial = chunk.subarray(0, remaining).toString();
            if (target === "stdout") stdout += partial;
            else stderr += partial;
            totalBytes += remaining;
          }
          outputOverflow = true;
          escalateKill();
          return;
        }

        const incoming = chunk.toString();
        if (target === "stdout") stdout += incoming;
        else stderr += incoming;
        totalBytes += incomingBytes;
      };

      const timer = setTimeout(() => {
        timedOut = true;
        escalateKill();
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) =>
        captureChunk(chunk, "stdout"),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        captureChunk(chunk, "stderr"),
      );

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            output: stdout,
            stderr,
            pid: child.pid ?? 0,
            exitCode: code,
            sessionId: null,
            error: makeError(
              "ENGINE_TIMEOUT",
              `Process killed after ${timeoutMs}ms`,
              stderr.slice(-2000) || undefined,
            ),
          });
          return;
        }
        if (outputOverflow) {
          resolve({
            output: stdout,
            stderr,
            pid: child.pid ?? 0,
            exitCode: code,
            sessionId: null,
            error: makeError(
              "ENGINE_CRASH",
              `Engine output exceeded ${BaseEngine.MAX_OUTPUT_BYTES} bytes`,
            ),
          });
          return;
        }
        if (code !== 0) {
          resolve({
            output: stdout,
            stderr,
            pid: child.pid ?? 0,
            exitCode: code,
            sessionId: null,
            error: makeError(
              "ENGINE_CRASH",
              stderr || `Process exited with code ${code}`,
            ),
          });
          return;
        }
        try {
          const parsed = this.parseOutput(stdout, stderr, child.pid ?? 0);
          resolve({ ...parsed, stderr });
        } catch (err) {
          resolve({
            output: stdout,
            stderr,
            pid: child.pid ?? 0,
            exitCode: code,
            sessionId: null,
            error: makeError(
              "ENGINE_CRASH",
              `Output parse error: ${(err as Error).message}`,
            ),
          });
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          output: "",
          stderr,
          pid: child.pid ?? 0,
          exitCode: null,
          sessionId: null,
          error: makeError("ENGINE_CRASH", err.message),
        });
      });
    });
  }

  protected abstract parseOutput(
    stdout: string,
    stderr: string,
    pid: number,
  ): EngineResponse;
}
