import { initDatabase, SQLiteMemoryStore } from "../packages/memory/src/index.ts";
import { MemoryExtractor } from "../packages/core/src/memory-extractor.ts";
import { SimpleContextManager } from "../packages/core/src/context-manager.ts";
import type {
  ConversationTurn,
  LLMProvider,
  LLMResponse,
  ModelInfo,
} from "@agentclaw/types";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function createProvider(responses: string[]): LLMProvider {
  return {
    name: "memory-regression-provider",
    models: [
      {
        id: "memory-regression-model",
        provider: "mock",
        name: "Memory Regression",
        tier: "fast",
        contextWindow: 4096,
        supportsTools: false,
        supportsStreaming: false,
      },
    ] as ModelInfo[],
    chat: async () =>
      ({
        message: {
          id: "memory-regression-message",
          role: "assistant",
          content: responses.shift() ?? "[]",
          createdAt: new Date(),
        },
        model: "memory-regression-model",
        tokensIn: 10,
        tokensOut: 5,
        stopReason: "end_turn",
      }) as LLMResponse,
    stream: async function* () {},
  };
}

const db = initDatabase(":memory:");
const store = new SQLiteMemoryStore(db);
const namespace = "memory-regression";

const old = await store.add(
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

const turns: ConversationTurn[] = [
  {
    id: "turn-new-pref",
    conversationId: "conv-memory-regression",
    role: "user",
    content: "以后 PPTX 不要深色背景，改成白底和蓝色强调。交付前必须先验收预览图。",
    createdAt: new Date("2026-05-15T10:00:00.000Z"),
  },
];
await store.addTurn("conv-memory-regression", turns[0]);

const provider = createProvider([
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
]);
const extractor = new MemoryExtractor({ provider, memoryStore: store });

const stored = await extractor.processConversation(
  "conv-memory-regression",
  10,
  namespace,
);
assert(stored >= 1, "scenario 1 failed: no L1 memory stored");

const oldAfter = await store.get(old.id);
assert(
  oldAfter?.metadata?.status === "deprecated",
  "scenario 1 failed: old conflicting memory was not deprecated",
);

const layered = await extractor.consolidateLayeredMemories(namespace);
assert(
  layered.l2Created + layered.l2Updated >= 1,
  "scenario 2 failed: L2 scene aggregate was not created or updated",
);
assert(
  layered.l3Created + layered.l3Updated >= 1,
  "scenario 3 failed: L3 persona aggregate was not created or updated",
);

const manager = new SimpleContextManager({
  systemPrompt: "system",
  memoryStore: store,
});
const context = await manager.buildContext(
  "conv-context-regression",
  "帮我做一个 PPTX",
  { memoryNamespace: namespace },
);
assert(
  context.systemPrompt.includes("layer:L2") ||
    context.systemPrompt.includes("layer:L3"),
  "scenario 4 failed: layered memory was not injected into prompt",
);

const usageCount = (
  db
    .prepare("SELECT COUNT(*) AS count FROM memory_usage WHERE conversation_id = ?")
    .get("conv-context-regression") as { count: number }
).count;
assert(usageCount > 0, "scenario 4 failed: memory usage telemetry missing");

console.log(
  JSON.stringify(
    {
      passed: true,
      scenarios: [
        "conflicting L1 preference deprecates old memory",
        "L2 scene aggregate created/updated with evidence",
        "L3 persona aggregate created/updated with evidence",
        "layered recall injects prompt memory and records telemetry",
      ],
      stored,
      layered,
      usageCount,
    },
    null,
    2,
  ),
);
