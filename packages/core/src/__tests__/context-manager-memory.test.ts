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

function createMemoryStore(
  results: MemorySearchResult[],
  recordMemoryUsage = vi.fn().mockResolvedValue({}),
): MemoryStore {
  return {
    search: vi.fn().mockResolvedValue(results),
    getHistory: vi.fn().mockResolvedValue([]),
    recordMemoryUsage,
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

    expect(context.systemPrompt).toContain(
      "可选视觉参考，必须服从本次PPT用途与用户明确要求，不能作为默认强制主题",
    );
    expect(context.systemPrompt).toContain("演示稿偏好：深色背景、青绿色强调色。");
    expect(context.systemPrompt).toContain("src:remember_tool");
    expect(context.systemPrompt).toContain("trace:trace-high");
    expect(context.systemPrompt).toContain("conf:0.91");
    expect(context.systemPrompt).not.toContain("低置信偏好不应该进入 prompt");
    expect(context.systemPrompt).not.toContain("trace-low");
  });

  it("PPTX 视觉偏好记忆只能作为可选参考，不能强制默认暗色", async () => {
    const manager = new SimpleContextManager({
      systemPrompt: "system",
      memoryStore: createMemoryStore([
        memory("m-dark", "preference", "演示稿风格偏好：深色背景、青绿色强调色、每页少文字大标题", {
          layer: "L1",
          source: "remember_tool",
          traceId: "trace-dark",
          confidence: 0.93,
        }),
      ]),
    });

    const context = await manager.buildContext(
      "conv-sponsor-pptx",
      "生成本活动的PPT，拉赞助用的，目标清晰。",
    );

    expect(context.systemPrompt).toContain(
      "可选视觉参考，必须服从本次PPT用途与用户明确要求，不能作为默认强制主题",
    );
    expect(context.systemPrompt).not.toContain(
      "- [preference] 演示稿风格偏好：深色背景、青绿色强调色、每页少文字大标题",
    );
  });

  it("优先注入 L3/L2 分层记忆，跳过废弃记忆，并记录注入 telemetry", async () => {
    const recordMemoryUsage = vi.fn().mockResolvedValue({});
    const manager = new SimpleContextManager({
      systemPrompt: "system",
      memoryStore: createMemoryStore(
        [
          memory("l3-profile", "preference", "用户稳定画像：\n- PPTX 要先验收。", {
            layer: "L3",
            source: "persona_aggregate",
            confidence: 0.9,
            sourceMemoryIds: ["l1-a", "l1-b"],
          }),
          memory("l2-scene", "episodic", "场景：PPTX delivery\n- 先预览再发送", {
            layer: "L2",
            source: "scene_aggregate",
            sceneName: "PPTX delivery",
            confidence: 0.86,
            sourceMemoryIds: ["l1-a", "l1-b"],
          }),
          memory("old", "preference", "废弃偏好不应出现", {
            layer: "L1",
            status: "deprecated",
            confidence: 0.95,
          }),
        ],
        recordMemoryUsage,
      ),
    });

    const context = await manager.buildContext("conv-layered", "做一个 PPTX");

    expect(context.systemPrompt).toContain("[profile]");
    expect(context.systemPrompt).toContain("layer:L3");
    expect(context.systemPrompt).toContain("[scene]");
    expect(context.systemPrompt).toContain("scene:PPTX delivery");
    expect(context.systemPrompt).not.toContain("废弃偏好不应出现");
    expect(recordMemoryUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: "l3-profile",
        source: "prompt_injection",
        conversationId: "conv-layered",
      }),
    );
  });
});
