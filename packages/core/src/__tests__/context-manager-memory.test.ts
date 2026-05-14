import { describe, expect, it, vi } from "vitest";
import { SimpleContextManager } from "../context-manager.js";
import type { MemorySearchResult, MemoryStore } from "@agentclaw/types";

function memory(
  id: string,
  type: MemorySearchResult["entry"]["type"],
  content: string,
  metadata?: Record<string, unknown>,
): MemorySearchResult {
  return {
    entry: {
      id,
      type,
      content,
      importance: 0.8,
      createdAt: new Date("2026-05-14T00:00:00.000Z"),
      accessedAt: new Date("2026-05-14T00:00:00.000Z"),
      accessCount: 0,
      metadata,
    },
    score: 0.9,
  };
}

function createMemoryStore(results: MemorySearchResult[]): MemoryStore {
  return {
    search: vi.fn().mockResolvedValue(results),
    getHistory: vi.fn().mockResolvedValue([]),
  } as unknown as MemoryStore;
}

describe("SimpleContextManager — controlled L1 memory recall", () => {
  it("只注入高置信 L1 记忆并保留来源标记", async () => {
    const manager = new SimpleContextManager({
      systemPrompt: "system",
      memoryStore: createMemoryStore([
        memory("m-high", "preference", "演示稿偏好：深色背景、青绿色强调色。", {
          layer: "L1",
          source: "remember_tool",
          traceId: "trace-high",
          conversationId: "conv-high",
          confidence: 0.91,
        }),
        memory("m-low", "preference", "低置信偏好不应该进入 prompt。", {
          layer: "L1",
          source: "conversation",
          traceId: "trace-low",
          confidence: 0.42,
        }),
      ]),
    });

    const context = await manager.buildContext("conv-context", "做一个 PPTX");

    expect(context.systemPrompt).toContain("演示稿偏好：深色背景、青绿色强调色。");
    expect(context.systemPrompt).toContain("src:remember_tool");
    expect(context.systemPrompt).toContain("trace:trace-high");
    expect(context.systemPrompt).toContain("conf:0.91");
    expect(context.systemPrompt).not.toContain("低置信偏好不应该进入 prompt");
    expect(context.systemPrompt).not.toContain("trace-low");
  });
});
