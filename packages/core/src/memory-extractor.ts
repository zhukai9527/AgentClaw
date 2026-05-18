/**
 * MemoryExtractor — uses LLM to extract long-term memories from conversations.
 *
 * Analyzes conversation turns and extracts:
 *  - facts: concrete information the user shared
 *  - preferences: user likes, dislikes, habits
 *  - entities: people, projects, tools the user mentioned
 *  - episodic: lessons learned, task outcomes
 */
import type {
  LLMProvider,
  MemoryStore,
  MemoryType,
  ConversationTurn,
  Trace,
  TraceStep,
} from "@agentclaw/types";
import { generateId } from "@agentclaw/providers";

interface ExtractedMemory {
  type: MemoryType;
  content: string;
  importance: number;
  sceneName?: string;
  confidence?: number;
}

interface LayeredMemoryConsolidationResult {
  l2Created: number;
  l2Updated: number;
  l3Created: number;
  l3Updated: number;
}

const EXTRACTION_PROMPT = `从对话中提取值得永久记住的用户信息。极度精简，白名单模式——只允许提取以下四类，其他一律不记。

只允许提取：
1. 用户身份事实（fact）：用户自述的邮箱、年龄、住址、公司、职业等持久个人信息
2. 用户偏好习惯（preference）：用户表达的喜好、工作习惯、行为偏好
3. 用户的人/项目（entity）：用户生活中的重要人物、自己拥有或参与的项目和工具
4. 工作经验教训（episodic）：用户在工作中犯的错、学到的教训、验证有效的方法

判断标准：信息必须是用户自己说的或用户亲身经历的。来自搜索、抓取、新闻、第三方网页的内容，无论多有价值，都不是用户的记忆，不提取。

输出 JSON 数组：{"type": "fact|preference|entity|episodic", "content": "...", "importance": 0.0-1.0, "scene_name": "简短场景名", "confidence": 0.0-1.0}
无内容则返回：[]
用中文写 content。`;

function clamp01(value: unknown, fallback: number): number {
  return Math.max(
    0,
    Math.min(1, typeof value === "number" ? value : fallback),
  );
}

function readSceneName(value: Record<string, unknown>): string | undefined {
  const raw = value.scene_name !== undefined ? value.scene_name : value.sceneName;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function normalizeSceneName(sceneName: string | undefined): string {
  return sceneName?.trim() || "general";
}

function readStringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumberMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = metadata?.[key];
  return typeof value === "number" ? value : fallback;
}

function hasConflictSignal(content: string): boolean {
  return /不再|不要|别|禁止|改成|改为|以后|从现在|替代|而不是|instead|no longer|do not/i.test(
    content,
  );
}

function shouldSupersedeExisting(
  incoming: ExtractedMemory,
  existing: { entry: { type: string; content: string; metadata?: Record<string, unknown> }; score: number },
): boolean {
  if (incoming.content.trim() === existing.entry.content.trim()) return false;
  if (incoming.type !== existing.entry.type) return false;
  const incomingScene = normalizeSceneName(incoming.sceneName);
  const existingScene = normalizeSceneName(
    readStringMetadata(existing.entry.metadata, "sceneName"),
  );
  if (incomingScene !== existingScene) return false;
  if (incoming.type !== "preference" && incoming.type !== "fact") return false;
  return existing.score >= 0.55 && hasConflictSignal(incoming.content);
}

function isActiveLayerMemory(metadata: Record<string, unknown> | undefined) {
  return metadata?.status !== "deprecated" && metadata?.status !== "superseded";
}

export class MemoryExtractor {
  private provider: LLMProvider;
  private memoryStore: MemoryStore;

  constructor(options: { provider: LLMProvider; memoryStore: MemoryStore }) {
    this.provider = options.provider;
    this.memoryStore = options.memoryStore;
  }

  /**
   * Extract memories from recent conversation turns.
   * Existing memories are provided so the LLM can avoid duplicates.
   */
  private async extractFromTurns(
    turns: ConversationTurn[],
    existingMemories: string[],
  ): Promise<ExtractedMemory[]> {
    if (turns.length === 0) return [];

    // Build conversation text for the LLM
    const conversationText = turns
      .filter((t) => t.role === "user" || t.role === "assistant")
      .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
      .join("\n");

    if (conversationText.trim().length < 20) return [];

    const existingSection =
      existingMemories.length > 0
        ? "\n\n已有记忆（不要提取重复或换种说法的）：\n" +
          existingMemories.join("\n") +
          "\n"
        : "";

    try {
      const response = await this.provider.chat({
        messages: [
          {
            id: generateId(),
            role: "user",
            content:
              EXTRACTION_PROMPT +
              existingSection +
              "\n对话：\n" +
              conversationText,
            createdAt: new Date(),
          },
        ],
        systemPrompt:
          "You are a memory extraction assistant. Always respond with valid JSON only. No markdown, no explanation — just the JSON array.",
        temperature: 0.1,
        maxTokens: 1024,
      });

      // Extract text from response
      let text: string;
      if (typeof response.message.content === "string") {
        text = response.message.content;
      } else {
        text = response.message.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("");
      }

      // Parse JSON from response (handle markdown code blocks)
      text = text
        .replace(/```json?\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();
      const memories: ExtractedMemory[] = JSON.parse(text);

      if (!Array.isArray(memories)) return [];

      // Validate and clamp
      return memories
        .filter(
          (m) =>
            m.type &&
            m.content &&
            ["fact", "preference", "entity", "episodic"].includes(m.type),
        )
        .map((m) => ({
          type: m.type as MemoryType,
          content: m.content,
          importance: clamp01(m.importance, 0.5),
          sceneName: readSceneName(m as unknown as Record<string, unknown>),
          confidence: clamp01(
            (m as unknown as Record<string, unknown>).confidence,
            0.7,
          ),
        }));
    } catch {
      // LLM call or JSON parse failed — skip silently
      return [];
    }
  }

  /**
   * Extract and store memories from a conversation.
   * Returns the number of new memories stored.
   */
  async processConversation(
    conversationId: string,
    recentTurnsCount = 10,
    namespace = "default",
  ): Promise<number> {
    const turns = await this.memoryStore.getHistory(
      conversationId,
      recentTurnsCount,
    );

    // Load existing memories so LLM can see what's already stored
    const existingResults = await this.memoryStore.search({
      limit: 50,
      namespace,
    });
    const existingMemories = existingResults.map(
      (r) => `- [${r.entry.type}] ${r.entry.content}`,
    );

    const extracted = await this.extractFromTurns(turns, existingMemories);
    let stored = 0;

    for (const memory of extracted) {
      const sourceTurnIds = turns
        .filter((turn) => turn.role === "user" || turn.role === "assistant")
        .map((turn) => turn.id);
      const didStore = await this.storeL1Memory(
        memory,
        {
          source: "conversation",
          conversationId,
          sourceTurnIds,
          sourceTurnId: turns[turns.length - 1]?.id,
        },
        namespace,
      );
      if (didStore) stored++;
    }

    if (stored > 0) {
      await this.consolidateLayeredMemories(namespace);
    }
    return stored;
  }

  /**
   * Extract operational lessons from a trace that had errors or retries.
   * Only processes traces with tool errors, escalation, or explicit error field.
   * Returns the number of new lessons stored.
   */
  async processTrace(
    trace: Trace,
    namespace = "default",
  ): Promise<number> {
    const steps: TraceStep[] =
      typeof trace.steps === "string" ? JSON.parse(trace.steps) : trace.steps;

    // Count tool errors and retries
    const toolErrors = steps.filter(
      (s) => s.type === "tool_result" && s.isError,
    );
    const hasEscalation = trace.error === "max_iterations_reached";

    // Only process traces with failures
    if (toolErrors.length === 0 && !hasEscalation && !trace.error) return 0;

    // Build a failure summary for LLM analysis
    const failureSummary = toolErrors
      .map((s) => {
        // Find the preceding tool_call
        const idx = steps.indexOf(s);
        const call = idx > 0 ? steps[idx - 1] : null;
        const toolName = typeof call?.name === "string" ? call.name : "unknown";
        const errorSource =
          s.content !== undefined && s.content !== null ? s.content : "";
        const errorContent = String(errorSource).slice(0, 300);
        return `- ${toolName}: ${errorContent}`;
      })
      .join("\n");

    const context = [
      `User request: ${trace.userInput}`,
      `Tool errors:\n${failureSummary}`,
      trace.error ? `Final error: ${trace.error}` : "",
      trace.response ? `Agent response: ${String(trace.response).slice(0, 500)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const response = await this.provider.chat({
        messages: [
          {
            id: generateId(),
            role: "user",
            content: context,
            createdAt: new Date(),
          },
        ],
        systemPrompt: `你是一个操作经验提取器。分析以下失败的 agent trace，提取可复用的操作经验教训。

只提取满足以下条件的教训：
1. 是通用的（不是一次性的特殊情况）
2. 可以在未来类似场景中避免同样的错误
3. 格式：在什么条件下 → 什么操作失败了 → 正确做法是什么

输出 JSON 数组：[{"content": "条件→失败→正确做法", "importance": 0.0-1.0}]
无教训则返回：[]
用中文写 content。`,
        temperature: 0.1,
        maxTokens: 512,
      });

      let text: string;
      if (typeof response.message.content === "string") {
        text = response.message.content;
      } else {
        text = response.message.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("");
      }

      text = text
        .replace(/```json?\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();
      const lessons: Array<{
        content: string;
        importance: number;
        scene_name?: string;
        sceneName?: string;
        confidence?: number;
      }> = JSON.parse(text);

      if (!Array.isArray(lessons)) return 0;

      const sourceStepIds = toolErrors
        .map((step) => {
          const id = step.id;
          if (typeof id === "string") return id;
          const toolUseId = step.toolUseId;
          return typeof toolUseId === "string" ? toolUseId : undefined;
        })
        .filter((id): id is string => Boolean(id));
      let stored = 0;
      for (const lesson of lessons) {
        if (!lesson.content) continue;

        const didStore = await this.storeL1Memory(
          {
            type: "episodic",
            content: lesson.content,
            importance: clamp01(lesson.importance, 0.7),
            sceneName: readSceneName(lesson),
            confidence: clamp01(lesson.confidence, 0.7),
          },
          {
            source: "trace",
            traceId: trace.id,
            conversationId: trace.conversationId,
            sourceStepIds,
          },
          namespace,
        );
        if (didStore) stored++;
      }

      if (stored > 0) {
        await this.consolidateLayeredMemories(namespace);
      }
      return stored;
    } catch {
      return 0;
    }
  }

  private async storeL1Memory(
    memory: ExtractedMemory,
    source: {
      source: "conversation" | "trace";
      conversationId: string;
      traceId?: string;
      sourceTurnIds?: string[];
      sourceTurnId?: string;
      sourceStepIds?: string[];
    },
    namespace: string,
  ): Promise<boolean> {
    const similar = await this.memoryStore.findSimilar(
      memory.content,
      memory.type,
      memory.type === "preference" || memory.type === "fact" ? 0.55 : 0.75,
      namespace,
    );

    const supersedes =
      similar && shouldSupersedeExisting(memory, similar)
        ? [similar.entry.id]
        : [];
    if (similar && supersedes.length === 0) {
      if (memory.importance > similar.entry.importance) {
        await this.memoryStore.update(similar.entry.id, {
          importance: memory.importance,
        });
      }
      return false;
    }

    const created = await this.memoryStore.add(
      {
        type: memory.type,
        content: memory.content,
        importance: memory.importance,
        sourceTurnId: source.sourceTurnId,
        metadata: {
          layer: "L1",
          source: source.source,
          conversationId: source.conversationId,
          traceId: source.traceId,
          sourceTurnIds: source.sourceTurnIds,
          sourceStepIds: source.sourceStepIds,
          sceneName: normalizeSceneName(memory.sceneName),
          confidence:
            typeof memory.confidence === "number" ? memory.confidence : 0.7,
          supersedes,
        },
      },
      namespace,
    );

    if (similar && supersedes.length > 0) {
      await this.memoryStore.update(similar.entry.id, {
        metadata: {
          ...similar.entry.metadata,
          status: "deprecated",
          supersededBy: created.id,
          supersededAt: new Date().toISOString(),
        },
      });
    }
    return true;
  }

  async consolidateLayeredMemories(
    namespace = "default",
  ): Promise<LayeredMemoryConsolidationResult> {
    const results = await this.memoryStore.search({
      limit: 200,
      namespace,
      bm25Weight: 0,
      semanticWeight: 0,
      recencyWeight: 0.1,
      importanceWeight: 0.9,
    });
    const entries = results.map((result) => result.entry);
    const activeL1 = entries.filter(
      (entry) =>
        entry.metadata?.layer === "L1" &&
        isActiveLayerMemory(entry.metadata) &&
        readNumberMetadata(entry.metadata, "confidence", 0) >= 0.7,
    );
    const existingAggregates = entries.filter(
      (entry) =>
        (entry.metadata?.layer === "L2" || entry.metadata?.layer === "L3") &&
        isActiveLayerMemory(entry.metadata),
    );

    const byScene = new Map<string, typeof activeL1>();
    for (const entry of activeL1) {
      const sceneName = normalizeSceneName(
        readStringMetadata(entry.metadata, "sceneName"),
      );
      let group = byScene.get(sceneName);
      if (!group) {
        group = [];
        byScene.set(sceneName, group);
      }
      group.push(entry);
    }

    const result: LayeredMemoryConsolidationResult = {
      l2Created: 0,
      l2Updated: 0,
      l3Created: 0,
      l3Updated: 0,
    };

    const l2Ids: string[] = [];
    for (const [sceneName, group] of byScene.entries()) {
      if (group.length < 2) continue;
      group.sort((a, b) => b.importance - a.importance);
      const sourceMemoryIds = group.map((entry) => entry.id);
      const content = buildSceneMemoryContent(sceneName, group);
      const existing = existingAggregates.find(
        (entry) =>
          entry.metadata?.layer === "L2" &&
          readStringMetadata(entry.metadata, "sceneName") === sceneName,
      );
      const metadata = {
        layer: "L2",
        source: "scene_aggregate",
        sceneName,
        confidence: averageConfidence(group),
        sourceMemoryIds,
        evidence: { l1: sourceMemoryIds },
      };
      if (existing) {
        await this.memoryStore.update(existing.id, {
          content,
          importance: Math.max(existing.importance, averageImportance(group)),
          metadata: { ...existing.metadata, ...metadata },
        });
        l2Ids.push(existing.id);
        result.l2Updated++;
      } else {
        const created = await this.memoryStore.add(
          {
            type: "episodic",
            content,
            importance: averageImportance(group),
            metadata,
          },
          namespace,
        );
        l2Ids.push(created.id);
        result.l2Created++;
      }
    }

    const personaSources = activeL1.filter(
      (entry) =>
        (entry.type === "identity" || entry.type === "preference") &&
        readNumberMetadata(entry.metadata, "confidence", 0) >= 0.8,
    );
    if (personaSources.length >= 2) {
      personaSources.sort((a, b) => b.importance - a.importance);
      const sourceMemoryIds = personaSources.map((entry) => entry.id);
      const content = buildPersonaMemoryContent(personaSources);
      const existing = existingAggregates.find(
        (entry) => entry.metadata?.layer === "L3",
      );
      const metadata = {
        layer: "L3",
        source: "persona_aggregate",
        sceneName: "persona",
        confidence: averageConfidence(personaSources),
        sourceMemoryIds,
        evidence: { l2: l2Ids, l1: sourceMemoryIds },
      };
      if (existing) {
        await this.memoryStore.update(existing.id, {
          content,
          importance: Math.max(existing.importance, 0.9),
          metadata: { ...existing.metadata, ...metadata },
        });
        result.l3Updated++;
      } else {
        await this.memoryStore.add(
          {
            type: "preference",
            content,
            importance: 0.9,
            metadata,
          },
          namespace,
        );
        result.l3Created++;
      }
    }

    return result;
  }
}

function buildSceneMemoryContent(
  sceneName: string,
  memories: Array<{ type: string; content: string }>,
): string {
  const lines = memories
    .slice(0, 6)
    .map((memory) => `- [${memory.type}] ${memory.content}`);
  return `场景：${sceneName}\n${lines.join("\n")}`;
}

function buildPersonaMemoryContent(
  memories: Array<{ type: string; content: string; metadata?: Record<string, unknown> }>,
): string {
  const lines = memories.slice(0, 8).map((memory) => {
    const sceneName = normalizeSceneName(
      readStringMetadata(memory.metadata, "sceneName"),
    );
    return `- (${sceneName}) [${memory.type}] ${memory.content}`;
  });
  return `用户稳定画像：\n${lines.join("\n")}`;
}

function averageImportance(memories: Array<{ importance: number }>): number {
  return (
    memories.reduce((sum, memory) => sum + memory.importance, 0) /
    memories.length
  );
}

function averageConfidence(
  memories: Array<{ metadata?: Record<string, unknown> }>,
): number {
  return clamp01(
    memories.reduce(
      (sum, memory) =>
        sum + readNumberMetadata(memory.metadata, "confidence", 0.7),
      0,
    ) / memories.length,
    0.7,
  );
}
