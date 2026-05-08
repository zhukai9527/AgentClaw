import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../chat.js";

describe("CLI system prompt", () => {
  it("不应在 CLI 启动时固化当前时间", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain("{{datetime}}");
    expect(prompt).toContain("{{timezone}}");
  });
});
