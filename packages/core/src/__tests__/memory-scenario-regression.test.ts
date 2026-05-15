import { describe, expect, it, vi } from "vitest";
import { initDatabase, SQLiteMemoryStore } from "@agentclaw/memory";
import type { LLMProvider, LLMResponse, ModelInfo } from "@agentclaw/types";
import { SimpleContextManager } from "../context-manager.js";

function createEmptyActiveMemoryProvider(): LLMProvider {
  return {
    name: "active-memory-regression",
    models: [
      {
        id: "active-memory-regression-model",
        provider: "test",
        name: "Active Memory Regression",
        tier: "fast",
        contextWindow: 4096,
        supportsTools: false,
        supportsStreaming: false,
      },
    ] as ModelInfo[],
    chat: vi.fn().mockResolvedValue({
      message: {
        id: "active-memory-empty",
        role: "assistant",
        content: "",
        createdAt: new Date(),
      },
      model: "active-memory-regression-model",
      tokensIn: 32,
      tokensOut: 0,
      stopReason: "max_tokens",
    } as LLMResponse),
    stream: vi.fn(),
  } as unknown as LLMProvider;
}

describe("memory scenario replay regressions", () => {
  it("同一会话省略 PPTX 主题时，Active Memory 仍选中交付记忆且不注入共享 trace 词的无关画像", async () => {
    const db = initDatabase(":memory:");
    const store = new SQLiteMemoryStore(db);

    try {
      const tracePhrase = "mp6ws-real-replay";
      const conversationId = "conv-memory-scenario-replay";
      const relevant = await store.add({
        type: "preference",
        content: `LIVE ${tracePhrase}: PPTX 交付必须先发可确认预览，确认后发送最终 pptx。`,
        importance: 0.92,
        metadata: {
          layer: "L2",
          source: "scene_aggregate",
          sceneName: "PPTX delivery",
          confidence: 0.95,
        },
      });
      const irrelevant = await store.add({
        type: "preference",
        content: `LIVE ${tracePhrase}: 用户喜欢川菜。`,
        importance: 0.95,
        metadata: {
          layer: "L3",
          source: "persona_aggregate",
          confidence: 0.95,
        },
      });
      await store.addTurn(conversationId, {
        id: "turn-first-pptx-request",
        conversationId,
        role: "user",
        content: `只回答一句：${tracePhrase} 做 PPTX 交付第一步是什么？`,
        createdAt: new Date("2026-05-15T12:00:00.000Z"),
      });

      const manager = new SimpleContextManager({
        systemPrompt: "system",
        provider: createEmptyActiveMemoryProvider(),
        memoryStore: store,
      });
      const context = await manager.buildContext(
        conversationId,
        `同一会话继续：${tracePhrase} 最终应该交付什么文件？`,
      );

      expect(context.systemPrompt).toContain("确认后发送最终 pptx");
      expect(context.systemPrompt).not.toContain("用户喜欢川菜");

      const usageRows = db
        .prepare(
          "SELECT memory_id, source FROM memory_usage WHERE conversation_id = ?",
        )
        .all(conversationId) as Array<{ memory_id: string; source: string }>;
      expect(
        usageRows.filter(
          (row) =>
            row.memory_id === relevant.id && row.source === "active_memory",
        ),
      ).toHaveLength(1);
      expect(
        usageRows.filter(
          (row) =>
            row.memory_id === irrelevant.id && row.source === "active_memory",
        ),
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
