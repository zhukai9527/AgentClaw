import { describe, expect, it, vi } from "vitest";
import { MemoryExtractor } from "../memory-extractor.js";
import type {
  ConversationTurn,
  LLMProvider,
  LLMResponse,
  MemoryStore,
  ModelInfo,
  Trace,
} from "@agentclaw/types";

function createProvider(responses: string[]): LLMProvider {
  const chat = vi.fn(async () => {
    const content = responses.shift() ?? "[]";
    return {
      message: {
        id: "llm-memory",
        role: "assistant",
        content,
        createdAt: new Date(),
      },
      model: "memory-model",
      tokensIn: 10,
      tokensOut: 5,
      stopReason: "end_turn",
    } as LLMResponse;
  });

  return {
    name: "memory-provider",
    models: [
      {
        id: "memory-model",
        provider: "mock",
        name: "Memory",
        tier: "fast",
        contextWindow: 4096,
        supportsTools: false,
        supportsStreaming: false,
      },
    ] as ModelInfo[],
    chat,
    stream: vi.fn(async function* () {}),
  };
}

describe("MemoryExtractor — L1 provenance", () => {
  it("processConversation 应保存 L1 原子记忆的来源、场景和置信度", async () => {
    const turns: ConversationTurn[] = [
      {
        id: "turn-user-1",
        conversationId: "conv-l1",
        role: "user",
        content: "以后做 PPTX 必须先验收预览图，确认好看再发送。",
        createdAt: new Date("2026-05-14T10:00:00.000Z"),
      },
      {
        id: "turn-assistant-1",
        conversationId: "conv-l1",
        role: "assistant",
        content: "我会先生成、渲染预览、校验，再发送。",
        createdAt: new Date("2026-05-14T10:00:01.000Z"),
      },
    ];
    const store = {
      getHistory: vi.fn().mockResolvedValue(turns),
      search: vi.fn().mockResolvedValue([]),
      findSimilar: vi.fn().mockResolvedValue(null),
      add: vi.fn().mockResolvedValue({}),
    } as unknown as MemoryStore;
    const provider = createProvider([
      JSON.stringify([
        {
          type: "preference",
          content: "用户要求 PPTX 交付前必须先验收预览图，确认美观后再发送。",
          importance: 0.9,
          scene_name: "PPTX delivery",
          confidence: 0.86,
        },
      ]),
    ]);
    const extractor = new MemoryExtractor({ provider, memoryStore: store });

    const stored = await extractor.processConversation("conv-l1", 10);
    const addCall = (store.add as ReturnType<typeof vi.fn>).mock.calls[0];

    expect(stored).toBe(1);
    expect(addCall[0].metadata).toMatchObject({
      layer: "L1",
      source: "conversation",
      conversationId: "conv-l1",
      sourceTurnIds: ["turn-user-1", "turn-assistant-1"],
      sceneName: "PPTX delivery",
      confidence: 0.86,
    });
  });

  it("processConversation 应在同场景偏好变更时废弃旧记忆并保留 supersedes 证据", async () => {
    const turns: ConversationTurn[] = [
      {
        id: "turn-user-conflict",
        conversationId: "conv-conflict",
        role: "user",
        content: "以后 PPTX 不要深色背景，改成白底和蓝色强调。",
        createdAt: new Date("2026-05-15T10:00:00.000Z"),
      },
    ];
    const oldMemory = {
      id: "mem-old",
      type: "preference" as const,
      content: "用户偏好 PPTX 使用深色背景。",
      importance: 0.8,
      createdAt: new Date(),
      accessedAt: new Date(),
      accessCount: 0,
      metadata: {
        layer: "L1",
        sceneName: "PPTX delivery",
        confidence: 0.88,
      },
    };
    const store = {
      getHistory: vi.fn().mockResolvedValue(turns),
      search: vi.fn().mockResolvedValue([]),
      findSimilar: vi.fn().mockResolvedValue({ entry: oldMemory, score: 0.7 }),
      add: vi.fn().mockResolvedValue({
        ...oldMemory,
        id: "mem-new",
        content: "用户以后要求 PPTX 不要深色背景，改成白底和蓝色强调。",
      }),
      update: vi.fn().mockResolvedValue({}),
    } as unknown as MemoryStore;
    const provider = createProvider([
      JSON.stringify([
        {
          type: "preference",
          content: "用户以后要求 PPTX 不要深色背景，改成白底和蓝色强调。",
          importance: 0.9,
          scene_name: "PPTX delivery",
          confidence: 0.92,
        },
      ]),
    ]);

    const extractor = new MemoryExtractor({ provider, memoryStore: store });
    const stored = await extractor.processConversation("conv-conflict", 10);

    expect(stored).toBe(1);
    expect(store.add).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          layer: "L1",
          supersedes: ["mem-old"],
        }),
      }),
      "default",
    );
    expect(store.update).toHaveBeenCalledWith(
      "mem-old",
      expect.objectContaining({
        metadata: expect.objectContaining({
          status: "deprecated",
          supersededBy: "mem-new",
        }),
      }),
    );
  });

  it("consolidateLayeredMemories 应生成可回溯的 L2 scene 和 L3 persona", async () => {
    const entries = [
      {
        id: "l1-pref",
        type: "preference" as const,
        content: "用户要求 PPTX 交付前必须先验收预览图。",
        importance: 0.9,
        createdAt: new Date(),
        accessedAt: new Date(),
        accessCount: 0,
        metadata: {
          layer: "L1",
          sceneName: "PPTX delivery",
          confidence: 0.9,
        },
      },
      {
        id: "l1-fact",
        type: "fact" as const,
        content: "用户认为 PPTX 默认生成效果偏丑，需要设计先行。",
        importance: 0.85,
        createdAt: new Date(),
        accessedAt: new Date(),
        accessCount: 0,
        metadata: {
          layer: "L1",
          sceneName: "PPTX delivery",
          confidence: 0.88,
        },
      },
      {
        id: "l1-pref-2",
        type: "preference" as const,
        content: "用户偏好交付前自行重启、测试并报告具体效果。",
        importance: 0.82,
        createdAt: new Date(),
        accessedAt: new Date(),
        accessCount: 0,
        metadata: {
          layer: "L1",
          sceneName: "delivery discipline",
          confidence: 0.86,
        },
      },
    ];
    const added: unknown[] = [];
    const store = {
      search: vi.fn().mockResolvedValue(
        entries.map((entry) => ({ entry, score: entry.importance })),
      ),
      add: vi.fn(async (entry) => {
        added.push(entry);
        return { id: `new-${added.length}`, ...entry };
      }),
      update: vi.fn().mockResolvedValue({}),
    } as unknown as MemoryStore;
    const extractor = new MemoryExtractor({
      provider: createProvider([]),
      memoryStore: store,
    });

    const result = await extractor.consolidateLayeredMemories("default");

    expect(result).toMatchObject({ l2Created: 1, l3Created: 1 });
    expect(store.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "episodic",
        metadata: expect.objectContaining({
          layer: "L2",
          sceneName: "PPTX delivery",
          evidence: { l1: ["l1-pref", "l1-fact"] },
        }),
      }),
      "default",
    );
    expect(store.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "preference",
        metadata: expect.objectContaining({
          layer: "L3",
          evidence: expect.objectContaining({
            l1: expect.arrayContaining(["l1-pref", "l1-pref-2"]),
          }),
        }),
      }),
      "default",
    );
  });

  it("processTrace 应保存失败教训的 trace 来源和相关 step", async () => {
    const store = {
      search: vi.fn().mockResolvedValue([]),
      findSimilar: vi.fn().mockResolvedValue(null),
      add: vi.fn().mockResolvedValue({}),
    } as unknown as MemoryStore;
    const provider = createProvider([
      JSON.stringify([
        {
          content: "PPTX 发送前如果没有 verifier ok:true，应先运行校验脚本而不是直接 send_file。",
          importance: 0.8,
          scene_name: "PPTX delivery",
          confidence: 0.91,
        },
      ]),
    ]);
    const extractor = new MemoryExtractor({ provider, memoryStore: store });
    const trace: Trace = {
      id: "trace-pptx-fail",
      conversationId: "conv-trace",
      userInput: "生成并发送 PPTX",
      steps: [
        { type: "tool_call", id: "tc-send", name: "send_file" },
        {
          type: "tool_result",
          id: "tr-send",
          toolUseId: "tc-send",
          isError: true,
          content: "Blocked for PPTX delivery: verifier missing",
        },
      ],
      response: "没有发送成功",
      tokensIn: 100,
      tokensOut: 20,
      durationMs: 1000,
      error: "tool_error",
      createdAt: new Date("2026-05-14T10:00:00.000Z"),
    };

    const stored = await extractor.processTrace(trace, "default");
    const addCall = (store.add as ReturnType<typeof vi.fn>).mock.calls[0];

    expect(stored).toBe(1);
    expect(addCall[0].metadata).toMatchObject({
      layer: "L1",
      source: "trace",
      traceId: "trace-pptx-fail",
      conversationId: "conv-trace",
      sourceStepIds: ["tr-send"],
      sceneName: "PPTX delivery",
      confidence: 0.91,
    });
  });
});
