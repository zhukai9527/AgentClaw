import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { SimpleAgentLoop } from "../agent-loop.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  ModelInfo,
  ContextManager,
  MemoryStore,
  Message,
  AgentEvent,
  Tool,
  ToolExecutionContext,
  ToolResult,
} from "@agentclaw/types";
import type { ToolRegistryImpl } from "@agentclaw/tools";

// ── Mock 工厂：创建假 LLMProvider ──

function createMockProvider(
  streamChunks: LLMStreamChunk[][] = [],
): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock-provider",
    models: [
      {
        id: "mock-model",
        provider: "mock",
        name: "Mock",
        tier: "fast",
        contextWindow: 4096,
        supportsTools: true,
        supportsStreaming: true,
      },
    ] as ModelInfo[],
    chat: vi.fn().mockResolvedValue({
      message: {
        id: "msg-1",
        role: "assistant",
        content: "mock response",
        createdAt: new Date(),
      },
      model: "mock-model",
      tokensIn: 10,
      tokensOut: 5,
      stopReason: "end_turn",
    } as LLMResponse),
    stream: vi.fn(function* () {
      const chunks = streamChunks[callIndex] ?? [];
      callIndex++;
      for (const chunk of chunks) {
        yield chunk;
      }
    }) as unknown as LLMProvider["stream"],
  };
}

// ── Mock ToolRegistryImpl ──

function createMockToolRegistry(tools: Tool[] = []): ToolRegistryImpl {
  const toolMap = new Map<string, Tool>();
  for (const t of tools) toolMap.set(t.name, t);

  return {
    register: vi.fn((tool: Tool) => toolMap.set(tool.name, tool)),
    unregister: vi.fn((name: string) => toolMap.delete(name)),
    get: vi.fn((name: string) => toolMap.get(name)),
    list: vi.fn(() => Array.from(toolMap.values())),
    definitions: vi.fn(() =>
      Array.from(toolMap.values()).map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    ),
    execute: vi.fn(
      async (
        name: string,
        input: Record<string, unknown>,
        context?: ToolExecutionContext,
      ): Promise<ToolResult> => {
        const tool = toolMap.get(name);
        if (!tool)
          return { content: `Tool "${name}" not found`, isError: true };
        return tool.execute(input, context);
      },
    ),
  } as unknown as ToolRegistryImpl;
}

// ── Mock ContextManager ──

function createMockContextManager(
  systemPrompt = "你是一个测试助手。",
): ContextManager {
  return {
    buildContext: vi.fn().mockResolvedValue({
      systemPrompt,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "hello",
          createdAt: new Date(),
        },
      ] as Message[],
    }),
  };
}

// ── Mock MemoryStore（最小实现） ──

function createMockMemoryStore(): MemoryStore {
  return {
    add: vi.fn().mockResolvedValue({
      id: "mem-1",
      type: "fact",
      content: "",
      importance: 0.5,
      createdAt: new Date(),
      accessedAt: new Date(),
      accessCount: 0,
    }),
    search: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({}),
    findSimilar: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    addTurn: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    saveSession: vi.fn().mockResolvedValue(undefined),
    getSessionById: vi.fn().mockResolvedValue(null),
    listSessions: vi.fn().mockResolvedValue([]),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    addTrace: vi.fn().mockResolvedValue(undefined),
    getTrace: vi.fn().mockResolvedValue(null),
    getTraces: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    addObservation: vi.fn().mockImplementation(async (observation) => ({
      id: "obs-1",
      ...observation,
      createdAt: new Date(),
    })),
    findObservationByHash: vi.fn().mockResolvedValue(null),
  } as unknown as MemoryStore;
}

// ── 辅助函数：收集 async iterable 中的所有事件 ──

async function collectEvents(
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

// ── 创建一个简单的 mock Tool ──

function createMockTool(
  name: string,
  result: ToolResult = { content: "ok" },
): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    category: "builtin",
    parameters: {
      type: "object" as const,
      properties: {
        input: { type: "string" },
      },
    },
    execute: vi.fn().mockResolvedValue(result),
  };
}

describe("SimpleAgentLoop", () => {
  let provider: LLMProvider;
  let toolRegistry: ToolRegistryImpl;
  let contextManager: ContextManager;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    // 默认：LLM 返回纯文本回复（无工具调用），直接结束
    provider = createMockProvider([
      [
        { type: "text", text: "你好，我是测试助手！" },
        {
          type: "done",
          usage: { tokensIn: 50, tokensOut: 20 },
          model: "mock-model",
        },
      ],
    ]);
    toolRegistry = createMockToolRegistry();
    contextManager = createMockContextManager();
    memoryStore = createMockMemoryStore();
  });

  afterEach(() => {
    for (const conversationId of ["conv-obs", "conv-dedupe"]) {
      const generated = resolve(process.cwd(), "data", "tmp", conversationId);
      if (existsSync(generated)) {
        rmSync(generated, { recursive: true, force: true });
      }
    }
  });

  // ── 构造和配置测试 ──

  describe("构造和基本配置", () => {
    it("应使用默认配置创建实例", () => {
      const loop = new SimpleAgentLoop({
        provider,
        toolRegistry,
        contextManager,
        memoryStore,
      });

      expect(loop.state).toBe("idle");
      expect(loop.config.maxIterations).toBe(15);
      expect(loop.config.temperature).toBe(0.5);
      expect(loop.config.maxTokens).toBe(8192);
      expect(loop.config.streaming).toBe(false);
    });

    it("应允许通过 config 参数覆盖默认值", () => {
      const loop = new SimpleAgentLoop({
        provider,
        toolRegistry,
        contextManager,
        memoryStore,
        config: {
          maxIterations: 5,
          temperature: 0.8,
          maxTokens: 4096,
          model: "custom-model",
        },
      });

      expect(loop.config.maxIterations).toBe(5);
      expect(loop.config.temperature).toBe(0.8);
      expect(loop.config.maxTokens).toBe(4096);
      expect(loop.config.model).toBe("custom-model");
      // 未覆盖的字段保持默认值
      expect(loop.config.systemPrompt).toBe("");
    });
  });

  // ── 简单文本回复测试 ──

  describe("纯文本回复流程", () => {
    it("应在无工具调用时产生 thinking + response_chunk + response_complete 事件", async () => {
      const loop = new SimpleAgentLoop({
        provider,
        toolRegistry,
        contextManager,
        memoryStore,
      });

      const events = await collectEvents(loop.runStream("hello", "conv-1"));

      // 检查事件类型序列
      const types = events.map((e) => e.type);
      expect(types).toContain("thinking");
      expect(types).toContain("response_chunk");
      expect(types).toContain("response_complete");

      // response_complete 应包含完整消息
      const completeEvent = events.find((e) => e.type === "response_complete");
      expect(completeEvent).toBeDefined();
      const message = (completeEvent!.data as { message: Message }).message;
      expect(message.role).toBe("assistant");
      expect(message.tokensIn).toBe(50);
      expect(message.tokensOut).toBe(20);
      expect(message.model).toBe("mock-model");
    });

    it("应将用户消息和助手回复存入 memoryStore", async () => {
      const loop = new SimpleAgentLoop({
        provider,
        toolRegistry,
        contextManager,
        memoryStore,
      });

      await collectEvents(loop.runStream("hello", "conv-1"));

      // addTurn 应被调用至少 2 次（用户消息 + 助手消息）
      expect(memoryStore.addTurn).toHaveBeenCalledTimes(2);

      // 第一次调用：存储用户消息
      const firstCall = (memoryStore.addTurn as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(firstCall[0]).toBe("conv-1");
      expect(firstCall[1].role).toBe("user");

      // 第二次调用：存储助手消息
      const secondCall = (memoryStore.addTurn as ReturnType<typeof vi.fn>).mock
        .calls[1];
      expect(secondCall[0]).toBe("conv-1");
      expect(secondCall[1].role).toBe("assistant");
    });

    it("run() 应返回完整的助手消息", async () => {
      const loop = new SimpleAgentLoop({
        provider,
        toolRegistry,
        contextManager,
        memoryStore,
      });

      const message = await loop.run("hello", "conv-1");

      expect(message.role).toBe("assistant");
      expect(message.model).toBe("mock-model");
    });
  });

  // ── maxIterations 限制测试 ──

  describe("maxIterations 限制", () => {
    it("达到 maxIterations 后应停止循环并返回 fallback 消息", async () => {
      // 每次 LLM 调用都返回一个工具调用，强制循环继续
      const toolCallChunks: LLMStreamChunk[] = [
        {
          type: "tool_use_start",
          toolUse: { id: "tc-1", name: "test_tool", input: "" },
        },
        {
          type: "tool_use_delta",
          toolUse: { id: "tc-1", name: "", input: '{"input":"x"}' },
        },
        {
          type: "done",
          usage: { tokensIn: 10, tokensOut: 5 },
          model: "mock-model",
        },
      ];

      // 创建 3 轮一样的工具调用 chunk（maxIterations=3）
      const allChunks = [toolCallChunks, toolCallChunks, toolCallChunks];
      const testProvider = createMockProvider(allChunks);

      const testTool = createMockTool("test_tool", { content: "tool result" });
      const testToolRegistry = createMockToolRegistry([testTool]);

      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
        config: { maxIterations: 3 },
      });

      const events = await collectEvents(
        loop.runStream("do something", "conv-2"),
      );

      // 应有 response_complete 事件
      const completeEvent = events.find((e) => e.type === "response_complete");
      expect(completeEvent).toBeDefined();

      // 重复调用保护会在第 3 次相同调用前拦截，避免 agent 陷入工具循环
      expect(testTool.execute).toHaveBeenCalledTimes(2);

      // 循环结束后状态应回到 idle
      expect(loop.state).toBe("idle");

      // trace 应记录 max_iterations_reached 错误
      expect(memoryStore.addTrace).toHaveBeenCalledWith(
        expect.objectContaining({ error: "max_iterations_reached" }),
      );
    });
  });

  // ── 工具调用循环测试 ──

  describe("工具调用循环", () => {
    const createToolCallChunks = (
      id: string,
      name: string,
      input: Record<string, unknown> = {},
    ): LLMStreamChunk[] => [
      {
        type: "tool_use_start",
        toolUse: { id, name, input: "" },
      },
      {
        type: "tool_use_delta",
        toolUse: { id, name: "", input: JSON.stringify(input) },
      },
      {
        type: "done",
        usage: { tokensIn: 10, tokensOut: 5 },
        model: "mock-model",
      },
    ];

    const finalChunks: LLMStreamChunk[] = [
      { type: "text", text: "done" },
      {
        type: "done",
        usage: { tokensIn: 20, tokensOut: 10 },
        model: "mock-model",
      },
    ];

    function createToolCaptureProvider(captured: string[][]): LLMProvider {
      return {
        name: "capture-provider",
        models: [
          {
            id: "capture-model",
            provider: "capture",
            name: "Capture",
            tier: "fast",
            contextWindow: 4096,
            supportsTools: true,
            supportsStreaming: true,
          },
        ] as ModelInfo[],
        chat: vi.fn().mockResolvedValue({
          message: {
            id: "msg-capture",
            role: "assistant",
            content: "done",
            createdAt: new Date(),
          },
          model: "capture-model",
          tokensIn: 1,
          tokensOut: 1,
          stopReason: "end_turn",
        } as LLMResponse),
        stream: vi.fn(async function* (request: LLMRequest) {
          captured.push((request.tools ?? []).map((tool) => tool.name));
          yield { type: "text", text: "done" } as LLMStreamChunk;
          yield {
            type: "done",
            usage: { tokensIn: 5, tokensOut: 2 },
            model: "capture-model",
          } as LLMStreamChunk;
        }) as unknown as LLMProvider["stream"],
      };
    }

    it("新闻任务首轮只暴露搜索、抓取和输出工具", async () => {
      const captured: string[][] = [];
      const newsProvider = createToolCaptureProvider(captured);
      const testToolRegistry = createMockToolRegistry([
        createMockTool("web_search"),
        createMockTool("web_fetch"),
        createMockTool("rss_top"),
        createMockTool("file_write"),
        createMockTool("send_file"),
        createMockTool("bash"),
      ]);
      const loop = new SimpleAgentLoop({
        provider: newsProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
      });

      await collectEvents(
        loop.runStream("在外网搜索今日AI界新闻生成简报", "conv-news-tools"),
      );

      expect(captured[0]).toEqual(
        expect.arrayContaining([
          "web_search",
          "web_fetch",
          "file_write",
          "send_file",
        ]),
      );
      expect(captured[0]).not.toContain("rss_top");
      expect(captured[0]).not.toContain("bash");
    });

    it("AI 新闻任务 runtime hint 必须使用当前日期", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
      try {
        const capturedMessages: Message[][] = [];
        const newsProvider: LLMProvider = {
          name: "runtime-date-provider",
          models: [
            {
              id: "runtime-date-model",
              provider: "runtime-date",
              name: "Runtime Date",
              tier: "fast",
              contextWindow: 4096,
              supportsTools: true,
              supportsStreaming: true,
            },
          ] as ModelInfo[],
          chat: vi.fn(),
          stream: vi.fn(async function* (request: LLMRequest) {
            capturedMessages.push(request.messages);
            yield { type: "text", text: "done" } as LLMStreamChunk;
            yield {
              type: "done",
              usage: { tokensIn: 5, tokensOut: 2 },
              model: "runtime-date-model",
            } as LLMStreamChunk;
          }) as unknown as LLMProvider["stream"],
        };
        const loop = new SimpleAgentLoop({
          provider: newsProvider,
          toolRegistry: createMockToolRegistry([createMockTool("web_search")]),
          contextManager,
          memoryStore,
        });

        await collectEvents(loop.runStream("AI news brief", "conv-ai-news"));

        const promptText = JSON.stringify(capturedMessages[0]);
        expect(promptText).toContain("Today is 2026-05-08");
        expect(promptText).not.toContain("Today is 2026-05-03");
      } finally {
        vi.useRealTimers();
      }
    });

    it("Reddit RSS 任务首轮只暴露 rss_top 和文件发送工具", async () => {
      const captured: string[][] = [];
      const rssProvider = createToolCaptureProvider(captured);
      const testToolRegistry = createMockToolRegistry([
        createMockTool("web_search"),
        createMockTool("web_fetch"),
        createMockTool("rss_top"),
        createMockTool("file_write"),
        createMockTool("send_file"),
        createMockTool("bash"),
      ]);
      const loop = new SimpleAgentLoop({
        provider: rssProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
      });

      await collectEvents(
        loop.runStream(
          "执行以下任务，用 execute_code 抓取 Reddit 子版块 .rss 生成日报并 send_file",
          "conv-rss-tools",
        ),
      );

      expect(captured[0]).toEqual(
        expect.arrayContaining(["rss_top", "file_write", "send_file"]),
      );
      expect(captured[0]).not.toContain("web_search");
      expect(captured[0]).not.toContain("web_fetch");
      expect(captured[0]).not.toContain("bash");
    });

    it("Reddit RSS 任务应硬拦截模型伪造的非白名单工具调用", async () => {
      const testProvider = createMockProvider([
        createToolCallChunks("tc-file-read", "file_read", {
          path: "C:/Users/voroj/reddit-tech-ai-daily-2026-05-03.md",
        }),
        finalChunks,
      ]);
      const fileReadTool = createMockTool("file_read", {
        content: "should not execute",
      });
      const testToolRegistry = createMockToolRegistry([
        createMockTool("rss_top"),
        createMockTool("file_write"),
        createMockTool("send_file"),
        fileReadTool,
      ]);
      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
      });

      const events = await collectEvents(
        loop.runStream("Reddit RSS 日报", "conv-rss-policy"),
      );

      const toolResult = events.find((event) => event.type === "tool_result")!;
      const result = (toolResult.data as { result: ToolResult }).result;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not allowed for reddit_rss tasks");
      expect(fileReadTool.execute).not.toHaveBeenCalled();
    });

    it("应正确执行工具并将结果传回 LLM", async () => {
      // 第 1 轮：LLM 调用工具
      const toolCallChunks: LLMStreamChunk[] = [
        { type: "text", text: "让我搜索一下" },
        {
          type: "tool_use_start",
          toolUse: {
            id: "tc-search",
            name: "web_search",
            input: "",
          },
        },
        {
          type: "tool_use_delta",
          toolUse: {
            id: "tc-search",
            name: "",
            input: '{"query":"test"}',
          },
        },
        {
          type: "done",
          usage: { tokensIn: 30, tokensOut: 15 },
          model: "mock-model",
        },
      ];

      // 第 2 轮：LLM 根据工具结果生成最终回复
      const finalChunks: LLMStreamChunk[] = [
        { type: "text", text: "搜索结果是..." },
        {
          type: "done",
          usage: { tokensIn: 60, tokensOut: 25 },
          model: "mock-model",
        },
      ];

      const testProvider = createMockProvider([toolCallChunks, finalChunks]);

      const searchTool = createMockTool("web_search", {
        content: "搜索结果：找到了 3 个结果",
      });
      const testToolRegistry = createMockToolRegistry([searchTool]);

      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
      });

      const events = await collectEvents(
        loop.runStream("搜索一下测试", "conv-3"),
      );

      // 检查事件流中包含工具调用和结果事件
      const types = events.map((e) => e.type);
      expect(types).toContain("tool_call");
      expect(types).toContain("tool_result");
      expect(types).toContain("response_complete");

      // 工具被正确调用
      expect(searchTool.execute).toHaveBeenCalledTimes(1);
      expect(searchTool.execute).toHaveBeenCalledWith(
        { query: "test" },
        undefined, // context
      );

      // tool_result 事件应包含工具名和结果
      const toolResultEvent = events.find((e) => e.type === "tool_result");
      expect(toolResultEvent).toBeDefined();
      const resultData = toolResultEvent!.data as {
        name: string;
        result: ToolResult;
      };
      expect(resultData.name).toBe("web_search");
      expect(resultData.result.content).toBe("搜索结果：找到了 3 个结果");

      // 最终消息应包含累计 token
      const completeEvent = events.find((e) => e.type === "response_complete");
      const message = (completeEvent!.data as { message: Message }).message;
      expect(message.tokensIn).toBe(90); // 30 + 60
      expect(message.tokensOut).toBe(40); // 15 + 25
    });

    it("工具执行失败时应记录 isError 并传回 LLM", async () => {
      // 第 1 轮：调用工具
      const toolCallChunks: LLMStreamChunk[] = [
        {
          type: "tool_use_start",
          toolUse: { id: "tc-1", name: "failing_tool", input: "" },
        },
        {
          type: "tool_use_delta",
          toolUse: { id: "tc-1", name: "", input: "{}" },
        },
        {
          type: "done",
          usage: { tokensIn: 10, tokensOut: 5 },
          model: "mock-model",
        },
      ];

      // 第 2 轮：LLM 看到错误后生成解释
      const finalChunks: LLMStreamChunk[] = [
        { type: "text", text: "工具执行失败了" },
        {
          type: "done",
          usage: { tokensIn: 20, tokensOut: 10 },
          model: "mock-model",
        },
      ];

      const testProvider = createMockProvider([toolCallChunks, finalChunks]);

      const failingTool = createMockTool("failing_tool", {
        content: "连接超时",
        isError: true,
      });
      const testToolRegistry = createMockToolRegistry([failingTool]);

      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
      });

      const events = await collectEvents(loop.runStream("执行一下", "conv-4"));

      // tool_result 事件应标记 isError
      const toolResultEvent = events.find((e) => e.type === "tool_result");
      expect(toolResultEvent).toBeDefined();
      const resultData = toolResultEvent!.data as {
        name: string;
        result: ToolResult;
      };
      expect(resultData.result.isError).toBe(true);
      expect(resultData.result.content).toBe("连接超时");

      // memoryStore 应保存包含错误标记的 tool turn
      const toolTurnCalls = (
        memoryStore.addTurn as ReturnType<typeof vi.fn>
      ).mock.calls.filter(
        (call: unknown[]) => (call[1] as { role: string }).role === "tool",
      );
      expect(toolTurnCalls.length).toBe(1);
    });

    it("大工具输出应创建 observation，返回给模型和 trace 的 content 是小摘要", async () => {
      const largeContent = Array.from(
        { length: 260 },
        (_, i) => `line-${i.toString().padStart(3, "0")} ${"x".repeat(40)}`,
      ).join("\n");
      expect(largeContent.length).toBeGreaterThan(8_000);
      const testProvider = createMockProvider([
        createToolCallChunks("tc-big", "web_fetch", {
          url: "https://example.com",
        }),
        finalChunks,
      ]);
      const fetchTool = createMockTool("web_fetch", { content: largeContent });
      const testToolRegistry = createMockToolRegistry([fetchTool]);
      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
      });

      const events = await collectEvents(loop.runStream("fetch", "conv-obs"));

      expect(memoryStore.addObservation).toHaveBeenCalledTimes(1);
      const observationArg = (
        memoryStore.addObservation as ReturnType<typeof vi.fn>
      ).mock.calls[0][0] as Record<string, unknown>;
      expect(observationArg.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(observationArg.rawPath).toEqual(
        expect.stringContaining("overflow_web_fetch_"),
      );
      expect(observationArg.rawChars).toBe(largeContent.length);
      expect(observationArg.preview).toContain("line-000");

      const toolResult = events.find((event) => event.type === "tool_result")!;
      const result = (toolResult.data as { result: ToolResult }).result;
      expect(result.content.length).toBeLessThan(2_500);
      expect(result.content).toContain("observation://obs-1");
      expect(result.content).toContain("rawChars:");
      expect(result.content).not.toContain(largeContent.slice(3000, 3600));
      expect(result.metadata).toMatchObject({
        overflow: true,
        originalLength: largeContent.length,
        originalLines: 260,
        observationId: "obs-1",
      });
      expect(result.metadata?.overflowPath).toEqual(
        expect.stringContaining("overflow_web_fetch_"),
      );

      const trace = (
        memoryStore.addTrace as ReturnType<typeof vi.fn>
      ).mock.calls.at(-1)?.[0] as { steps: Array<Record<string, unknown>> };
      const traceToolResult = trace.steps.find(
        (step) => step.type === "tool_result",
      );
      expect(String(traceToolResult?.content).length).toBeLessThan(2_500);
      expect(String(traceToolResult?.content)).toContain("observation://obs-1");
      expect(String(traceToolResult?.content)).not.toContain(
        largeContent.slice(3000, 3600),
      );
    });

    it("相同 contentHash 的大输出应复用已有 observation 且不重复写 raw", async () => {
      const largeContent = `${"same-output\n".repeat(900)}tail`;
      const testProvider = createMockProvider([
        [
          ...createToolCallChunks("tc-one", "tool_a", { source: "a" }).slice(
            0,
            2,
          ),
          ...createToolCallChunks("tc-two", "tool_b", { source: "b" }).slice(
            0,
            2,
          ),
          {
            type: "done",
            usage: { tokensIn: 10, tokensOut: 5 },
            model: "mock-model",
          },
        ],
        finalChunks,
      ]);
      const toolA = createMockTool("tool_a");
      const toolB = createMockTool("tool_b");
      (toolA.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: largeContent,
      });
      (toolB.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: largeContent,
      });
      const testToolRegistry = createMockToolRegistry([toolA, toolB]);
      let existingObservation: Record<string, unknown> | null = null;
      (memoryStore.findObservationByHash as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockImplementation(async () => existingObservation);
      (
        memoryStore.addObservation as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(async (input) => {
        existingObservation = {
          id: "obs-existing",
          ...input,
          rawPath: "D:/tmp/existing.txt",
          createdAt: new Date(),
        };
        return existingObservation;
      });
      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
        config: { maxIterations: 3 },
      });

      const events = await collectEvents(
        loop.runStream("fetch twice", "conv-dedupe"),
      );

      expect(memoryStore.findObservationByHash).toHaveBeenCalledTimes(2);
      expect(memoryStore.addObservation).toHaveBeenCalledTimes(1);
      const toolResults = events
        .filter((event) => event.type === "tool_result")
        .map((event) => (event.data as { result: ToolResult }).result);
      expect(toolResults).toHaveLength(2);
      expect(toolResults[0].metadata?.observationId).toBe("obs-existing");
      expect(toolResults[1].metadata?.observationId).toBe("obs-existing");
      expect(toolResults[1].metadata?.overflowPath).toBe("D:/tmp/existing.txt");
      expect(toolResults[1].content).toContain("observation://obs-existing");
    });

    it("use_skill 大输出不应创建 observation", async () => {
      const largeSkill = "skill instructions\n".repeat(600);
      const testProvider = createMockProvider([
        createToolCallChunks("tc-skill", "use_skill", { name: "demo" }),
        finalChunks,
      ]);
      const skillTool = createMockTool("use_skill", { content: largeSkill });
      const testToolRegistry = createMockToolRegistry([skillTool]);
      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
        config: { maxIterations: 3 },
      });

      const events = await collectEvents(
        loop.runStream("use skill", "conv-skill"),
      );

      expect(memoryStore.addObservation).not.toHaveBeenCalled();
      expect(memoryStore.findObservationByHash).not.toHaveBeenCalled();
      const toolResult = events.find((event) => event.type === "tool_result")!;
      const result = (toolResult.data as { result: ToolResult }).result;
      expect(result.content).toBe(largeSkill);
      expect(result.metadata?.observationId).toBeUndefined();
    });

    it("rss_top 紧凑汇总不应创建 observation，避免隐藏日报所需标题", async () => {
      const largeRssSummary = Array.from(
        { length: 140 },
        (_, i) =>
          `## r/topic-${i}\n1. Title ${i}\n   https://reddit.com/r/topic/comments/${i}`,
      ).join("\n");
      expect(largeRssSummary.length).toBeGreaterThan(8_000);
      const testProvider = createMockProvider([
        createToolCallChunks("tc-rss", "rss_top", {
          feeds: ["technology"],
          topN: 5,
        }),
        finalChunks,
      ]);
      const rssTool = createMockTool("rss_top", { content: largeRssSummary });
      const testToolRegistry = createMockToolRegistry([rssTool]);
      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
        config: { maxIterations: 3 },
      });

      const events = await collectEvents(
        loop.runStream("reddit daily", "conv-rss"),
      );

      expect(memoryStore.addObservation).not.toHaveBeenCalled();
      const toolResult = events.find((event) => event.type === "tool_result")!;
      const result = (toolResult.data as { result: ToolResult }).result;
      expect(result.content).toBe(largeRssSummary);
      expect(result.metadata?.observationId).toBeUndefined();
    });

    it("工具失败后应允许同工具的修正参数重试", async () => {
      const sharedPrefix = "x".repeat(180);
      const firstInput = {
        action: "create",
        skillId: "online-gap-review",
        content: `${sharedPrefix}-missing-frontmatter`,
      };
      const correctedInput = {
        action: "create",
        skillId: "online-gap-review",
        content: `${sharedPrefix}-with-frontmatter`,
      };

      const firstCall: LLMStreamChunk[] = [
        {
          type: "tool_use_start",
          toolUse: { id: "tc-1", name: "skill_manage", input: "" },
        },
        {
          type: "tool_use_delta",
          toolUse: { id: "tc-1", name: "", input: JSON.stringify(firstInput) },
        },
        {
          type: "done",
          usage: { tokensIn: 10, tokensOut: 5 },
          model: "mock-model",
        },
      ];
      const correctedCall: LLMStreamChunk[] = [
        {
          type: "tool_use_start",
          toolUse: { id: "tc-2", name: "skill_manage", input: "" },
        },
        {
          type: "tool_use_delta",
          toolUse: {
            id: "tc-2",
            name: "",
            input: JSON.stringify(correctedInput),
          },
        },
        {
          type: "done",
          usage: { tokensIn: 10, tokensOut: 5 },
          model: "mock-model",
        },
      ];
      const finalChunks: LLMStreamChunk[] = [
        { type: "text", text: "已完成修正重试" },
        {
          type: "done",
          usage: { tokensIn: 20, tokensOut: 10 },
          model: "mock-model",
        },
      ];

      const testProvider = createMockProvider([
        firstCall,
        correctedCall,
        finalChunks,
      ]);
      const execute = vi
        .fn()
        .mockResolvedValueOnce({
          content: "Error: SKILL.md must start with YAML frontmatter",
          isError: true,
        })
        .mockResolvedValueOnce({ content: "created" });
      const skillManageTool: Tool = {
        name: "skill_manage",
        description: "manage skills",
        category: "builtin",
        parameters: { type: "object", properties: {} },
        execute,
      };
      const testToolRegistry = createMockToolRegistry([skillManageTool]);
      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
        config: { maxIterations: 4 },
      });

      const events = await collectEvents(
        loop.runStream("create skill", "conv-retry"),
      );

      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenNthCalledWith(1, firstInput, undefined);
      expect(execute).toHaveBeenNthCalledWith(2, correctedInput, undefined);

      const toolResults = events.filter(
        (event) => event.type === "tool_result",
      );
      expect(toolResults).toHaveLength(2);
      expect(
        (toolResults[1].data as { result: ToolResult }).result.content,
      ).toBe("created");
    });

    it("多个并发工具调用应全部执行", async () => {
      // LLM 一次返回两个工具调用
      const toolCallChunks: LLMStreamChunk[] = [
        {
          type: "tool_use_start",
          toolUse: { id: "tc-1", name: "tool_a", input: "" },
        },
        {
          type: "tool_use_delta",
          toolUse: { id: "tc-1", name: "", input: '{"x":1}' },
        },
        {
          type: "tool_use_start",
          toolUse: { id: "tc-2", name: "tool_b", input: "" },
        },
        {
          type: "tool_use_delta",
          toolUse: { id: "tc-2", name: "", input: '{"y":2}' },
        },
        {
          type: "done",
          usage: { tokensIn: 20, tokensOut: 10 },
          model: "mock-model",
        },
      ];

      const finalChunks: LLMStreamChunk[] = [
        { type: "text", text: "两个工具都完成了" },
        {
          type: "done",
          usage: { tokensIn: 40, tokensOut: 15 },
          model: "mock-model",
        },
      ];

      const testProvider = createMockProvider([toolCallChunks, finalChunks]);

      const toolA = createMockTool("tool_a", { content: "result A" });
      const toolB = createMockTool("tool_b", { content: "result B" });
      const testToolRegistry = createMockToolRegistry([toolA, toolB]);

      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
      });

      const events = await collectEvents(loop.runStream("do both", "conv-5"));

      // 两个工具都应被调用
      expect(toolA.execute).toHaveBeenCalledTimes(1);
      expect(toolB.execute).toHaveBeenCalledTimes(1);

      // 应产生 2 个 tool_call 和 2 个 tool_result 事件
      const toolCallEvents = events.filter((e) => e.type === "tool_call");
      const toolResultEvents = events.filter((e) => e.type === "tool_result");
      expect(toolCallEvents).toHaveLength(2);
      expect(toolResultEvents).toHaveLength(2);
    });
  });

  // ── stop() 中止测试 ──

  describe("中止循环", () => {
    it("调用 stop() 后应终止循环", async () => {
      const loop = new SimpleAgentLoop({
        provider,
        toolRegistry,
        contextManager,
        memoryStore,
      });

      // 直接停止
      loop.stop();
      expect(loop.state).toBe("idle");
    });
  });

  // ── 事件监听器测试 ──

  describe("事件监听器", () => {
    it("on() 应注册监听器并通过 state_change 事件通知", async () => {
      const loop = new SimpleAgentLoop({
        provider,
        toolRegistry,
        contextManager,
        memoryStore,
      });

      const receivedEvents: AgentEvent[] = [];
      const unsubscribe = loop.on((event) => receivedEvents.push(event));

      await collectEvents(loop.runStream("hi", "conv-6"));

      // 应收到 state_change 事件
      const stateChanges = receivedEvents.filter(
        (e) => e.type === "state_change",
      );
      expect(stateChanges.length).toBeGreaterThan(0);

      // 取消订阅后不应再收到事件
      const countBefore = receivedEvents.length;
      unsubscribe();

      // 再次运行，不应有新事件
      await collectEvents(loop.runStream("hi again", "conv-7"));
      expect(receivedEvents.length).toBe(countBefore);
    });
  });

  // ── Trace 持久化测试 ──

  describe("Trace 记录", () => {
    it("应在完成时持久化 trace", async () => {
      const loop = new SimpleAgentLoop({
        provider,
        toolRegistry,
        contextManager,
        memoryStore,
      });

      await collectEvents(loop.runStream("hello", "conv-8"));

      expect(memoryStore.addTrace).toHaveBeenCalledTimes(1);
      const trace = (memoryStore.addTrace as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(trace.conversationId).toBe("conv-8");
      expect(trace.tokensIn).toBe(50);
      expect(trace.tokensOut).toBe(20);
      expect(trace.model).toBe("mock-model");
      expect(trace.steps.length).toBeGreaterThan(0);
    });
  });

  // ── 连续错误停止测试 ──

  describe("连续错误自动停止", () => {
    it("连续 3 轮全部工具报错后应提前停止", async () => {
      // 每轮都调用一个工具，工具每次返回错误
      const toolCallChunks: LLMStreamChunk[] = [
        {
          type: "tool_use_start",
          toolUse: { id: "tc-1", name: "buggy_tool", input: "" },
        },
        {
          type: "tool_use_delta",
          toolUse: { id: "tc-1", name: "", input: "{}" },
        },
        {
          type: "done",
          usage: { tokensIn: 5, tokensOut: 3 },
          model: "mock-model",
        },
      ];

      // 提供 10 轮相同的 chunks（但应在第 3 轮后停止）
      const allChunks = Array(10).fill(toolCallChunks);
      const testProvider = createMockProvider(allChunks);

      const buggyTool = createMockTool("buggy_tool", {
        content: "error!",
        isError: true,
      });
      const testToolRegistry = createMockToolRegistry([buggyTool]);

      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
        config: { maxIterations: 10 },
      });

      const events = await collectEvents(loop.runStream("go", "conv-9"));

      // 重复调用保护会优先拦截后续相同失败调用，避免反复执行同一个坏工具
      expect(buggyTool.execute).toHaveBeenCalledTimes(1);

      // 应有 response_complete
      const completeEvent = events.find((e) => e.type === "response_complete");
      expect(completeEvent).toBeDefined();
    });
    it("终端工具失败应立即停止，不再让 LLM 反复自救", async () => {
      const toolCallChunks: LLMStreamChunk[] = [
        {
          type: "tool_use_start",
          toolUse: { id: "tc-1", name: "delegate_tool", input: "" },
        },
        {
          type: "tool_use_delta",
          toolUse: { id: "tc-1", name: "", input: "{}" },
        },
        {
          type: "done",
          usage: { tokensIn: 10, tokensOut: 5 },
          model: "mock-model",
        },
      ];
      const testProvider = createMockProvider([
        toolCallChunks,
        toolCallChunks,
        toolCallChunks,
      ]);
      const delegateTool = createMockTool("delegate_tool", {
        content: "外部委托工具不可用：claude 和 codex 都无法启动。",
        isError: true,
        metadata: { terminal: true, reason: "delegate_unavailable" },
      });
      const testToolRegistry = createMockToolRegistry([delegateTool]);

      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
        config: { maxIterations: 5 },
      });

      const events = await collectEvents(
        loop.runStream("写代码", "conv-terminal"),
      );

      expect(testProvider.stream).toHaveBeenCalledTimes(1);
      expect(delegateTool.execute).toHaveBeenCalledTimes(1);
      const completeEvent = events.find((e) => e.type === "response_complete");
      expect(completeEvent).toBeDefined();
      const message = (completeEvent!.data as { message: Message }).message;
      expect(String(message.content)).toContain("外部委托工具不可用");
      expect(memoryStore.addTrace).toHaveBeenCalledWith(
        expect.objectContaining({ error: "terminal_tool_failure" }),
      );
    });

    it("达到全局工具调用上限后下一轮必须清空工具定义并强制合成", async () => {
      const firstRoundChunks: LLMStreamChunk[] = [];
      for (let i = 0; i < 41; i++) {
        firstRoundChunks.push(
          {
            type: "tool_use_start",
            toolUse: { id: `tc-${i}`, name: "probe_tool", input: "" },
          },
          {
            type: "tool_use_delta",
            toolUse: {
              id: `tc-${i}`,
              name: "",
              input: JSON.stringify({ index: i }),
            },
          },
        );
      }
      firstRoundChunks.push({
        type: "done",
        usage: { tokensIn: 10, tokensOut: 5 },
        model: "mock-model",
      });

      const capturedTools: string[][] = [];
      let callIndex = 0;
      const testProvider: LLMProvider = {
        name: "budget-provider",
        models: [
          {
            id: "mock-model",
            provider: "mock",
            name: "Mock",
            tier: "fast",
            contextWindow: 4096,
            supportsTools: true,
            supportsStreaming: true,
          },
        ] as ModelInfo[],
        chat: vi.fn(),
        stream: vi.fn(async function* (request: LLMRequest) {
          capturedTools.push((request.tools ?? []).map((tool) => tool.name));
          if (callIndex === 0) {
            callIndex++;
            yield* firstRoundChunks;
            return;
          }
          callIndex++;
          yield {
            type: "tool_use_start",
            toolUse: { id: "tc-after-limit", name: "probe_tool", input: "" },
          } as LLMStreamChunk;
          yield {
            type: "tool_use_delta",
            toolUse: {
              id: "tc-after-limit",
              name: "",
              input: JSON.stringify({ index: 999 }),
            },
          } as LLMStreamChunk;
          yield {
            type: "done",
            usage: { tokensIn: 10, tokensOut: 5 },
            model: "mock-model",
          } as LLMStreamChunk;
        }) as unknown as LLMProvider["stream"],
      };
      const probeTool = createMockTool("probe_tool", { content: "ok" });
      const testToolRegistry = createMockToolRegistry([probeTool]);
      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry: testToolRegistry,
        contextManager,
        memoryStore,
        config: { maxIterations: 3 },
      });

      await collectEvents(loop.runStream("probe", "conv-global-limit"));

      expect(capturedTools.length).toBeGreaterThanOrEqual(2);
      expect(capturedTools[0]).toContain("probe_tool");
      expect(capturedTools[1]).toEqual([]);
    });

    it("连续 max_tokens 且没有工具调用时应熔断，避免 687 秒空转", async () => {
      const truncatedChunks: LLMStreamChunk[] = [
        { type: "text", text: "我将创建页面，下面开始生成完整 HTML。" },
        {
          type: "done",
          usage: { tokensIn: 100, tokensOut: 8192 },
          model: "mock-model",
          stopReason: "max_tokens",
        },
      ];
      const testProvider = createMockProvider([
        truncatedChunks,
        truncatedChunks,
        truncatedChunks,
      ]);
      const continueHook = vi.fn().mockResolvedValue({
        action: "continue",
        hint: "还有未完成 todo，请继续。",
      });

      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry,
        contextManager,
        memoryStore,
        config: { maxIterations: 5, maxTokens: 8192 },
      });

      const events = await collectEvents(
        loop.runStream("生成并发布页面", "conv-max-token", {
          toolHooks: { beforeReturn: continueHook },
        }),
      );

      expect(testProvider.stream).toHaveBeenCalledTimes(2);
      expect(continueHook).toHaveBeenCalledTimes(1);
      const completeEvent = events.find((e) => e.type === "response_complete");
      expect(completeEvent).toBeDefined();
      const message = (completeEvent!.data as { message: Message }).message;
      expect(JSON.stringify(message.content)).toContain("连续 2 次输出被截断");
      expect(memoryStore.addTrace).toHaveBeenCalledWith(
        expect.objectContaining({ error: "llm_max_tokens_stalled" }),
      );
    });

    it("max_tokens with empty output should be saved as a trace error", async () => {
      const truncatedChunks: LLMStreamChunk[] = [
        {
          type: "done",
          usage: { tokensIn: 100, tokensOut: 8192 },
          model: "mock-model",
          stopReason: "max_tokens",
        },
      ];
      const testProvider = createMockProvider([truncatedChunks]);

      const loop = new SimpleAgentLoop({
        provider: testProvider,
        toolRegistry,
        contextManager,
        memoryStore,
        config: { maxIterations: 5, maxTokens: 8192 },
      });

      const events = await collectEvents(
        loop.runStream("生成并发布页面", "conv-max-token-empty"),
      );

      const completeEvent = events.find((e) => e.type === "response_complete");
      expect(completeEvent).toBeDefined();
      const message = (completeEvent!.data as { message: Message }).message;
      expect(JSON.stringify(message.content)).toContain("max_tokens");
      expect(memoryStore.addTrace).toHaveBeenCalledWith(
        expect.objectContaining({ error: "llm_max_tokens_truncated" }),
      );
    });
  });
});
