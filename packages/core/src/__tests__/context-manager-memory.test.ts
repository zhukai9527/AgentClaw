import { describe, expect, it, vi } from "vitest";
import { SimpleContextManager } from "../context-manager.js";
import type {
  LLMProvider,
  LLMResponse,
  ConversationTurn,
  MemorySearchResult,
  MemoryStore,
  ModelInfo,
} from "@agentclaw/types";

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
  history: ConversationTurn[] = [],
): MemoryStore {
  return {
    search: vi.fn().mockResolvedValue(results),
    getHistory: vi.fn().mockResolvedValue(history),
    recordMemoryUsage,
  } as unknown as MemoryStore;
}

function userTurn(content: string): ConversationTurn {
  return {
    id: `turn-${content}`,
    conversationId: "conv",
    role: "user",
    content,
    createdAt: new Date("2026-05-14T00:00:00.000Z"),
  };
}

function createActiveMemoryProvider(
  response: string,
  stopReason: LLMResponse["stopReason"] = "end_turn",
): LLMProvider {
  return {
    name: "active-memory-test",
    models: [
      {
        id: "active-memory-model",
        provider: "test",
        name: "Active Memory",
        tier: "fast",
        contextWindow: 4096,
        supportsTools: false,
        supportsStreaming: false,
      },
    ] as ModelInfo[],
    chat: vi.fn().mockResolvedValue({
      message: {
        id: "active-memory-message",
        role: "assistant",
        content: response,
        createdAt: new Date(),
      },
      model: "active-memory-model",
      tokensIn: 10,
      tokensOut: 5,
      stopReason,
    } as LLMResponse),
    stream: vi.fn(),
  } as unknown as LLMProvider;
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
    expect(context.systemPrompt).toContain(
      "演示稿偏好：深色背景、青绿色强调色。",
    );
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
        memory(
          "m-dark",
          "preference",
          "演示稿风格偏好：深色背景、青绿色强调色、每页少文字大标题",
          {
            layer: "L1",
            source: "remember_tool",
            traceId: "trace-dark",
            confidence: 0.93,
          },
        ),
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
          memory(
            "l3-profile",
            "preference",
            "用户稳定画像：\n- PPTX 要先验收。",
            {
              layer: "L3",
              source: "persona_aggregate",
              confidence: 0.9,
              sourceMemoryIds: ["l1-a", "l1-b"],
            },
          ),
          memory(
            "l2-scene",
            "episodic",
            "场景：PPTX delivery\n- 先预览再发送",
            {
              layer: "L2",
              source: "scene_aggregate",
              sceneName: "PPTX delivery",
              confidence: 0.86,
              sourceMemoryIds: ["l1-a", "l1-b"],
            },
          ),
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

  it("Active Memory 前置召回应在主 prompt 前只选择本轮最相关记忆", async () => {
    const recordMemoryUsage = vi.fn().mockResolvedValue({});
    const provider = createActiveMemoryProvider(
      JSON.stringify({
        ids: ["m-pptx"],
        reason: "current request is about PPTX",
      }),
    );
    const manager = new SimpleContextManager({
      systemPrompt: "system",
      provider,
      memoryStore: createMemoryStore(
        [
          memory("m-pptx", "preference", "用户要求 PPTX 必须白底蓝色强调。", {
            layer: "L2",
            source: "scene_aggregate",
            sceneName: "PPTX delivery",
            confidence: 0.9,
          }),
          memory("m-food", "preference", "用户喜欢吃辣。", {
            layer: "L3",
            source: "persona_aggregate",
            confidence: 0.92,
          }),
        ],
        recordMemoryUsage,
      ),
    });

    const context = await manager.buildContext(
      "conv-active",
      "帮我生成一个 PPTX",
    );

    expect(provider.chat).toHaveBeenCalledOnce();
    expect(context.systemPrompt).toContain("用户要求 PPTX 必须白底蓝色强调。");
    expect(context.systemPrompt).not.toContain("用户喜欢吃辣。");
    expect(recordMemoryUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: "m-pptx",
        source: "active_memory",
        conversationId: "conv-active",
      }),
    );
  });

  it("Active Memory 前置召回应在同一会话多轮重新选择，避免旧缓存污染新请求", async () => {
    const provider = createActiveMemoryProvider(
      JSON.stringify({ ids: ["m-pptx"] }),
    );
    const manager = new SimpleContextManager({
      systemPrompt: "system",
      provider,
      memoryStore: createMemoryStore([
        memory("m-pptx", "preference", "用户要求 PPTX 必须白底蓝色强调。", {
          layer: "L2",
          source: "scene_aggregate",
          sceneName: "PPTX delivery",
          confidence: 0.9,
        }),
        memory("m-food", "preference", "用户喜欢吃辣。", {
          layer: "L3",
          source: "persona_aggregate",
          confidence: 0.92,
        }),
      ]),
    });

    await manager.buildContext("conv-active-cache", "帮我生成一个 PPTX");
    await manager.buildContext("conv-active-cache", "再做一个 PPTX");

    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("Active Memory selector 输出为空时应确定性回退，不能退回全量 prompt 注入", async () => {
    const recordMemoryUsage = vi.fn().mockResolvedValue({});
    const provider = createActiveMemoryProvider("", "max_tokens");
    const manager = new SimpleContextManager({
      systemPrompt: "system",
      provider,
      memoryStore: createMemoryStore(
        [
          memory(
            "m-pptx",
            "preference",
            "PPTX 交付必须先验证 pptx 文件再发送。",
            {
              layer: "L2",
              source: "scene_aggregate",
              sceneName: "PPTX delivery",
              confidence: 0.9,
            },
          ),
          memory("m-food", "preference", "用户喜欢吃辣。", {
            layer: "L3",
            source: "persona_aggregate",
            confidence: 0.92,
          }),
        ],
        recordMemoryUsage,
      ),
    });

    const context = await manager.buildContext(
      "conv-active-fallback",
      "做一个 PPTX",
    );

    expect(provider.chat).toHaveBeenCalledOnce();
    expect(context.systemPrompt).toContain(
      "PPTX 交付必须先验证 pptx 文件再发送。",
    );
    expect(context.systemPrompt).not.toContain("用户喜欢吃辣。");
    expect(recordMemoryUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: "m-pptx",
        source: "active_memory",
        conversationId: "conv-active-fallback",
      }),
    );
  });

  it("Active Memory 应结合最近用户上下文，避免同会话省略主题时选中共享测试词的无关记忆", async () => {
    const recordMemoryUsage = vi.fn().mockResolvedValue({});
    const provider = createActiveMemoryProvider("", "max_tokens");
    const manager = new SimpleContextManager({
      systemPrompt: "system",
      provider,
      memoryStore: createMemoryStore(
        [
          memory(
            "m-pptx",
            "preference",
            "LIVE shared-run: PPTX 交付必须先验证 pptx 文件再发送。",
            {
              layer: "L2",
              source: "scene_aggregate",
              sceneName: "PPTX delivery",
              confidence: 0.9,
            },
          ),
          memory("m-food", "preference", "LIVE shared-run: 用户喜欢川菜。", {
            layer: "L3",
            source: "persona_aggregate",
            confidence: 0.92,
          }),
        ],
        recordMemoryUsage,
        [userTurn("shared-run 做 PPTX 交付第一步是什么？")],
      ),
    });

    const context = await manager.buildContext(
      "conv-active-followup",
      "同一会话继续：shared-run 最终应该交付什么文件？",
    );

    expect(context.systemPrompt).toContain(
      "PPTX 交付必须先验证 pptx 文件再发送。",
    );
    expect(context.systemPrompt).not.toContain("用户喜欢川菜。");
    expect(recordMemoryUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: "m-pptx",
        source: "active_memory",
        conversationId: "conv-active-followup",
      }),
    );
    expect(recordMemoryUsage).not.toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: "m-food" }),
    );
  });
});
