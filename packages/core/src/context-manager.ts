import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  ContextManager,
  Message,
  ContentBlock,
  ToolUseContent,
  ToolResultContent,
  MemoryStore,
  MemoryType,
  MemorySearchResult,
  ConversationTurn,
  SkillRegistry,
  LLMProvider,
} from "@agentclaw/types";

import { sanitizeString } from "./utils.js";
import { LRUCache } from "lru-cache";

const DEFAULT_SYSTEM_PROMPT = `You are AgentClaw, a powerful AI assistant.

- For casual conversation, greetings, or simple questions you already know the answer to: reply directly in plain text. Do NOT call any tools.
- For tasks that genuinely require action (file operations, web search, running commands, etc.): use the appropriate tool. Do NOT say you cannot do something — use a tool instead.
- Always respond in the same language the user uses.
- Think step by step before acting.`;

export class SimpleContextManager implements ContextManager {
  private systemPrompt: string;
  private memoryStore: MemoryStore;
  private skillRegistry?: SkillRegistry;
  private provider?: LLMProvider;
  private maxHistoryTurns: number;
  private compressAfter: number;
  private freshTailCount: number;
  private summaryCache = new LRUCache<string, string>({ max: 200 });

  /** Cached skill catalog string — built once, reused across all conversations */
  private skillCatalogCache?: string;

  /**
   * Frozen snapshot of dynamic context (memories + skills) per conversation.
   * Used only when no provider-backed Active Memory selector is configured.
   * Active Memory must re-evaluate each user turn, otherwise old-session cache
   * hides newly relevant memories from later requests.
   */
  private dynamicContextCache = new LRUCache<
    string,
    {
      suffix: string;
      skillMatch?: { name: string; confidence: number };
    }
  >({ max: 5000 });

  /** Token budget for context — compress when estimated tokens exceed this * 0.7 */
  private contextTokenBudget: number;

  constructor(options: {
    systemPrompt?: string;
    memoryStore: MemoryStore;
    skillRegistry?: SkillRegistry;
    provider?: LLMProvider;
    maxHistoryTurns?: number;
    compressAfter?: number;
    freshTailCount?: number;
    contextTokenBudget?: number;
  }) {
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.memoryStore = options.memoryStore;
    this.skillRegistry = options.skillRegistry;
    this.provider = options.provider;
    this.maxHistoryTurns = options.maxHistoryTurns ?? 50;
    this.compressAfter = options.compressAfter ?? 20;
    this.freshTailCount = options.freshTailCount ?? 32;
    // Default: 80K tokens — conservative for most models (128K context → ~60% headroom)
    this.contextTokenBudget = options.contextTokenBudget ?? 80_000;
  }

  async buildContext(
    conversationId: string,
    currentInput: string | ContentBlock[],
    options?: {
      preSelectedSkillName?: string;
      reuseContext?: boolean;
      /** Memory namespace for agent isolation */
      memoryNamespace?: string;
      /** Skills to exclude from catalog (Hive per-agent blacklist) */
      disabledSkills?: string[];
    },
  ): Promise<{
    systemPrompt: string;
    messages: Message[];
    skillMatch?: { name: string; confidence: number };
  }> {
    // ── 1. History ──
    const turns = await this.memoryStore.getHistory(
      conversationId,
      this.maxHistoryTurns,
    );

    let historyMessages: Message[];
    // Predictive token management: estimate total tokens and trigger compression
    // when either turn count or token budget is exceeded
    const estimatedTokens = this.estimateTokens(turns);
    const tokenThreshold = this.contextTokenBudget * 0.7;
    const shouldCompress =
      turns.length > this.compressAfter || estimatedTokens > tokenThreshold;
    if (shouldCompress && turns.length > 4) {
      // Fresh Tail Protection: guarantee at least freshTailCount messages are never compressed
      const tailSize = Math.max(this.compressAfter, this.freshTailCount);
      let splitIdx = turns.length - tailSize;
      // Nothing meaningful to compress — skip compression entirely
      if (splitIdx <= 0) {
        historyMessages = turns.map((t) => this.turnToMessage(t));
      } else {
        // If the split point lands on a "tool" turn, push it forward past tool results
        while (splitIdx < turns.length && turns[splitIdx].role === "tool") {
          splitIdx++;
        }
        // Safety: don't compress everything — keep at least 2 turns
        if (splitIdx >= turns.length - 2) splitIdx = turns.length - tailSize;

        const oldTurns = turns.slice(0, splitIdx);
        const recentTurns = turns.slice(splitIdx);
        const summary = await this.compressTurns(conversationId, oldTurns);

        // Offload compressed messages to file so agent can read_file to recall
        let offloadRef = "";
        try {
          const offloadDir = join(process.cwd(), "data", "tmp", conversationId);
          mkdirSync(offloadDir, { recursive: true });
          const offloadPath = join(
            offloadDir,
            "conversation_history.md",
          ).replace(/\\/g, "/");
          const transcript = this.buildTranscript(oldTurns);
          writeFileSync(offloadPath, transcript, "utf-8");
          offloadRef = `\nFull history saved to: ${offloadPath} (use file_read to review if needed)`;
        } catch {
          /* offload failed, non-critical */
        }

        historyMessages = [
          {
            id: "summary",
            role: "user",
            content: summary + offloadRef,
            createdAt: oldTurns[0].createdAt,
          },
          {
            id: "summary-ack",
            role: "assistant",
            content: "Understood, I have the conversation context.",
            createdAt: oldTurns[0].createdAt,
          },
          ...recentTurns.map((turn) => this.turnToMessage(turn)),
        ];
      }
    } else {
      historyMessages = turns.map((turn) => this.turnToMessage(turn));
    }

    // ── 2. Dynamic context (memories + skills) → appended to system prompt ──
    let dynamicSuffix: string;
    let skillMatch: { name: string; confidence: number } | undefined;

    // Frozen snapshot: once built for a conversation, reuse for entire session
    // only when there is no provider-backed Active Memory selector. With a
    // selector, memory relevance is turn-specific and must not be hidden by
    // old conversation cache.
    const canReuseDynamicContext = !this.provider;
    if (
      canReuseDynamicContext &&
      this.dynamicContextCache.has(conversationId)
    ) {
      const cached = this.dynamicContextCache.get(conversationId)!;
      dynamicSuffix = cached.suffix;
      skillMatch = cached.skillMatch;
    } else {
      const result = await this.buildDynamicContext(
        conversationId,
        currentInput,
        turns,
        options,
        options?.memoryNamespace,
        options?.disabledSkills,
      );
      dynamicSuffix = result.suffix;
      skillMatch = result.skillMatch;
      if (canReuseDynamicContext) {
        this.dynamicContextCache.set(conversationId, {
          suffix: dynamicSuffix,
          skillMatch,
        });
      }
    }

    // ── 2.5. Large content extraction — persist oversized tool results to disk ──
    historyMessages = this.extractLargeContent(historyMessages);

    // ── 3. Smart observation compression for old tool results ──
    // Keep the last 2 tool result messages intact; older ones get intelligent
    // compression that extracts errors, status, and key fields (inspired by
    // ClawRouter L6 Observation Compression — up to 90%+ token savings).
    const TOOL_RESULT_KEEP_RECENT = 2;
    const OBSERVATION_COMPRESS_THRESHOLD = 500;
    let toolResultCount = 0;
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      if (historyMessages[i].role === "tool") toolResultCount++;
    }
    if (toolResultCount > TOOL_RESULT_KEEP_RECENT) {
      // Build tool_use_id → tool_name map from assistant messages
      const toolNameMap = new Map<string, string>();
      for (const msg of historyMessages) {
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === "tool_use") {
            const tu = block as ToolUseContent;
            toolNameMap.set(tu.id, tu.name);
          }
        }
      }

      // Track seen content fingerprints for deduplication
      const seenFingerprints = new Map<string, number>();
      historyMessages = historyMessages.map((m) => ({ ...m }));
      let seen = 0;
      for (let i = historyMessages.length - 1; i >= 0; i--) {
        if (historyMessages[i].role !== "tool") continue;
        seen++;
        if (seen <= TOOL_RESULT_KEEP_RECENT) continue;
        const msg = historyMessages[i];
        if (
          typeof msg.content === "string" &&
          msg.content.length > OBSERVATION_COMPRESS_THRESHOLD
        ) {
          msg.content = SimpleContextManager.compressObservation(
            msg.content,
            undefined,
            seenFingerprints,
            i,
          );
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content as ContentBlock[]) {
            if (
              block.type === "tool_result" &&
              typeof block.content === "string" &&
              block.content.length > OBSERVATION_COMPRESS_THRESHOLD
            ) {
              const name = toolNameMap.get(
                (block as ToolResultContent).toolUseId,
              );
              block.content = SimpleContextManager.compressObservation(
                block.content,
                name,
                seenFingerprints,
                i,
              );
            }
          }
        }
      }
    }

    // ── 3.5. Fix orphaned tool_call/tool_result pairs after compression ──
    historyMessages = this.sanitizeToolPairs(historyMessages);

    // ── 3.6. Basic token compression: whitespace normalization + JSON compaction ──
    // Safe transformations that don't affect model understanding (always-on).
    // Inspired by ClawRouter L2 (whitespace) + L5 (JSON compact).
    historyMessages =
      SimpleContextManager.applyBasicCompression(historyMessages);

    // ── 4. Assemble ──
    const finalPrompt = dynamicSuffix
      ? `${this.systemPrompt}\n\n${dynamicSuffix}`
      : this.systemPrompt;

    return {
      systemPrompt: finalPrompt,
      messages: historyMessages,
      skillMatch,
    };
  }

  /**
   * Build dynamic context: memories + skill catalog + active skill.
   * Returns a string to append to the system prompt.
   */
  private async buildDynamicContext(
    conversationId: string,
    currentInput: string | ContentBlock[],
    turns: ConversationTurn[] = [],
    options?: { preSelectedSkillName?: string },
    memoryNamespace = "default",
    disabledSkills?: string[],
  ): Promise<{
    suffix: string;
    skillMatch?: { name: string; confidence: number };
  }> {
    const parts: string[] = [];
    let skillMatch: { name: string; confidence: number } | undefined;

    // ── Memories ──
    const currentQuery = inputToSearchText(currentInput);
    const searchQuery = buildMemorySearchQuery(currentQuery, turns);

    try {
      // Always load identity memories (user personal info: email, name, age).
      // These are always relevant regardless of query content.
      const identityMemories = await this.memoryStore.search({
        type: "identity" as MemoryType,
        limit: 20,
        bm25Weight: 0,
        semanticWeight: 0,
        recencyWeight: 0.1,
        importanceWeight: 0.9,
        namespace: memoryNamespace,
      });
      const prefMemories = await this.memoryStore.search({
        type: "preference" as MemoryType,
        limit: 5,
        bm25Weight: 0,
        semanticWeight: 0,
        recencyWeight: 0.4,
        importanceWeight: 0.6,
        namespace: memoryNamespace,
      });

      // Query-based search for contextually relevant memories (all types)
      const queryMemories = await this.memoryStore.search({
        query: searchQuery,
        limit: 8,
        namespace: memoryNamespace,
      });

      const layeredMemories = await this.memoryStore.search({
        query: searchQuery,
        limit: 12,
        bm25Weight: 0.1,
        semanticWeight: 0.35,
        recencyWeight: 0.1,
        importanceWeight: 0.45,
        namespace: memoryNamespace,
      });

      // Merge and dedup by ID (L3/L2 → identity → preferences → query results)
      const seen = new Set<string>();
      const allMemories: MemorySearchResult[] = [];
      for (const m of [
        ...layeredMemories.filter((memory) =>
          isLayer(memory.entry.metadata, "L3"),
        ),
        ...layeredMemories.filter((memory) =>
          isLayer(memory.entry.metadata, "L2"),
        ),
        ...identityMemories,
        ...prefMemories,
        ...queryMemories,
      ]) {
        if (!seen.has(m.entry.id)) {
          seen.add(m.entry.id);
          allMemories.push(m);
        }
      }

      const activeSelection = await this.selectActiveMemories(
        searchQuery,
        allMemories,
        conversationId,
        memoryNamespace,
      );
      const activeMemories =
        activeSelection === undefined ? allMemories : activeSelection;
      const usageSource =
        activeMemories === allMemories ? "prompt_injection" : "active_memory";

      if (activeMemories.length > 0) {
        const lines: string[] = [];
        let totalChars = 0;
        for (const m of activeMemories) {
          const line = formatMemoryForPrompt(m, searchQuery);
          if (!line) continue;
          if (totalChars + line.length > 2000) break;
          lines.push(line);
          totalChars += line.length;
          if (this.memoryStore.recordMemoryUsage) {
            await this.memoryStore.recordMemoryUsage({
              memoryId: m.entry.id,
              source: usageSource,
              conversationId,
              metadata: {
                layer: readStringMetadata(m.entry.metadata, "layer", "legacy"),
                namespace: memoryNamespace,
                activeMemory:
                  usageSource === "active_memory" ? true : undefined,
              },
            });
          }
        }
        if (lines.length > 0) {
          parts.push(
            `你的长期记忆：\n${lines.join("\n")}\n\n自然地使用这些信息。不要创建文件来记忆——你已有内置记忆系统。`,
          );
        }
      }
    } catch {
      // Memory search failed — continue without memories
    }

    // ── Skill catalog (cached globally — skill list doesn't change at runtime) ──
    if (this.skillRegistry) {
      try {
        const preSkillName = options?.preSelectedSkillName;
        if (preSkillName) {
          const skill = this.skillRegistry.get(preSkillName);
          if (skill) {
            parts.push(`[Active Skill: ${skill.name}]\n${skill.instructions}`);
            skillMatch = { name: skill.name, confidence: 1.0 };
          }
        }

        const hasBlacklist = disabledSkills && disabledSkills.length > 0;
        if (hasBlacklist) {
          // Per-agent blacklist: build filtered catalog (skip global cache)
          const blocked = new Set(disabledSkills);
          const filteredSkills = this.skillRegistry
            .list()
            .filter((s) => s.enabled && !blocked.has(s.id));
          if (filteredSkills.length > 0) {
            const catalog = filteredSkills
              .map((s) =>
                s.description ? `${s.name}: ${s.description}` : s.name,
              )
              .join("\n- ");
            parts.push(
              `Skills (call use_skill(name) to activate):\n- ${catalog}`,
            );
          }
        } else {
          // No blacklist: use global cache
          if (this.skillCatalogCache === undefined) {
            const allSkills = this.skillRegistry
              .list()
              .filter((s) => s.enabled);
            if (allSkills.length > 0) {
              const catalog = allSkills
                .map((s) =>
                  s.description ? `${s.name}: ${s.description}` : s.name,
                )
                .join("\n- ");
              this.skillCatalogCache = `Skills (call use_skill(name) to activate):\n- ${catalog}`;
            } else {
              this.skillCatalogCache = "";
            }
          }
          if (this.skillCatalogCache) {
            parts.push(this.skillCatalogCache);
          }
        }
      } catch {
        // Skill catalog failed — continue without it
      }
    }

    return {
      suffix: parts.join("\n\n"),
      skillMatch,
    };
  }

  private async selectActiveMemories(
    query: string,
    candidates: MemorySearchResult[],
    conversationId: string,
    memoryNamespace: string,
  ): Promise<MemorySearchResult[] | undefined> {
    if (!this.provider || candidates.length <= 1 || !query.trim()) {
      return undefined;
    }

    const rankedCandidates = rankActiveMemoryCandidates(query, candidates);
    const deterministicSelection = rankedCandidates
      .filter((item) => item.score >= 0.12)
      .slice(0, 5)
      .map((item) => item.memory);
    const shortlist =
      rankedCandidates.length > 0
        ? rankedCandidates.slice(0, 8).map((item) => item.memory)
        : candidates.slice(0, 8);

    const compactCandidates = shortlist.map((memory) => ({
      id: memory.entry.id,
      type: memory.entry.type,
      score: Number(memory.score.toFixed(3)),
      layer: readStringMetadata(memory.entry.metadata, "layer", "legacy"),
      sceneName: readStringMetadata(memory.entry.metadata, "sceneName", ""),
      content: memory.entry.content.slice(0, 120),
    }));

    try {
      const response = await this.provider.chat({
        systemPrompt:
          'Return only compact JSON matching {"ids":string[]}. Select at most 5 memory ids directly useful for the user request. Return {"ids":[]} when none are useful.',
        messages: [
          {
            id: `active-memory-${conversationId}`,
            role: "user",
            content: JSON.stringify({
              request: query,
              namespace: memoryNamespace,
              candidates: compactCandidates,
            }),
            createdAt: new Date(),
          },
        ],
        temperature: 0,
        maxTokens: 1024,
      });

      const text =
        typeof response.message.content === "string"
          ? response.message.content
          : response.message.content
              .filter((block) => block.type === "text")
              .map((block) => ("text" in block ? block.text : ""))
              .join("");
      if (!text.trim()) {
        return deterministicSelection;
      }
      const parsed = JSON.parse(
        text
          .replace(/```json?\s*/g, "")
          .replace(/```\s*/g, "")
          .trim(),
      ) as { ids?: unknown };
      const ids = Array.isArray(parsed.ids)
        ? parsed.ids.filter((id): id is string => typeof id === "string")
        : [];
      if (ids.length === 0) return [];
      const idSet = new Set(ids.slice(0, 5));
      return candidates.filter((memory) => idSet.has(memory.entry.id));
    } catch {
      return deterministicSelection;
    }
  }

  /** Clear cached context for a conversation (call on session close) */
  clearConversationCache(conversationId: string): void {
    this.dynamicContextCache.delete(conversationId);
    // Collect keys first to avoid mutating during iteration (LRU iterator safety)
    const prefix = `${conversationId}:`;
    const toDelete = [...this.summaryCache.keys()].filter((k) =>
      k.startsWith(prefix),
    );
    for (const key of toDelete) this.summaryCache.delete(key);
  }

  /** Add to summary cache */
  private cacheSummary(key: string, value: string): void {
    this.summaryCache.set(key, value);
  }

  /** Rough token estimation: ~3 chars per token for mixed CJK/English content */
  private estimateTokens(turns: ConversationTurn[]): number {
    let totalChars = 0;
    for (const t of turns) {
      totalChars += (t.content || "").length;
      if (t.toolCalls) totalChars += t.toolCalls.length;
      if (t.toolResults) totalChars += t.toolResults.length;
    }
    return Math.ceil(totalChars / 3);
  }

  /**
   * Three-tier compression escalation:
   * 1. Normal LLM summarization (3-5 bullet points, 500 chars target)
   * 2. Aggressive LLM summarization (low temperature, 200 chars target)
   * 3. Deterministic truncation fallback (always succeeds)
   */
  /**
   * Force-compress conversation history: summarize all but the last `keepRecent`
   * turns, delete the old ones from DB, keep the summary as a synthetic turn.
   * Called by the `compact` tool when LLM proactively manages context size.
   */
  async forceCompress(
    conversationId: string,
    keepRecent = 6,
  ): Promise<{ deleted: number; summary: string }> {
    const turns = await this.memoryStore.getHistory(
      conversationId,
      this.maxHistoryTurns,
    );
    // Gate: require at least 50% of compressAfter threshold before allowing manual compact
    const minTurns = Math.max(
      keepRecent + 2,
      Math.floor(this.compressAfter * 0.5),
    );
    if (turns.length <= minTurns) {
      return {
        deleted: 0,
        summary: `Context is still small (${turns.length} turns, need ${minTurns}+ to compact). No compression needed.`,
      };
    }

    const splitIdx = turns.length - keepRecent;
    const oldTurns = turns.slice(0, splitIdx);
    const summary = await this.compressTurns(conversationId, oldTurns);

    // Delete old turns from DB (delete from the start up to the split point)
    if (this.memoryStore.deleteTurnsFrom) {
      // deleteTurnsFrom deletes turns >= given timestamp.
      // We want to delete oldTurns, so use the first old turn's timestamp
      // and then re-insert recent ones. But that's destructive.
      // Simpler: delete ALL turns, then re-insert summary + recent.
      const allTimestamp = turns[0].createdAt.toISOString();
      await this.memoryStore.deleteTurnsFrom(conversationId, allTimestamp);

      // Re-insert summary as a synthetic user turn
      await this.memoryStore.addTurn(conversationId, {
        id: "compact-summary",
        conversationId,
        role: "user",
        content: summary,
        createdAt: oldTurns[0].createdAt,
      });
      await this.memoryStore.addTurn(conversationId, {
        id: "compact-ack",
        conversationId,
        role: "assistant",
        content: "Understood, I have the conversation context.",
        createdAt: oldTurns[0].createdAt,
      });

      // Re-insert recent turns
      const recentTurns = turns.slice(splitIdx);
      for (const turn of recentTurns) {
        await this.memoryStore.addTurn(conversationId, turn);
      }
    }

    return { deleted: oldTurns.length, summary };
  }

  private async compressTurns(
    conversationId: string,
    turns: ConversationTurn[],
  ): Promise<string> {
    const cacheKey = `${conversationId}:${turns.length}`;
    const cached = this.summaryCache.get(cacheKey);
    if (cached) return cached;

    const transcript = this.buildTranscript(turns);

    if (this.provider) {
      // Detect previous summary for incremental update
      const prevSummary = turns[0]?.content?.startsWith(
        "[Earlier conversation summary",
      )
        ? turns[0].content
        : null;

      const incrementalPrompt = prevSummary
        ? `You have a previous summary of this conversation. Update it incrementally with the new information below. Do NOT regenerate from scratch — preserve all existing facts and add/modify only what changed.

Previous summary:
${prevSummary}

New conversation since last summary:
${transcript}

Output the updated summary using this exact structure (skip empty sections). Same language as user. Under 800 chars.`
        : `Summarize this conversation using this exact structure. Fill each section (skip empty ones). Reply in the same language the user used. Be concise (under 800 chars total).

${transcript}`;

      const structureTemplate = `
**User Request:** What the user originally asked for (1 sentence)
**Current State:** What has been done so far, current status
**Key Decisions:** Important choices made, constraints established
**Files & Code:** Files read/written/edited, key code changes
**Errors & Fixes:** Problems encountered and how they were resolved
**Next Steps:** What still needs to be done (if anything)
**User Messages:** Preserve the user's exact key instructions/preferences verbatim`;

      // Tier 1: Normal LLM summarization (incremental if previous summary exists)
      try {
        const resp = await this.provider.chat({
          messages: [
            {
              id: "sum",
              role: "user",
              content: incrementalPrompt,
              createdAt: new Date(),
            },
          ],
          systemPrompt: structureTemplate,
          maxTokens: 500,
        });
        const text =
          typeof resp.message.content === "string" ? resp.message.content : "";
        if (text.length > 0) {
          const summary = `[Earlier conversation summary]\n${text}`;
          this.cacheSummary(cacheKey, summary);
          return summary;
        }
      } catch {
        // Tier 1 failed, escalate
      }

      // Tier 2: Aggressive LLM summarization (low temperature, tighter target)
      try {
        const resp = await this.provider.chat({
          messages: [
            {
              id: "sum-aggressive",
              role: "user",
              content: transcript,
              createdAt: new Date(),
            },
          ],
          systemPrompt:
            "Compress this conversation into 2-3 key facts. Maximum 200 characters. Same language as user.",
          maxTokens: 150,
          temperature: 0.05,
        });
        const text =
          typeof resp.message.content === "string" ? resp.message.content : "";
        if (text.length > 0) {
          const summary = `[Earlier conversation summary (compressed)]\n${text}`;
          this.cacheSummary(cacheKey, summary);
          return summary;
        }
      } catch {
        // Tier 2 failed, fall through to deterministic truncation
      }
    }

    // Tier 3: Deterministic truncation (always succeeds)
    const charLimit = 2048;
    const truncated =
      transcript.length > charLimit
        ? transcript.slice(0, charLimit)
        : transcript;
    const turnCount = turns.length;
    const summary =
      `[Earlier conversation summary (deterministic fallback, ${turnCount} turns)]\n` +
      truncated +
      (transcript.length > charLimit
        ? `\n... [truncated from ${transcript.length} chars]`
        : "");
    this.cacheSummary(cacheKey, summary);
    return summary;
  }

  private buildTranscript(turns: ConversationTurn[]): string {
    const lines: string[] = [];
    for (const turn of turns) {
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      const label = turn.role === "user" ? "User" : "Assistant";
      const text =
        turn.content.length > 200
          ? `${turn.content.slice(0, 200)}...`
          : turn.content;
      lines.push(`${label}: ${text}`);
    }
    const transcript = lines.join("\n");
    return transcript.length > 4000
      ? `${transcript.slice(0, 4000)}\n...`
      : transcript;
  }

  /**
   * Strip `/files/hex` URLs from stored user text so LLM doesn't pick up wrong paths.
   * `[Uploaded: name](/files/hex.xlsx)` → `[name]`
   */
  private cleanFileUrls(text: string): string {
    return text.replace(/\[Uploaded:\s*([^\]]*)\]\(\/files\/[^)]+\)/g, "[$1]");
  }

  private turnToMessage(turn: ConversationTurn): Message {
    // Assistant turn with tool calls — reconstruct ContentBlock[] including tool_use blocks
    if (turn.role === "assistant" && turn.toolCalls) {
      const blocks: ContentBlock[] = [];
      if (turn.content) {
        blocks.push({ type: "text", text: turn.content });
      }
      try {
        const toolCalls = JSON.parse(turn.toolCalls) as Array<{
          id: string;
          name: string;
          input: Record<string, unknown>;
        }>;
        for (const tc of toolCalls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }
      } catch {
        // If toolCalls JSON is corrupted, fall back to text-only
      }
      return {
        id: turn.id,
        role: "assistant",
        content: blocks,
        createdAt: turn.createdAt,
        model: turn.model,
        reasoningContent: turn.reasoningContent,
      };
    }

    // Tool result turn — reconstruct ContentBlock[] with tool_result blocks
    if (turn.role === "tool") {
      try {
        const blocks = JSON.parse(turn.content) as ContentBlock[];
        // Sanitize tool result content to remove lone surrogates from DB
        for (const b of blocks) {
          if ((b as ToolResultContent).type === "tool_result") {
            (b as ToolResultContent).content = sanitizeString(
              (b as ToolResultContent).content,
            );
          }
        }
        return {
          id: turn.id,
          role: "tool",
          content: blocks,
          createdAt: turn.createdAt,
        };
      } catch {
        // Fallback: wrap raw content as a tool_result block
        return {
          id: turn.id,
          role: "tool" as const,
          content: [
            {
              type: "tool_result" as const,
              toolUseId: "unknown",
              content: turn.content,
            },
          ],
          createdAt: turn.createdAt,
        };
      }
    }

    // 用户消息可能包含多模态内容（ContentBlock[] 序列化为 JSON），尝试解析
    if (turn.role === "user") {
      try {
        const parsed = JSON.parse(turn.content);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type) {
          // 还原 image block：filePath → 从磁盘加载 base64 data
          // 清理历史中的 /files/ URL，防止 LLM 拾取错误路径
          const cleaned = (
            parsed as (
              | ContentBlock
              | {
                  type: "image";
                  filePath: string;
                  mediaType?: string;
                  filename?: string;
                }
            )[]
          ).map((block) => {
            if (block.type === "text") {
              return { ...block, text: this.cleanFileUrls(block.text) };
            }
            if (
              block.type === "image" &&
              "filePath" in block &&
              block.filePath
            ) {
              // 从磁盘加载 base64，还原为完整 image ContentBlock
              try {
                if (existsSync(block.filePath)) {
                  const buf = readFileSync(block.filePath);
                  return {
                    type: "image" as const,
                    data: buf.toString("base64"),
                    mediaType: block.mediaType ?? "image/jpeg",
                  };
                }
              } catch {
                /* file not found, skip image */
              }
              // 文件不存在，跳过这个 image block
              return {
                type: "text" as const,
                text: `[图片文件已过期: ${block.filename || block.filePath}]`,
              };
            }
            return block;
          });
          return {
            id: turn.id,
            role: turn.role,
            content: cleaned as ContentBlock[],
            createdAt: turn.createdAt,
            model: turn.model,
          };
        }
      } catch {
        // 不是 JSON，按纯文本处理
      }
    }

    // User / system / plain assistant — plain text
    const content =
      turn.role === "user" ? this.cleanFileUrls(turn.content) : turn.content;
    return {
      id: turn.id,
      role: turn.role,
      content,
      createdAt: turn.createdAt,
      model: turn.model,
      reasoningContent: turn.reasoningContent,
    };
  }

  // ── Observation Compression (inspired by ClawRouter L6) ──

  /**
   * Intelligently compress a tool result by extracting key information:
   * error lines, status indicators, JSON key fields, and head/tail lines.
   * Achieves 80-95% token savings vs simple truncation while preserving
   * the information that matters most for LLM reasoning.
   *
   * @param content     Raw tool result string
   * @param toolName    Optional tool name for context
   * @param seenMap     Fingerprint → message index map for dedup
   * @param msgIndex    Current message index for dedup tracking
   * @returns Compressed observation string
   */
  static compressObservation(
    content: string,
    toolName?: string,
    seenMap?: Map<string, number>,
    msgIndex?: number,
  ): string {
    const originalLen = content.length;

    // ── Deduplication: if we've seen very similar content, just reference it ──
    if (seenMap && msgIndex !== undefined) {
      const fingerprint = content.slice(0, 200);
      const prevIdx = seenMap.get(fingerprint);
      if (prevIdx !== undefined) {
        const label = toolName ? ` (${toolName})` : "";
        return `[Duplicate result${label} — same as earlier message, ${originalLen} chars]`;
      }
      seenMap.set(fingerprint, msgIndex);
    }

    const lines = content.split("\n");
    const extracted: string[] = [];
    const MAX_COMPRESSED = 400;

    // ── Pass 1: Extract error lines (highest priority) ──
    const errorPattern =
      /error|exception|fail|fatal|panic|traceback|errno|denied|refused|ENOENT|EACCES|EPERM|TypeError|SyntaxError|ReferenceError/i;
    for (const line of lines) {
      if (errorPattern.test(line) && line.trim().length > 0) {
        extracted.push(line.trimEnd());
        if (extracted.join("\n").length > MAX_COMPRESSED * 0.5) break;
      }
    }

    // ── Pass 2: Extract status/result lines ──
    const statusPattern =
      /success|complete|created|updated|deleted|found|matched|status|result|total|count|passed|warning/i;
    for (const line of lines) {
      if (
        statusPattern.test(line) &&
        !errorPattern.test(line) &&
        line.trim().length > 0
      ) {
        extracted.push(line.trimEnd());
        if (extracted.join("\n").length > MAX_COMPRESSED * 0.7) break;
      }
    }

    // ── Pass 3: Extract JSON key fields (id, name, status, error, message, path, url) ──
    const jsonKeyPattern =
      /^\s*"(?:id|name|status|error|message|path|url|type|code|version|title)":\s*/;
    for (const line of lines) {
      if (jsonKeyPattern.test(line) && !extracted.includes(line.trimEnd())) {
        extracted.push(line.trimEnd());
        if (extracted.join("\n").length > MAX_COMPRESSED * 0.85) break;
      }
    }

    // ── Pass 4: If still too short, add first and last few lines for context ──
    if (extracted.length < 3 && lines.length > 0) {
      // First 3 lines
      for (let j = 0; j < Math.min(3, lines.length); j++) {
        const l = lines[j].trimEnd();
        if (l && !extracted.includes(l)) extracted.push(l);
      }
      // Last 2 lines
      for (let j = Math.max(0, lines.length - 2); j < lines.length; j++) {
        const l = lines[j].trimEnd();
        if (l && !extracted.includes(l)) extracted.push(l);
      }
    }

    // ── Assemble compressed output ──
    let compressed = extracted.join("\n");
    if (compressed.length > MAX_COMPRESSED) {
      compressed = compressed.slice(0, MAX_COMPRESSED);
    }

    const label = toolName ? ` ${toolName}` : "";
    const savings = Math.round((1 - compressed.length / originalLen) * 100);
    return `[${label ? label.trim() + " — " : ""}${originalLen} chars → ${compressed.length} chars, ${savings}% compressed]\n${compressed}`;
  }

  // ── Basic Token Compression (ClawRouter L2 + L5) ──

  /**
   * Apply safe, always-on compression to all messages:
   * - L2 Whitespace: normalize excessive blank lines (max 2), tabs→spaces,
   *   collapse runs of spaces within lines
   * - L5 JSON Compact: minify JSON-formatted tool results (remove pretty-print whitespace)
   *
   * These transformations don't change semantics and save 3-12% tokens typically.
   */
  static applyBasicCompression(messages: Message[]): Message[] {
    return messages.map((msg) => {
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        let changed = false;
        const newBlocks = (msg.content as ContentBlock[]).map((block) => {
          if (
            (block as ToolResultContent).type === "tool_result" &&
            typeof (block as ToolResultContent).content === "string"
          ) {
            const original = (block as ToolResultContent).content as string;
            const compressed = SimpleContextManager.compressBasic(original);
            if (compressed !== original) {
              changed = true;
              return { ...block, content: compressed } as ContentBlock;
            }
          }
          return block;
        });
        return changed ? { ...msg, content: newBlocks } : msg;
      }
      if (msg.role === "tool" && typeof msg.content === "string") {
        const compressed = SimpleContextManager.compressBasic(msg.content);
        return compressed !== msg.content
          ? { ...msg, content: compressed }
          : msg;
      }
      return msg;
    });
  }

  /**
   * Basic compression: whitespace normalization + JSON compaction.
   * Returns the compressed string (or original if no savings).
   */
  static compressBasic(content: string): string {
    if (content.length < 100) return content;

    let result = content;

    // L5: JSON compaction — if it parses as JSON, minify it
    const trimmed = result.trimStart();
    if (
      (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
      result.length > 200
    ) {
      try {
        const parsed = JSON.parse(result);
        const minified = JSON.stringify(parsed);
        if (minified.length < result.length * 0.9) {
          result = minified;
        }
      } catch {
        // Not valid JSON, continue with whitespace normalization
      }
    }

    // L2: Whitespace normalization
    result = result.replace(/\n{3,}/g, "\n\n");
    result = result.replace(/\t/g, "  ");
    result = result.replace(/ {4,}/g, "  ");
    result = result.replace(/[ \t]+$/gm, "");

    return result;
  }

  // ── Large Content Extraction ──

  /**
   * Threshold for large content extraction in historical messages.
   * Agent-loop overflow handles >8K at execution time; this catches anything
   * that slipped through (e.g. multi-part results, non-string content coerced
   * to string during storage). Set at 12K to complement the 8K overflow.
   */
  private static LARGE_CONTENT_THRESHOLD = 12_000;
  private static LARGE_FILES_DIR = join(
    process.cwd(),
    "data",
    "tmp",
    "lcm-files",
  );

  /**
   * Scan tool result messages for oversized content (>100K chars).
   * Persist to disk and replace with a structured summary.
   */
  private extractLargeContent(messages: Message[]): Message[] {
    return messages.map((msg) => {
      if (msg.role !== "tool") return msg;
      if (!Array.isArray(msg.content)) {
        // String content
        if (
          typeof msg.content === "string" &&
          msg.content.length > SimpleContextManager.LARGE_CONTENT_THRESHOLD
        ) {
          const summary = this.persistAndSummarize(msg.content, msg.id);
          return { ...msg, content: summary };
        }
        return msg;
      }
      // ContentBlock[] content
      const blocks = msg.content as ContentBlock[];
      let changed = false;
      const newBlocks = blocks.map((block) => {
        if (
          (block as ToolResultContent).type === "tool_result" &&
          typeof (block as ToolResultContent).content === "string" &&
          ((block as ToolResultContent).content as string).length >
            SimpleContextManager.LARGE_CONTENT_THRESHOLD
        ) {
          changed = true;
          const content = (block as ToolResultContent).content as string;
          const summary = this.persistAndSummarize(content, msg.id);
          return { ...block, content: summary } as ContentBlock;
        }
        return block;
      });
      return changed ? { ...msg, content: newBlocks } : msg;
    });
  }

  /**
   * Persist large content to disk and return a compact summary.
   * Supports structured data (JSON/CSV/XML), code, and plain text.
   */
  private persistAndSummarize(content: string, msgId: string): string {
    // Persist to disk
    let filePath = "";
    try {
      mkdirSync(SimpleContextManager.LARGE_FILES_DIR, { recursive: true });
      const fileId = randomBytes(8).toString("hex");
      filePath = join(SimpleContextManager.LARGE_FILES_DIR, `${fileId}.txt`);
      writeFileSync(filePath, content, "utf-8");
    } catch {
      // If we can't persist, still summarize to save context
    }

    const totalChars = content.length;
    const estimatedTokens = Math.round(totalChars / 4);
    const contentType = this.detectContentType(content);
    let excerpt: string;

    switch (contentType) {
      case "json":
        excerpt = this.summarizeJson(content);
        break;
      case "csv":
        excerpt = this.summarizeCsv(content);
        break;
      case "xml":
        excerpt = this.summarizeXml(content);
        break;
      case "code":
        excerpt = this.summarizeCode(content);
        break;
      default:
        excerpt = this.summarizeText(content);
    }

    const header = `[Large content extracted — ${totalChars.toLocaleString()} chars, ~${estimatedTokens.toLocaleString()} tokens, type: ${contentType}]`;
    const footer = filePath
      ? `[Full content saved to: ${filePath}]`
      : "[Could not persist to disk]";
    return `${header}\n${excerpt}\n${footer}`;
  }

  private detectContentType(
    content: string,
  ): "json" | "csv" | "xml" | "code" | "text" {
    const trimmed = content.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        JSON.parse(trimmed.slice(0, 10000));
        return "json";
      } catch {
        // Not valid JSON
      }
    }
    if (trimmed.startsWith("<?xml") || trimmed.startsWith("<")) {
      if (/<\/\w+>/.test(trimmed.slice(0, 2000))) return "xml";
    }
    // CSV heuristic: first 5 lines have consistent comma/tab separators
    const firstLines = trimmed.split("\n", 5);
    if (firstLines.length >= 3) {
      const commas = firstLines.map((l) => (l.match(/,/g) || []).length);
      if (commas[0] > 1 && commas.every((c) => c === commas[0])) return "csv";
    }
    // Code heuristic
    if (
      /^(import |from |const |function |class |def |pub fn |package |#include)/m.test(
        trimmed.slice(0, 2000),
      )
    ) {
      return "code";
    }
    return "text";
  }

  private summarizeJson(content: string): string {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const sample = parsed[0];
        const keys =
          sample && typeof sample === "object" ? Object.keys(sample) : [];
        return `Array with ${parsed.length} items. Schema: [${keys.slice(0, 10).join(", ")}]\nFirst item: ${JSON.stringify(sample).slice(0, 300)}`;
      }
      const keys = Object.keys(parsed);
      return `Object with ${keys.length} keys: [${keys.slice(0, 15).join(", ")}]\nPreview: ${JSON.stringify(parsed).slice(0, 400)}`;
    } catch {
      return this.summarizeText(content);
    }
  }

  private summarizeCsv(content: string): string {
    const lines = content.split("\n");
    const header = lines[0] || "";
    const rowCount = lines.length - 1;
    const sample = lines.slice(1, 4).join("\n");
    return `CSV: ${rowCount} rows\nHeader: ${header}\nSample rows:\n${sample}`;
  }

  private summarizeXml(content: string): string {
    // Extract root element and first-level children
    const rootMatch = content.match(/<(\w+)[\s>]/);
    const root = rootMatch ? rootMatch[1] : "unknown";
    const childTags = new Set<string>();
    const childRegex = new RegExp(`<${root}[^>]*>\\s*<(\\w+)`, "g");
    let m: RegExpExecArray | null;
    while ((m = childRegex.exec(content.slice(0, 5000))) !== null) {
      childTags.add(m[1]);
    }
    return `XML document, root: <${root}>, child elements: [${[...childTags].slice(0, 10).join(", ")}]\nFirst 400 chars: ${content.slice(0, 400)}`;
  }

  private summarizeCode(content: string): string {
    const lines = content.split("\n");
    // Extract imports and function/class signatures
    const imports = lines
      .filter((l) => /^(import |from |#include |use )/.test(l.trimStart()))
      .slice(0, 10);
    const signatures = lines
      .filter((l) =>
        /^(export )?(function |class |const \w+ = |def |pub fn |fn |interface |type )/.test(
          l.trimStart(),
        ),
      )
      .slice(0, 15);
    const parts: string[] = [];
    if (imports.length > 0) parts.push(`Imports:\n${imports.join("\n")}`);
    if (signatures.length > 0)
      parts.push(`Signatures:\n${signatures.join("\n")}`);
    parts.push(`Total: ${lines.length} lines`);
    return parts.join("\n\n");
  }

  private summarizeText(content: string): string {
    const SAMPLE = 800;
    const start = content.slice(0, SAMPLE);
    const mid = content.slice(
      Math.floor(content.length / 2) - SAMPLE / 2,
      Math.floor(content.length / 2) + SAMPLE / 2,
    );
    const end = content.slice(-SAMPLE);
    return `[Start]\n${start}\n\n[Middle]\n${mid}\n\n[End]\n${end}`;
  }

  /**
   * Fix orphaned tool_call / tool_result pairs after compression.
   *
   * Two failure modes:
   * 1. A tool result references a tool_call_id whose assistant tool_call was removed
   *    → remove the orphaned tool result
   * 2. An assistant message has tool_calls whose results were dropped
   *    → insert stub tool results so the API doesn't reject
   */
  private sanitizeToolPairs(messages: Message[]): Message[] {
    // Collect all tool_call IDs from assistant messages
    const survivingCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === "tool_use" && block.id) {
            survivingCallIds.add(block.id);
          }
        }
      }
    }

    // Collect all tool_result IDs from tool messages
    const resultCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        for (const block of msg.content as ContentBlock[]) {
          if (
            (block as ToolResultContent).type === "tool_result" &&
            (block as ToolResultContent).toolUseId
          ) {
            resultCallIds.add((block as ToolResultContent).toolUseId);
          }
        }
      }
    }

    // 1. Remove orphaned tool_result blocks (block-level, not just message-level)
    //    A multi-result message may contain both surviving and orphaned blocks.
    let result = messages
      .map((msg) => {
        if (msg.role !== "tool" || !Array.isArray(msg.content)) return msg;
        const blocks = msg.content as ContentBlock[];
        const filtered = blocks.filter(
          (b) =>
            (b as ToolResultContent).type !== "tool_result" ||
            survivingCallIds.has((b as ToolResultContent).toolUseId),
        );
        if (filtered.length === 0) return null;
        if (filtered.length === blocks.length) return msg;
        return { ...msg, content: filtered };
      })
      .filter((msg): msg is Message => msg !== null);

    // 2. Insert stub results for assistant tool_calls whose results were dropped
    const missingResults = new Set<string>();
    for (const id of survivingCallIds) {
      if (!resultCallIds.has(id)) missingResults.add(id);
    }

    if (missingResults.size > 0) {
      const patched: Message[] = [];
      for (const msg of result) {
        patched.push(msg);
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content as ContentBlock[]) {
            if (
              block.type === "tool_use" &&
              block.id &&
              missingResults.has(block.id)
            ) {
              patched.push({
                id: `stub-${block.id}`,
                role: "tool",
                content: [
                  {
                    type: "tool_result",
                    toolUseId: block.id,
                    content:
                      "[Result from earlier conversation — see context summary above]",
                  },
                ] as ContentBlock[],
                createdAt: msg.createdAt,
              });
            }
          }
        }
      }
      result = patched;
    }

    return result;
  }
}

function formatMemoryForPrompt(
  memory: MemorySearchResult,
  currentInput = "",
): string | null {
  const metadata = memory.entry.metadata;
  const status = readStringMetadata(metadata, "status", "");
  if (status === "deprecated" || status === "superseded") return null;
  const content = adaptMemoryContentForPrompt(
    memory.entry.content,
    memory.entry.type,
    currentInput,
  );
  if (isLayer(metadata, "L3")) {
    const confidence = readNumericMetadata(metadata, "confidence");
    if (confidence < 0.75) return null;
    const tags = [
      `layer:L3`,
      `src:${readStringMetadata(metadata, "source", "persona")}`,
    ];
    const ids = readStringArrayMetadata(metadata, "sourceMemoryIds");
    if (ids.length > 0) tags.push(`evidence:${ids.slice(0, 3).join(",")}`);
    tags.push(`conf:${formatConfidence(confidence)}`);
    return `- [profile] ${content} (${tags.join(" ")})`;
  }
  if (isLayer(metadata, "L2")) {
    const confidence = readNumericMetadata(metadata, "confidence");
    if (confidence < 0.7) return null;
    const sceneName = readStringMetadata(metadata, "sceneName", "general");
    const ids = readStringArrayMetadata(metadata, "sourceMemoryIds");
    const tags = [`layer:L2`, `scene:${sceneName}`];
    if (ids.length > 0) tags.push(`evidence:${ids.slice(0, 3).join(",")}`);
    tags.push(`conf:${formatConfidence(confidence)}`);
    return `- [scene] ${content} (${tags.join(" ")})`;
  }
  const isL1 = metadata?.layer === "L1";
  if (isL1) {
    const confidence = readNumericMetadata(metadata, "confidence");
    if (confidence < 0.7) return null;
    const tags = [`src:${readStringMetadata(metadata, "source", "unknown")}`];
    const traceId = readStringMetadata(metadata, "traceId", "");
    if (traceId) tags.push(`trace:${traceId}`);
    const conversationId = readStringMetadata(metadata, "conversationId", "");
    if (conversationId && !traceId) tags.push(`conv:${conversationId}`);
    tags.push(`conf:${formatConfidence(confidence)}`);
    return `- [${memory.entry.type}] ${content} (${tags.join(" ")})`;
  }

  if (
    memory.entry.type !== "identity" &&
    memory.entry.type !== "preference" &&
    memory.entry.type !== "episodic"
  ) {
    return null;
  }
  return `- [${memory.entry.type}] ${content} (src:legacy)`;
}

function adaptMemoryContentForPrompt(
  content: string,
  type: MemoryType,
  currentInput: string,
): string {
  if (
    type !== "preference" ||
    !isPptxInput(currentInput) ||
    !isPptxVisualStyleMemory(content) ||
    content.includes("可选参考")
  ) {
    return content;
  }
  return `可选视觉参考，必须服从本次PPT用途与用户明确要求，不能作为默认强制主题：${content}`;
}

function isPptxInput(input: string): boolean {
  return /\b(pptx|ppt|powerpoint)\b|PPT|幻灯片|演示文稿|slide deck|presentation deck/i.test(
    input,
  );
}

function isPptxVisualStyleMemory(content: string): boolean {
  return (
    /PPTX?|演示稿|幻灯片|presentation|slide/i.test(content) &&
    /风格|背景|深色|暗色|白底|配色|颜色|青绿|青绿色|teal|cyan|渐变|大标题|少文字/i.test(
      content,
    )
  );
}

function inputToSearchText(input: string | ContentBlock[]): string {
  if (typeof input === "string") return input;
  return input
    .filter((block): block is { type: "text"; text: string } =>
      block.type === "text",
    )
    .map((block) => block.text)
    .join(" ");
}

function buildMemorySearchQuery(
  currentQuery: string,
  turns: ConversationTurn[],
): string {
  const recentUserTurns = turns
    .filter((turn) => turn.role === "user" && turn.content.trim())
    .slice(-2)
    .map((turn) => turn.content.trim());
  const parts = [...recentUserTurns, currentQuery.trim()].filter(Boolean);
  return [...new Set(parts)].join("\n");
}

function rankActiveMemoryCandidates(
  query: string,
  candidates: MemorySearchResult[],
): Array<{ memory: MemorySearchResult; score: number }> {
  const queryTokens = tokenizeForOverlap(query);
  const isPptxQuery = isPptxInput(query);

  return candidates
    .map((memory) => {
      const content = memory.entry.content;
      const contentTokens = tokenizeForOverlap(content);
      let overlap = 0;
      for (const token of queryTokens) {
        if (contentTokens.has(token)) overlap++;
      }
      const overlapScore =
        queryTokens.size > 0 ? overlap / queryTokens.size : 0;
      const domainScore = isPptxQuery && isPptxInput(content) ? 0.5 : 0;
      const related = overlapScore > 0 || domainScore > 0;
      const foodLike = /吃|辣|菜|川菜|餐饮|食物|食品|美食/i.test(content);
      const foodRequested = /吃|辣|菜|川菜|餐饮|食物|食品|美食/i.test(query);
      if (isPptxQuery && foodLike && !foodRequested) {
        return { memory, score: 0 };
      }
      let score = related
        ? overlapScore * 2 + domainScore + memory.score * 0.1
        : 0;

      if (related && isLayer(memory.entry.metadata, "L2")) score += 0.12;
      if (related && isLayer(memory.entry.metadata, "L3")) score += 0.06;
      if (
        isPptxQuery &&
        /吃|辣|菜|川菜|生日|邮箱|地址|机型|年龄|MBTI|女儿|所在地|located/i.test(
          content,
        )
      ) {
        score -= 0.6;
      }

      return { memory, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

function tokenizeForOverlap(text: string): Set<string> {
  const tokens = new Set<string>();
  const parts = text
    .toLowerCase()
    .match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]{2,}/gu,
    );
  if (parts) {
    for (const part of parts) tokens.add(part);
  }
  return tokens;
}

function isLayer(
  metadata: Record<string, unknown> | undefined,
  layer: string,
): boolean {
  return readStringMetadata(metadata, "layer", "") === layer;
}

function readNumericMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number {
  if (!metadata) return 0;
  const value = metadata[key];
  return typeof value === "number" ? value : 0;
}

function readStringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  if (!metadata) return fallback;
  const value = metadata[key];
  return typeof value === "string" ? value : fallback;
}

function readStringArrayMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function formatConfidence(value: number): string {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
