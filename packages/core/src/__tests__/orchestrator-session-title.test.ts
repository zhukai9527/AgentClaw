import { describe, expect, it, vi } from "vitest";
import { SimpleOrchestrator } from "../orchestrator.js";
import type {
  AgentEvent,
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  MemoryStore,
  ModelInfo,
  SessionData,
} from "@agentclaw/types";
import type { ToolRegistryImpl } from "@agentclaw/tools";

function createProvider(): LLMProvider {
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
        content: "response",
        createdAt: new Date(),
      },
      model: "mock-model",
      tokensIn: 10,
      tokensOut: 5,
      stopReason: "end_turn",
    } as LLMResponse),
    stream: vi.fn(async function* () {
      yield { type: "text", text: "assistant response" } as LLMStreamChunk;
      yield {
        type: "done",
        usage: { tokensIn: 10, tokensOut: 5 },
        model: "mock-model",
      } as LLMStreamChunk;
    }) as unknown as LLMProvider["stream"],
  };
}

function createToolRegistry(): ToolRegistryImpl {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    definitions: vi.fn().mockReturnValue([]),
    execute: vi.fn().mockResolvedValue({ content: "ok" }),
  } as unknown as ToolRegistryImpl;
}

function createMemoryStore(): MemoryStore {
  const sessions = new Map<string, SessionData>();
  return {
    add: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    update: vi.fn(),
    findSimilar: vi.fn().mockResolvedValue(null),
    delete: vi.fn(),
    addTurn: vi.fn(),
    getHistory: vi.fn().mockResolvedValue([]),
    saveSession: vi.fn(async (session: SessionData) => {
      sessions.set(session.id, { ...session });
    }),
    getSessionById: vi.fn(async (id: string) => sessions.get(id) ?? null),
    listSessions: vi.fn(async () => Array.from(sessions.values())),
    deleteSession: vi.fn(async (id: string) => {
      sessions.delete(id);
    }),
    addTrace: vi.fn(),
    getTrace: vi.fn().mockResolvedValue(null),
    getTraces: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  } as unknown as MemoryStore;
}

async function collectEvents(
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("SimpleOrchestrator session title updates", () => {
  it("keeps cache and storage in sync when a session is updated", async () => {
    const orchestrator = new SimpleOrchestrator({
      provider: createProvider(),
      toolRegistry: createToolRegistry(),
      memoryStore: createMemoryStore(),
      systemPrompt: "test",
    });
    const session = await orchestrator.createSession();

    const updated = await orchestrator.updateSession(session.id, {
      title: "Manual title",
      status: "done",
      projectId: "project-1",
    });

    expect(updated?.title).toBe("Manual title");
    expect(updated?.status).toBe("done");
    expect(updated?.projectId).toBe("project-1");
    await expect(orchestrator.getSession(session.id)).resolves.toMatchObject({
      title: "Manual title",
      status: "done",
      projectId: "project-1",
    });
  });

  it("does not let async auto-title overwrite a manual title", async () => {
    let streamCalls = 0;
    const provider = {
      ...createProvider(),
      stream: vi.fn(async function* () {
        streamCalls++;
        if (streamCalls === 1) {
          yield { type: "text", text: "assistant response" } as LLMStreamChunk;
          yield {
            type: "done",
            usage: { tokensIn: 10, tokensOut: 5 },
            model: "mock-model",
          } as LLMStreamChunk;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield { type: "text", text: "Auto title" } as LLMStreamChunk;
        yield {
          type: "done",
          usage: { tokensIn: 1, tokensOut: 1 },
          model: "mock-model",
        } as LLMStreamChunk;
      }) as unknown as LLMProvider["stream"],
    };
    const orchestrator = new SimpleOrchestrator({
      provider,
      toolRegistry: createToolRegistry(),
      memoryStore: createMemoryStore(),
      systemPrompt: "test",
    });
    const session = await orchestrator.createSession();

    await collectEvents(
      orchestrator.processInputStream(
        session.id,
        "please create a detailed project roadmap",
      ),
    );
    await orchestrator.updateSession(session.id, {
      title: "Manual title",
      metadata: { titleSource: "manual" },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await expect(orchestrator.getSession(session.id)).resolves.toMatchObject({
      title: "Manual title",
    });
  });
});
