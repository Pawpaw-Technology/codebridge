import { describe, it, expect } from "vitest";
import { validateRequest } from "../../src/schemas/request.js";

describe("RequestSchema – images field", () => {
  const validBase = {
    task_id: "task-001",
    intent: "coding" as const,
    workspace_path: "/home/user/project",
    message: "Fix the layout",
    engine: "opencode",
    mode: "new",
  };

  it("accepts a request without images and defaults to empty array", () => {
    const result = validateRequest(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.images).toEqual([]);
    }
  });

  it("accepts valid image path array", () => {
    const result = validateRequest({
      ...validBase,
      images: ["/home/user/project/screenshot.png", "/tmp/diagram.jpg"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.images).toEqual([
        "/home/user/project/screenshot.png",
        "/tmp/diagram.jpg",
      ]);
    }
  });

  it("rejects empty string in image path array", () => {
    const result = validateRequest({
      ...validBase,
      images: [""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects null byte in image path", () => {
    const result = validateRequest({
      ...validBase,
      images: ["/home/user/project/img\x00.png"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i: any) => i.message);
      expect(messages).toContain("Image path must not contain null bytes");
    }
  });

  it("accepts an explicit empty images array", () => {
    const result = validateRequest({
      ...validBase,
      images: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.images).toEqual([]);
    }
  });
});
