import type { Engine, EngineResponse } from "../core/engine.js";
import type { TaskRequest } from "../schemas/request.js";
import { BaseEngine } from "./base-engine.js";

export interface GeminiCodeOptions {
  command?: string;
  defaultArgs?: string[];
}

const VALID_APPROVAL_MODES = new Set(["default", "auto_edit", "yolo", "plan"]);

export const GEMINI_DEFAULT_MODEL = "gemini-3.1-pro-preview";

export class GeminiCodeEngine extends BaseEngine implements Engine {
  private command: string;
  private defaultArgs: string[];

  constructor(opts?: GeminiCodeOptions) {
    super();
    this.command = opts?.command ?? "gemini";
    this.defaultArgs = opts?.defaultArgs ?? [];
  }

  async start(task: TaskRequest): Promise<EngineResponse> {
    const args = this.buildStartArgs(task);
    return this.exec(
      this.command,
      args,
      task.constraints?.timeout_ms ?? 1800000,
      task.workspace_path,
    );
  }

  async send(
    sessionId: string,
    message: string,
    opts?: { timeoutMs?: number; cwd?: string },
  ): Promise<EngineResponse> {
    const args = [
      ...this.approvalArgs(),
      "--output-format",
      "json",
      "--resume",
      sessionId,
      "--prompt",
      message,
    ];
    return this.exec(this.command, args, opts?.timeoutMs ?? 1800000, opts?.cwd);
  }

  async stop(pid: number): Promise<void> {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }

  private buildStartArgs(task: TaskRequest): string[] {
    if (this.defaultArgs.length > 0) return [...this.defaultArgs];
    const args = [...this.approvalArgs(), "--output-format", "json"];
    args.push("--model", task.model ?? GEMINI_DEFAULT_MODEL);
    args.push("--prompt", this.injectImagePaths(task.message, task.images));
    return args;
  }

  private approvalArgs(): string[] {
    const mode = process.env.CODEBRIDGE_GEMINI_APPROVAL_MODE?.trim();
    if (!mode) return ["--yolo"];
    if (!VALID_APPROVAL_MODES.has(mode)) return ["--yolo"];
    if (mode === "yolo") return ["--yolo"];
    return ["--approval-mode", mode];
  }

  protected parseOutput(
    stdout: string,
    stderr: string,
    pid: number,
  ): EngineResponse {
    const parsed = this.parseGeminiJson(stdout);
    return {
      output:
        typeof parsed?.response === "string" ? parsed.response : stdout.trim(),
      pid,
      exitCode: 0,
      sessionId: this.extractSessionId(parsed, stderr + stdout),
      tokenUsage: this.extractTokenUsage(parsed),
    };
  }

  private parseGeminiJson(output: string): Record<string, unknown> | null {
    const trimmed = output.trim();
    if (!trimmed) return null;

    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Gemini prints non-JSON notices (e.g., "YOLO mode is enabled.") before
      // the JSON payload. Scan for the last balanced JSON object in the output.
      const start = trimmed.indexOf("{");
      if (start === -1) return null;
      // Attempt progressively shorter tail slices starting at each "{".
      const candidates: number[] = [];
      for (let i = start; i < trimmed.length; i++) {
        if (trimmed[i] === "{") candidates.push(i);
      }
      // Try from earliest (full payload) first, then skip past nested braces.
      for (const idx of candidates) {
        const slice = trimmed.slice(idx);
        try {
          return JSON.parse(slice) as Record<string, unknown>;
        } catch {
          /* try next candidate */
        }
      }
      return null;
    }
  }

  private extractSessionId(
    parsed: Record<string, unknown> | null,
    rawOutput: string,
  ): string | null {
    if (typeof parsed?.session_id === "string" && parsed.session_id) {
      return parsed.session_id;
    }
    const match = rawOutput.match(/"session_id"\s*:\s*"([^"]+)"/);
    return match?.[1] ?? null;
  }

  private extractTokenUsage(parsed: Record<string, unknown> | null): {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null {
    const stats = parsed?.stats as Record<string, unknown> | undefined;
    const models = stats?.models as Record<string, unknown> | undefined;
    if (!models || typeof models !== "object" || Array.isArray(models)) {
      return null;
    }

    let promptSum = 0;
    let completionSum = 0;
    let totalSum = 0;
    let sawAny = false;
    let sawNegative = false;

    for (const modelData of Object.values(models)) {
      if (!modelData || typeof modelData !== "object") continue;
      const tokens = (modelData as Record<string, unknown>).tokens as
        | Record<string, unknown>
        | undefined;
      if (!tokens || typeof tokens !== "object") continue;

      const input = typeof tokens.input === "number" ? tokens.input : 0;
      const candidates =
        typeof tokens.candidates === "number" ? tokens.candidates : 0;
      const thoughts =
        typeof tokens.thoughts === "number" ? tokens.thoughts : 0;
      const total = typeof tokens.total === "number" ? tokens.total : 0;

      if (input < 0 || candidates < 0 || thoughts < 0 || total < 0) {
        sawNegative = true;
        continue;
      }

      if (
        typeof tokens.input === "number" ||
        typeof tokens.candidates === "number" ||
        typeof tokens.total === "number"
      ) {
        promptSum += input;
        completionSum += candidates + thoughts;
        totalSum += total;
        sawAny = true;
      }
    }

    if (!sawAny) return sawNegative ? null : null;
    return {
      prompt_tokens: promptSum,
      completion_tokens: completionSum,
      total_tokens: totalSum > 0 ? totalSum : promptSum + completionSum,
    };
  }
}
