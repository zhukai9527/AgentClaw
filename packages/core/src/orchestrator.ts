import type {
  Orchestrator,
  Session,
  Message,
  ContentBlock,
  AgentEvent,
  ToolExecutionContext,
  LLMProvider,
  MemoryStore,
  AgentConfig,
  AgentProfile,
} from "@agentclaw/types";
import {
  type ToolRegistryImpl,
  createKnowledgeSourceTools,
  createFileRagTools,
} from "@agentclaw/tools";
import type { SkillRegistryImpl } from "./skills/registry.js";
import { generateId } from "@agentclaw/providers";
import { SimpleAgentLoop, IterationBudget } from "./agent-loop.js";
import { SimpleContextManager } from "./context-manager.js";
import { MemoryExtractor } from "./memory-extractor.js";
import { SimpleSubAgentManager } from "./subagent-manager.js";
import { ToolHookManager } from "./tool-hooks.js";
import { readdirSync, unlinkSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LRUCache } from "lru-cache";

/** How many user turns between automatic memory extraction runs */
const EXTRACT_EVERY_N_TURNS = 8;

export class SimpleOrchestrator implements Orchestrator {
  private sessions = new LRUCache<string, Session>({ max: 10000 });
  private turnCounters = new LRUCache<string, number>({ max: 10000 });
  private activeLoops = new Map<string, SimpleAgentLoop>();
  private provider: LLMProvider;
  private visionProvider?: LLMProvider;
  private fastProvider?: LLMProvider;
  private toolRegistry: ToolRegistryImpl;
  private allToolNames: Set<string>;
  private memoryStore: MemoryStore;
  private memoryExtractor: MemoryExtractor;
  private agentConfig?: Partial<AgentConfig>;
  private systemPrompt?: string;
  private scheduler?: ToolExecutionContext["scheduler"];
  private skillRegistry?: SkillRegistryImpl;
  private tmpDir?: string;
  private agents: Map<string, AgentProfile>;
  private disabledTools?: Set<string>;
  /** Optional callback for LLM errors — wired to SmartRouter.reportError in gateway */
  private onLLMError?: (
    providerName: string,
    modelId: string,
    error: unknown,
  ) => { retryable: boolean };

  constructor(options: {
    provider: LLMProvider;
    visionProvider?: LLMProvider;
    fastProvider?: LLMProvider;
    toolRegistry: ToolRegistryImpl;
    memoryStore: MemoryStore;
    agentConfig?: Partial<AgentConfig>;
    systemPrompt?: string;
    scheduler?: ToolExecutionContext["scheduler"];
    skillRegistry?: SkillRegistryImpl;
    tmpDir?: string;
    agents?: AgentProfile[];
    disabledTools?: string[];
    /** Report LLM errors to router for classification & cooldown */
    onLLMError?: (
      providerName: string,
      modelId: string,
      error: unknown,
    ) => { retryable: boolean };
  }) {
    this.provider = options.provider;
    this.visionProvider = options.visionProvider;
    this.fastProvider = options.fastProvider;
    this.toolRegistry = options.toolRegistry;
    this.allToolNames = new Set(options.toolRegistry.list().map((t) => t.name));
    this.memoryStore = options.memoryStore;
    this.memoryExtractor = new MemoryExtractor({
      provider: options.provider,
      memoryStore: options.memoryStore,
    });
    this.agentConfig = options.agentConfig;
    this.systemPrompt = options.systemPrompt;
    this.scheduler = options.scheduler;
    this.skillRegistry = options.skillRegistry;
    this.tmpDir = options.tmpDir;
    this.agents = new Map((options.agents ?? []).map((a) => [a.id, a]));
    this.disabledTools = options.disabledTools?.length
      ? new Set(options.disabledTools)
      : undefined;
    this.onLLMError = options.onLLMError;
  }

  setDisabledTools(tools: string[]): void {
    this.disabledTools = tools.length ? new Set(tools) : undefined;
  }

  async createSession(metadata?: Record<string, unknown>): Promise<Session> {
    const session: Session = {
      id: generateId(),
      conversationId: generateId(),
      createdAt: new Date(),
      lastActiveAt: new Date(),
      metadata,
    };
    this.sessions.set(session.id, session);
    await this.memoryStore.saveSession(session);
    return session;
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    // 先查内存缓存
    let session = this.sessions.get(sessionId);
    if (session) return session;
    const stored = await this.memoryStore.getSessionById(sessionId);
    if (stored) {
      session = {
        id: stored.id,
        conversationId: stored.conversationId,
        createdAt: stored.createdAt,
        lastActiveAt: stored.lastActiveAt,
        title: stored.title,
        metadata: stored.metadata,
      };
      this.sessions.set(sessionId, session);
      return session;
    }
    return undefined;
  }

  async processInput(
    sessionId: string,
    input: string | ContentBlock[],
    context?: ToolExecutionContext,
  ): Promise<Message> {
    let lastMessage: Message | undefined;
    for await (const event of this.processInputStream(
      sessionId,
      input,
      context,
    )) {
      if (event.type === "response_complete") {
        lastMessage = (event.data as { message: Message }).message;
      }
    }
    if (!lastMessage) {
      throw new Error("No response generated");
    }
    return lastMessage;
  }

  async *processInputStream(
    sessionId: string,
    input: string | ContentBlock[],
    context?: ToolExecutionContext,
  ): AsyncIterable<AgentEvent> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.lastActiveAt = new Date();
    this.memoryStore.saveSession(session).catch(() => {});

    // Shared iteration budget: parent + sub-agents consume from the same pool
    const iterationBudget = new IterationBudget(
      this.agentConfig?.maxIterations ?? 25,
    );

    // Merge orchestrator-provided callbacks into the context
    const memoryStore = this.memoryStore;
    const memoryNamespace =
      (session.metadata?.memoryNamespace as string) ||
      (session.metadata?.agentId as string) ||
      "default";
    const mergedContext: ToolExecutionContext = {
      ...context,
      memoryNamespace,
      saveMemory: async (content, type) => {
        const memType = type ?? "fact";
        // Dedup: skip if a similar memory already exists (within same namespace)
        const similar = await memoryStore.findSimilar(
          content,
          memType,
          0.75,
          memoryNamespace,
        );
        if (similar) {
          if (0.8 > similar.entry.importance) {
            await memoryStore.update(similar.entry.id, { importance: 0.8 });
          }
          return;
        }
        await memoryStore.add(
          {
            type: memType,
            content,
            importance: 0.8,
          },
          memoryNamespace,
        );
      },
      searchHistory: memoryStore.searchHistory
        ? (query: string, limit?: number) =>
            memoryStore.searchHistory!(session.conversationId, query, limit)
        : undefined,
      scheduler: this.scheduler,
      skillRegistry: this.skillRegistry,
      toolHooks: (() => {
        const hm = new ToolHookManager();
        hm.registerPresetHooks();
        // Migrate: incomplete-todo guard as a BeforeReturn hook
        hm.addBeforeReturnHook(async (ctx) => {
          const unchecked = ctx.todoItems.filter((i) => !i.done);
          if (unchecked.length > 0) {
            const listing = unchecked.map((i) => `- ${i.text}`).join("\n");
            return {
              action: "continue" as const,
              hint: `<important>你还有未完成的任务：\n${listing}\n请继续完成所有任务后再回复用户。</important>`,
            };
          }
          return { action: "return" as const };
        });
        return {
          before: (call: { name: string; input: Record<string, unknown> }) =>
            hm.runBeforeHooks(call),
          after: (
            call: { name: string; input: Record<string, unknown> },
            result: import("@agentclaw/types").ToolResult,
          ) => hm.runAfterHooks(call, result),
          beforeReturn: (ctx: {
            response: string;
            runtimeHints: string[];
            todoItems: Array<{ text: string; done: boolean }>;
          }) => hm.runBeforeReturnHooks(ctx),
        };
      })(),
      subAgentManager: new SimpleSubAgentManager({
        provider: this.provider,
        toolRegistry: this.toolRegistry,
        memoryStore: this.memoryStore,
        agentConfig: this.agentConfig,
        skillRegistry: this.skillRegistry,
        parentContext: context,
        iterationBudget,
      }),
    };

    const inputHasImage = hasImage(input);
    let effectiveProvider: LLMProvider;

    if (inputHasImage && this.visionProvider) {
      effectiveProvider = this.visionProvider;
      console.log(
        `[orchestrator] Image detected → using ${effectiveProvider.name}`,
      );
    } else if (this.fastProvider && isSimpleChat(input)) {
      effectiveProvider = this.fastProvider;
      console.log(
        `[orchestrator] Simple chat → using fast provider ${effectiveProvider.name}`,
      );
    } else {
      effectiveProvider = this.provider;
    }

    let currentAgent = this.getSessionAgent(session);
    let handoffCount = 0;
    const MAX_HANDOFFS = 3;

    // Propagate channel from session metadata to context (for trace recording)
    if (session.metadata?.channel && !mergedContext.channel) {
      mergedContext.channel = session.metadata.channel as string;
    }

    // Pass available agents to tools (for handoff validation)
    // API requests (hive-api channel) are fully isolated — no handoff
    const isApiRequest = session.metadata?.channel === "hive-api";
    const agentRoster = isApiRequest
      ? []
      : Array.from(this.agents.values())
          .filter(
            (a) =>
              a.id !== (currentAgent?.id || "default") &&
              a.id !== "default" &&
              a.allowHandoff,
          )
          .map((a) => ({ id: a.id, name: a.name, description: a.description }));
    mergedContext.agents = agentRoster;

    // Pass agent metadata to context for downstream use
    mergedContext.agentId = (session.metadata?.agentId as string) || "default";
    if (currentAgent?.disabledSkills?.length) {
      mergedContext.disabledSkills = currentAgent.disabledSkills;
    }

    // Compact tool callback: force-compress conversation context on demand
    const compactContextManager = new SimpleContextManager({
      systemPrompt: this.systemPrompt,
      memoryStore: this.memoryStore,
      skillRegistry: this.skillRegistry,
      provider: this.provider,
    });
    mergedContext.compactContext = () =>
      compactContextManager.forceCompress(session.conversationId);

    let currentInput: string | ContentBlock[] = input;
    let isHandoffContinuation = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const loop = this.createAgentLoop(
        effectiveProvider,
        currentAgent,
        session.metadata,
        iterationBudget,
      );
      this.activeLoops.set(sessionId, loop);

      let handoffEvent: AgentEvent | null = null;
      try {
        for await (const event of loop.runStream(
          currentInput,
          session.conversationId,
          mergedContext,
        )) {
          if (event.type === "handoff") {
            handoffEvent = event;
            // Don't yield handoff to WS — we handle it internally and emit a notification
          } else {
            yield event;
          }
        }
      } finally {
        this.activeLoops.delete(sessionId);
      }

      // No handoff — normal completion
      if (!handoffEvent) {
        if (!isHandoffContinuation) {
          this.cleanupTmpScripts();
        }
        break;
      }

      // Handoff detected — switch agent and re-run
      handoffCount++;
      if (handoffCount > MAX_HANDOFFS) {
        yield {
          type: "error" as const,
          data: { message: "Too many handoffs (max 3). Stopping." },
          timestamp: new Date(),
        };
        break;
      }

      const handoffData = handoffEvent.data as {
        targetAgentId: string;
        reason: string;
        tokensIn?: number;
        tokensOut?: number;
        toolCallCount?: number;
        durationMs?: number;
        model?: string;
      };
      const targetAgentId = handoffData.targetAgentId;
      const targetAgent = this.agents.get(targetAgentId);

      if (!targetAgent) {
        yield {
          type: "error" as const,
          data: { message: `Handoff target "${targetAgentId}" not found` },
          timestamp: new Date(),
        };
        break;
      }

      // Update session metadata
      if (!session.metadata) session.metadata = {};
      const previousAgentId = (session.metadata.agentId as string) || "default";
      session.metadata.agentId = targetAgentId;
      await this.memoryStore.saveSession(session);

      // Notify frontend about the handoff
      yield {
        type: "handoff" as const,
        data: {
          fromAgent: previousAgentId,
          toAgent: targetAgentId,
          toAgentName: targetAgent.name,
          reason: handoffData.reason,
        },
        timestamp: new Date(),
      };

      console.log(
        `[orchestrator] Handoff: ${previousAgentId} → ${targetAgentId} (${handoffData.reason})`,
      );

      // Prepare for new agent loop
      currentAgent = targetAgent;
      isHandoffContinuation = true;
      const prevName =
        this.agents.get(previousAgentId)?.name ?? previousAgentId;
      currentInput = `[Handoff from ${prevName}: ${handoffData.reason}]\nReview the conversation history and continue. Respond directly to the user's request.`;
    }

    // Background memory extraction: on the 1st turn and every N turns after
    const count = (this.turnCounters.get(session.conversationId) ?? 0) + 1;
    this.turnCounters.set(session.conversationId, count);
    if (count === 1 || count % EXTRACT_EVERY_N_TURNS === 0) {
      this.memoryExtractor
        .processConversation(session.conversationId)
        .then((n) => {
          if (n > 0) console.log(`[memory] Extracted ${n} memories`);
        })
        .catch((err) => {
          console.error("[memory] Extraction failed:", err);
        });
    }

    if (count === 1 && session.title === undefined) {
      const rawText =
        typeof input === "string"
          ? input
          : input
              .filter(
                (b): b is { type: "text"; text: string } => b.type === "text",
              )
              .map((b) => b.text)
              .join("");
      // Set a temporary title (first 50 chars), then generate a better one via LLM
      session.title = rawText.slice(0, 50).trim() || "New Chat";
      this.memoryStore.saveSession(session).catch(() => {});
      this.generateSessionTitle(session, rawText);
    }
  }

  /**
   * Generate a concise session title via LLM (async, non-blocking).
   * Uses fastProvider if available, falls back to main provider.
   */
  private generateSessionTitle(session: Session, userText: string): void {
    const provider = this.fastProvider ?? this.provider;
    const prompt = `Generate a concise title (max 20 chars, no quotes, no punctuation at the end) for a conversation that starts with this message. Reply with ONLY the title, nothing else.\n\nMessage: ${userText.slice(0, 200)}`;
    (async () => {
      try {
        let title = "";
        for await (const chunk of provider.stream({
          messages: [
            {
              id: generateId(),
              createdAt: new Date(),
              role: "user" as const,
              content: [{ type: "text" as const, text: prompt }],
            },
          ],
          maxTokens: 30,
        })) {
          if (chunk.type === "text") title += chunk.text;
        }
        title = title.trim().replace(/^["']|["']$/g, "");
        if (title && title.length <= 30) {
          session.title = title;
          await this.memoryStore.saveSession(session);
        }
      } catch {
        // Keep the fallback title
      }
    })();
  }

  async listSessions(): Promise<Session[]> {
    // 优先从 SQLite 获取完整列表
    try {
      const stored = await this.memoryStore.listSessions();
      if (stored.length > 0) return stored;
    } catch {}
    return Array.from(this.sessions.values());
  }

  /** Return IDs of sessions that have an active agent loop running */
  getActiveSessionIds(): string[] {
    return Array.from(this.activeLoops.keys());
  }

  stopSession(sessionId: string): boolean {
    const loop = this.activeLoops.get(sessionId);
    if (loop) {
      loop.stop();
      return true;
    }
    return false;
  }

  async closeSession(sessionId: string): Promise<void> {
    // Grab conversationId before deleting (tmp dir uses conversationId, not sessionId)
    const session =
      this.sessions.get(sessionId) ??
      (await this.memoryStore.getSessionById(sessionId));
    const convId = session?.conversationId;

    // Stop any running agent loop first (kills child processes like claude_code)
    this.stopSession(sessionId);
    this.sessions.delete(sessionId);
    await this.memoryStore.deleteSession(sessionId);

    // Clean up per-session temp directory (data/tmp/{conversationId}/)
    if (convId) {
      const tmpDir = join(process.cwd(), "data", "tmp", convId);
      if (existsSync(tmpDir)) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
          console.error(`[orchestrator] Failed to clean up ${tmpDir}:`, e);
        }
      }
    }
  }

  setModel(model: string): void {
    if (!this.agentConfig) this.agentConfig = {};
    this.agentConfig.model = model;
  }

  setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  /** 更新系统提示词（用于健康检查等动态内容刷新） */
  updateSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /** 更新 agent 配置（用于管理页面 CRUD 后刷新） */
  updateAgents(agentList: AgentProfile[]): void {
    this.agents = new Map(agentList.map((a) => [a.id, a]));
  }

  /** Remove *.py temp scripts from tmpDir (fire-and-forget) */
  private cleanupTmpScripts(): void {
    if (!this.tmpDir) return;
    const tmpDir = this.tmpDir;
    try {
      const entries = readdirSync(tmpDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(tmpDir, entry.name);
        if (entry.isFile() && entry.name.endsWith(".py")) {
          try {
            unlinkSync(fullPath);
          } catch {}
        } else if (entry.isDirectory()) {
          try {
            const subFiles = readdirSync(fullPath);
            for (const f of subFiles) {
              if (f.endsWith(".py")) {
                try {
                  unlinkSync(join(fullPath, f));
                } catch {}
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  /** Resolve the agent profile for a session */
  private getSessionAgent(session: Session): AgentProfile | undefined {
    const agentId = session.metadata?.agentId as string | undefined;
    if (!agentId || agentId === "default") return undefined;
    return this.agents.get(agentId);
  }

  private createAgentLoop(
    provider?: LLMProvider,
    agent?: AgentProfile,
    sessionMetadata?: Record<string, unknown>,
    iterationBudget?: IterationBudget,
  ): SimpleAgentLoop {
    const effectiveProvider = provider ?? this.provider;

    // Resolve system prompt: inject agent's soul
    let systemPrompt = this.systemPrompt;
    const soul = agent?.soul ?? this.agents.get("default")?.soul ?? "";
    if (systemPrompt?.includes("{{soul}}")) {
      systemPrompt = systemPrompt.replace("{{soul}}", soul);
    } else if (soul && systemPrompt) {
      // No {{soul}} placeholder — prepend soul to system prompt
      systemPrompt = `${soul}\n\n${systemPrompt}`;
    }

    // Resolve platform hint for channel-specific formatting guidance
    if (systemPrompt) {
      const platformHint = (sessionMetadata?.platformHint as string) ?? "";
      systemPrompt = systemPrompt.replace("{{platformHint}}", platformHint);
      // Handle {{#if platformHint}}...{{/if}} conditional
      systemPrompt = systemPrompt.replace(
        /\{\{#if platformHint\}\}(.*?)\{\{\/if\}\}/gs,
        (_, content) => (platformHint ? content : ""),
      );
    }

    // Inject agent roster for handoff awareness
    // API requests are fully isolated — no handoff; others see allowHandoff agents
    const isApiChannel = sessionMetadata?.channel === "hive-api";
    if (!isApiChannel && systemPrompt) {
      const currentId = agent?.id || "default";
      const roster = Array.from(this.agents.values())
        .filter(
          (a) => a.id !== currentId && a.id !== "default" && a.allowHandoff,
        )
        .map((a) => `- ${a.id}: ${a.name} — ${a.description}`)
        .join("\n");
      if (roster) {
        systemPrompt += `\n\n## Handoff\nWhen the user's request is better suited for a specialist, use the \`handoff\` tool.\nAvailable agents:\n${roster}`;
      }
    }

    // Derive token budget from provider's context window (use 60% headroom)
    const modelContextWindow =
      this.provider.models?.[0]?.contextWindow ?? 128_000;
    const contextManager = new SimpleContextManager({
      systemPrompt,
      memoryStore: this.memoryStore,
      skillRegistry: this.skillRegistry,
      provider: this.fastProvider ?? this.provider,
      contextTokenBudget: Math.floor(modelContextWindow * 0.6),
    });

    // Agent-specific config overrides
    const config: Partial<AgentConfig> = { ...this.agentConfig };
    if (agent?.model) config.model = agent.model;
    if (agent?.maxIterations) config.maxIterations = agent.maxIterations;
    if (agent?.temperature !== undefined)
      config.temperature = agent.temperature;

    // Global disabled tools filtering
    let toolRegistry = this.toolRegistry;
    if (this.disabledTools?.size) {
      const disabled = this.disabledTools;
      toolRegistry = toolRegistry.filter((t) => !disabled.has(t.name));
    }

    // Agent-specific tool filtering
    if (agent?.tools) {
      const allowed = new Set(agent.tools);
      toolRegistry = toolRegistry.filter((t) => allowed.has(t.name));
    }

    // Inject knowledge source tools (HTTP API → dynamic tools, File → RAG search tools)
    if (agent?.knowledgeSources?.length) {
      const httpTools = createKnowledgeSourceTools(agent.knowledgeSources);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = this.memoryStore as any;
      const ragTools = store
        ? createFileRagTools(
            agent.knowledgeSources,
            agent.id,
            store,
            store.getEmbedFn?.(),
          )
        : [];
      const allKsTools = [...httpTools, ...ragTools];
      if (allKsTools.length > 0) {
        toolRegistry = toolRegistry.clone();
        for (const tool of allKsTools) {
          toolRegistry.register(tool);
        }
      }
    }

    return new SimpleAgentLoop({
      provider: effectiveProvider,
      toolRegistry,
      contextManager,
      memoryStore: this.memoryStore,
      config,
      iterationBudget,
      allToolNames: this.allToolNames,
      onLLMError: this.onLLMError,
    });
  }
}

/** Check whether the user input contains at least one image block */
function hasImage(input: string | ContentBlock[]): boolean {
  if (typeof input === "string") return false;
  return input.some((b) => b.type === "image");
}

/** Check if input is simple chat (short text, no file paths or code indicators) */
function isSimpleChat(input: string | ContentBlock[]): boolean {
  const text =
    typeof input === "string"
      ? input
      : input
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
  // Short messages without technical indicators
  if (text.length > 200) return false;
  if (/[{}[\]`]|https?:\/\/|data\/|\/[a-z]/i.test(text)) return false;
  // Task-oriented keywords → use main model
  if (
    /帮我|请你|生成|创建|写[一个]|编写|修改|删除|分析|搜索|下载|打开|发送|制作|设计|翻译|总结|convert|create|write|generate|analyze|search|download|send|make|build/i.test(
      text,
    )
  )
    return false;
  return true;
}
