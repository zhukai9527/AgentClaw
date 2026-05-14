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
