import { initDatabase, SQLiteMemoryStore } from "../packages/memory/src/index.ts";
import { MemoryExtractor } from "../packages/core/src/memory-extractor.ts";
import * as orchestratorModule from "../packages/core/src/orchestrator.ts";
import { SimpleContextManager } from "../packages/core/src/context-manager.ts";
import { SimpleAgentLoop } from "../packages/core/src/agent-loop.ts";
import type {
  AgentEvent,
  ConversationTurn,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  MemoryEntry,
  Message,
  ModelInfo,
  Tool,
  ToolExecutionContext,
  ToolResult,
} from "@agentclaw/types";

const versionLabel =
  process.argv.find((arg) => arg.startsWith("--label="))?.slice("--label=".length) ??
  "current";

function createProvider(responses: string[]): LLMProvider {
  return {
    name: "memory-eval-provider",
    models: [
      {
        id: "memory-eval-model",
        provider: "mock",
        name: "Memory Eval",
        tier: "fast",
        contextWindow: 4096,
        supportsTools: true,
        supportsStreaming: true,
      },
    ] as ModelInfo[],
    chat: async () =>
      ({
        message: {
          id: "memory-eval-message",
          role: "assistant",
          content: responses.shift() ?? "[]",
          createdAt: new Date(),
        },
        model: "memory-eval-model",
        tokensIn: 10,
        tokensOut: 5,
        stopReason: "end_turn",
      }) as LLMResponse,
    stream: async function* () {},
  };
}

function createToolCallChunks(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): LLMStreamChunk[] {
  return [
    { type: "tool_use_start", toolUse: { id, name, input: "" } },
    {
      type: "tool_use_delta",
      toolUse: { id, name: "", input: JSON.stringify(input) },
    },
    { type: "done", usage: { tokensIn: 10, tokensOut: 5 }, model: "mock-model" },
  ] as LLMStreamChunk[];
}

const finalChunks: LLMStreamChunk[] = [
  { type: "text", text: "done" } as LLMStreamChunk,
  {
    type: "done",
    usage: { tokensIn: 20, tokensOut: 10 },
    model: "mock-model",
  } as LLMStreamChunk,
];

async function collectEvents(
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function hasMemoryUsageTable(db: ReturnType<typeof initDatabase>): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_usage'",
    )
    .get() as { name?: string } | undefined;
  return row?.name === "memory_usage";
}

async function runOffloadCanvasScenario(): Promise<{
  activeHint: boolean;
  canvas: boolean;
}> {
  const db = initDatabase(":memory:");
  const store = new SQLiteMemoryStore(db);
  const capturedMessages: Message[][] = [];
  let callIndex = 0;
  const provider: LLMProvider = {
    ...createProvider([]),
    stream: async function* (request: LLMRequest) {
      capturedMessages.push(request.messages);
      const chunks =
        callIndex === 0
          ? createToolCallChunks("tc-long", "web_fetch", {
              url: "https://example.test/long",
            })
          : finalChunks;
      callIndex++;
      for (const chunk of chunks) yield chunk;
    },
  };
  const longContent = `${"important result line\n".repeat(700)}tail`;
  const tool: Tool = {
    name: "web_fetch",
    description: "fetch a large page",
    parameters: { type: "object", properties: {} },
    execute: async (): Promise<ToolResult> => ({ content: longContent }),
  };
  const toolRegistry = {
    register: () => undefined,
    unregister: () => undefined,
    get: (name: string) => (name === "web_fetch" ? tool : undefined),
    list: () => [tool],
    definitions: () => [
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    ],
    execute: async (
      name: string,
      input: Record<string, unknown>,
      context?: ToolExecutionContext,
    ) => {
      if (name !== "web_fetch") return { content: "missing", isError: true };
      return tool.execute(input, context);
    },
  };
  const contextManager = {
    buildContext: async () => ({
      systemPrompt: "system",
      messages: [
        {
          id: "user-offload",
          role: "user",
          content: "fetch long page",
          createdAt: new Date(),
        },
      ] as Message[],
    }),
  };
  const loop = new SimpleAgentLoop({
    provider,
    toolRegistry: toolRegistry as never,
    contextManager,
    memoryStore: store,
    config: { maxIterations: 3 },
  });

  await collectEvents(loop.runStream("fetch long page", "conv-offload"));
  const secondPrompt = JSON.stringify(capturedMessages[1] ?? []);
  db.close();
  return {
    activeHint: secondPrompt.includes("<active_tool_offload "),
    canvas: secondPrompt.includes("<active_tool_offload_canvas>"),
  };
}

const db = initDatabase(":memory:");
const store = new SQLiteMemoryStore(db);
const namespace = "memory-10-case-eval";

const oldMemory = await store.add(
  {
    type: "preference",
    content: "用户 PPTX 偏好深色背景。",
    importance: 0.86,
    metadata: {
      layer: "L1",
      source: "conversation",
      conversationId: "conv-old",
      sceneName: "PPTX delivery",
      confidence: 0.9,
    },
  },
  namespace,
);

const turn: ConversationTurn = {
  id: "turn-new-pref",
  conversationId: "conv-memory-eval",
  role: "user",
  content: "以后 PPTX 不要深色背景，改成白底和蓝色强调。交付前必须先验收预览图。",
  createdAt: new Date("2026-05-15T10:00:00.000Z"),
};
await store.addTurn("conv-memory-eval", turn);

const extractor = new MemoryExtractor({
  provider: createProvider([
    JSON.stringify([
      {
        type: "preference",
        content: "用户以后 PPTX 不要深色背景，改成白底和蓝色强调。",
        importance: 0.92,
        scene_name: "PPTX delivery",
        confidence: 0.94,
      },
      {
        type: "preference",
        content: "用户要求 PPTX 交付前必须先验收预览图。",
        importance: 0.9,
        scene_name: "PPTX delivery",
        confidence: 0.92,
      },
    ]),
  ]),
  memoryStore: store,
});

const stored = await extractor.processConversation(
  "conv-memory-eval",
  10,
  namespace,
);
const oldAfter = await store.get(oldMemory.id);
const activeSearch = await store.search({
  query: "PPTX 深色 白底 预览",
  limit: 20,
  namespace,
});
const activeMemories = activeSearch.map((result) => result.entry);
const newMemory = activeMemories.find((memory) =>
  memory.metadata?.layer === "L1" &&
  memory.content.includes("白底和蓝色强调"),
);

const consolidate =
  "consolidateLayeredMemories" in extractor &&
  typeof (extractor as unknown as { consolidateLayeredMemories?: unknown })
    .consolidateLayeredMemories === "function"
    ? await (
        extractor as unknown as {
          consolidateLayeredMemories: (namespace?: string) => Promise<unknown>;
        }
      ).consolidateLayeredMemories(namespace)
    : null;

const afterLayering = await store.search({
  query: "PPTX 交付 预览 白底",
  limit: 50,
  namespace,
});
const entries = afterLayering.map((result) => result.entry);
const l2 = entries.find((entry) => entry.metadata?.layer === "L2");
const l3 = entries.find((entry) => entry.metadata?.layer === "L3");

const manager = new SimpleContextManager({
  systemPrompt: "system",
  memoryStore: store,
});
const context = await manager.buildContext("conv-context-eval", "帮我做一个 PPTX", {
  memoryNamespace: namespace,
});

const usageCount = hasMemoryUsageTable(db)
  ? (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_usage WHERE conversation_id = ?",
        )
        .get("conv-context-eval") as { count: number }
    ).count
  : 0;

const shouldRun =
  typeof (
    orchestratorModule as unknown as {
      shouldRunMemoryExtraction?: (
        turnCount: number,
        lastExtractionAt?: Date,
        now?: Date,
      ) => boolean;
    }
  ).shouldRunMemoryExtraction === "function"
    ? (
        orchestratorModule as unknown as {
          shouldRunMemoryExtraction: (
            turnCount: number,
            lastExtractionAt?: Date,
            now?: Date,
          ) => boolean;
        }
      ).shouldRunMemoryExtraction
    : undefined;

const triggerChecks = shouldRun
  ? [
      shouldRun(1),
      shouldRun(2, new Date("2026-05-15T10:00:00.000Z")),
      !shouldRun(3, new Date("2026-05-15T10:00:00.000Z")),
      shouldRun(4, new Date("2026-05-15T10:00:00.000Z")),
      shouldRun(8, new Date("2026-05-15T10:00:00.000Z")),
      shouldRun(
        5,
        new Date("2026-05-15T09:49:00.000Z"),
        new Date("2026-05-15T10:00:00.000Z"),
      ),
    ]
  : [];

const offload = await runOffloadCanvasScenario();

function evidenceIds(entry: MemoryEntry | undefined): string[] {
  const ids = entry?.metadata?.sourceMemoryIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}

const cases = [
  {
    id: "case-01-conflict-deprecates-old",
    passed: oldAfter?.metadata?.status === "deprecated",
    value: oldAfter?.metadata?.status ?? "active",
  },
  {
    id: "case-02-deprecated-hidden-from-search",
    passed: !activeMemories.some((memory) => memory.id === oldMemory.id),
    value: activeMemories.map((memory) => memory.id),
  },
  {
    id: "case-03-new-memory-supersedes-old",
    passed: Array.isArray(newMemory?.metadata?.supersedes)
      ? newMemory.metadata.supersedes.includes(oldMemory.id)
      : false,
    value: newMemory?.metadata?.supersedes ?? [],
  },
  {
    id: "case-04-l2-scene-created",
    passed: Boolean(l2),
    value: l2?.content.slice(0, 120) ?? null,
  },
  {
    id: "case-05-l2-evidence-chain",
    passed: evidenceIds(l2).length >= 2,
    value: evidenceIds(l2),
  },
  {
    id: "case-06-l3-persona-created",
    passed: Boolean(l3),
    value: l3?.content.slice(0, 120) ?? null,
  },
  {
    id: "case-07-l3-evidence-chain",
    passed: evidenceIds(l3).length >= 2,
    value: evidenceIds(l3),
  },
  {
    id: "case-08-layered-prompt-injection",
    passed:
      context.systemPrompt.includes("layer:L2") ||
      context.systemPrompt.includes("layer:L3"),
    value: {
      hasL2: context.systemPrompt.includes("layer:L2"),
      hasL3: context.systemPrompt.includes("layer:L3"),
      chars: context.systemPrompt.length,
    },
  },
  {
    id: "case-09-memory-usage-telemetry",
    passed: usageCount > 0,
    value: usageCount,
  },
  {
    id: "case-10-offload-symbolic-canvas",
    passed: offload.canvas,
    value: offload,
  },
  {
    id: "support-trigger-policy",
    passed: triggerChecks.length === 6 && triggerChecks.every(Boolean),
    value: triggerChecks,
    support: true,
  },
];

const primaryCases = cases.filter((item) => !item.support);
const passed = primaryCases.filter((item) => item.passed).length;

console.log(
  JSON.stringify(
    {
      label: versionLabel,
      stored,
      consolidate,
      passed,
      total: primaryCases.length,
      passRate: passed / primaryCases.length,
      cases,
    },
    null,
    2,
  ),
);

db.close();
