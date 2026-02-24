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

  it("accepts a request without images (backward compat)", () => {
    const result = validateRequest(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.images).toEqual([]);
    }
  });

  it("defaults images to empty array when omitted", () => {
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
