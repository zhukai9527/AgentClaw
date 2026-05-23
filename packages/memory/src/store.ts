import type { DbAdapter } from "./db-adapter.js";
import { randomUUID } from "node:crypto";
import type {
  MemoryStore,
  MemoryEntry,
  MemoryQuery,
  MemorySearchResult,
  Project,
  SessionData,
  ConversationTurn,
  ConversationTree,
  Trace,
  SkillChangeInput,
  SkillChangeQuery,
  SkillChangeRecord,
  SkillUsageEvent,
  SkillUsageStats,
  EvolutionEventInput,
  EvolutionEventQuery,
  EvolutionEventRecord,
  EvolutionRunInput,
  EvolutionRunQuery,
  EvolutionRunRecord,
  EvolutionRunUpdate,
  Observation,
  ObservationInput,
  ObservationRead,
  ObservationReadInput,
  BackgroundJob,
  BackgroundJobInput,
  BackgroundJobUpdate,
  MemoryUsageEvent,
  MemoryUsageRecord,
  MemoryEffectivenessStats,
  MemoryJanitorOptions,
  MemoryJanitorResult,
  ToolEffect,
} from "@agentclaw/types";
import { cosineSimilarity, SimpleBagOfWords } from "./embeddings.js";

/** Optional external embedding function (e.g. from an LLM provider) */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * SQLite-backed implementation of the MemoryStore interface.
 *
 * Supports hybrid retrieval:
 *   score = bm25Weight × bm25Score
 *         + semanticWeight × vectorScore
 *         + recencyWeight × recencyScore
 *         + importanceWeight × importanceScore
 *
 * BM25 scoring uses FTS5 full-text search. Results are then deduplicated
 * using MMR (Maximal Marginal Relevance) to ensure diversity.
 *
 * When no LLM embed function is provided, falls back to SimpleBagOfWords.
 */
export class SQLiteMemoryStore implements MemoryStore {
  private db: DbAdapter;
  private embedFn?: EmbedFn;
  private bow: SimpleBagOfWords;
  private hasFts: boolean;

  constructor(db: DbAdapter, embedFn?: EmbedFn) {
    this.db = db;
    this.embedFn = embedFn;
    this.bow = new SimpleBagOfWords(512);
    this.hasFts = this.checkFtsAvailable();
  }

  /** Check whether the memories_fts table exists (old DBs may lack it) */
  private checkFtsAvailable(): boolean {
    try {
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories_fts'",
        )
        .get();
      // Also do a lightweight probe to make sure FTS5 module is loaded
      this.db.prepare("SELECT COUNT(*) FROM memories_fts").get();
      return true;
    } catch {
      return false;
    }
  }

  /** Set or update the embedding function (e.g. after provider is ready) */
  setEmbedFn(fn: EmbedFn): void {
    this.embedFn = fn;
  }

  /** Get the current embedding function (for knowledge source ingestion) */
  getEmbedFn(): EmbedFn | undefined {
    return this.embedFn;
  }

  // ─── Memory CRUD ───────────────────────────────────────────────

  async add(
    entry: Omit<MemoryEntry, "id" | "createdAt" | "accessedAt" | "accessCount">,
    namespace = "default",
  ): Promise<MemoryEntry> {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Auto-generate embedding if not provided
    let embedding = entry.embedding;
    if (!embedding) {
      embedding = await this.generateEmbedding(entry.content);
    }

    const insertFn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories (id, type, content, source_turn_id, importance, embedding, created_at, accessed_at, access_count, metadata, namespace)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          entry.type,
          entry.content,
          entry.sourceTurnId ?? null,
          entry.importance,
          embedding ? Buffer.from(new Float64Array(embedding).buffer) : null,
          now,
          now,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          namespace,
        );

      // Sync FTS5 index
      if (this.hasFts) {
        this.db
          .prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)")
          .run(id, entry.content);
      }
    });
    insertFn();

    return {
      id,
      type: entry.type,
      content: entry.content,
      sourceTurnId: entry.sourceTurnId,
      importance: entry.importance,
      embedding,
      createdAt: new Date(now),
      accessedAt: new Date(now),
      accessCount: 0,
      metadata: entry.metadata,
    };
  }

  async search(query: MemoryQuery): Promise<MemorySearchResult[]> {
    // NOTE: query.query is intentionally NOT used as a SQL LIKE pre-filter.
    // LIKE '%full sentence%' eliminates almost all memories before semantic
    // scoring gets a chance to run. The query is used only for embedding-based,
    // token-overlap, and BM25 scoring below.
    const { where, params } = buildWhereClause({
      type: query.type,
      "importance >=": query.minImportance,
      namespace: query.namespace,
    });

    const limit = query.limit ?? 20;

    // Fetch more candidates than needed — we re-rank with hybrid scoring
    const fetchLimit = Math.max(limit * 3, 60);

    const rows = this.db
      .prepare(
        `SELECT * FROM memories ${where} ORDER BY importance DESC, accessed_at DESC LIMIT ?`,
      )
      .all(...params, fetchLimit) as MemoryRow[];

    // Hybrid scoring weights (new defaults: bm25=0.2, vector=0.4, recency=0.15, importance=0.25)
    const wBm25 = query.bm25Weight ?? 0.2;
    const wSemantic = query.semanticWeight ?? 0.4;
    const wRecency = query.recencyWeight ?? 0.15;
    const wImportance = query.importanceWeight ?? 0.25;

    // Run BM25 search via FTS5
    const bm25Scores =
      query.query && wBm25 > 0
        ? this.bm25Search(query.query, fetchLimit)
        : new Map<string, number>();

    // Generate query embedding for semantic scoring
    let queryEmbedding: number[] | undefined;
    if (query.query && wSemantic > 0) {
      queryEmbedding = await this.generateEmbedding(query.query);
    }

    const now = Date.now();
    const ONE_DAY_MS = 86_400_000;

    const scored: MemorySearchResult[] = rows.flatMap((row) => {
      const entry = rowToMemoryEntry(row);
      if (isDeprecatedMemory(entry)) return [];

      // BM25 score (0-1), 0 if not found in FTS results
      const bm25Score = bm25Scores.get(entry.id) ?? 0;

      // Semantic similarity score (0-1)
      let semanticScore = 0;
      if (queryEmbedding && entry.embedding) {
        // Truncate to shortest dimension to avoid zero-padding distortion
        const a = queryEmbedding;
        const b = entry.embedding;
        const minLen = Math.min(a.length, b.length);
        const aTrunc = a.length > minLen ? a.slice(0, minLen) : a;
        const bTrunc = b.length > minLen ? b.slice(0, minLen) : b;
        semanticScore = Math.max(0, cosineSimilarity(aTrunc, bTrunc));
      } else if (query.query) {
        // Fallback: token-overlap score (works for both CJK and Latin text)
        semanticScore = tokenOverlapScore(query.query, entry.content);
      }

      // Recency score (0-1): exponential decay, half-life = 7 days
      const ageMs = now - entry.accessedAt.getTime();
      const recencyScore = Math.exp(-ageMs / (7 * ONE_DAY_MS));

      // Importance score (already 0-1)
      const importanceScore = entry.importance;

      const score =
        wBm25 * bm25Score +
        wSemantic * semanticScore +
        wRecency * recencyScore +
        wImportance * importanceScore;

      return [{ entry, score }];
    });

    // Sort by hybrid score
    scored.sort((a, b) => b.score - a.score);

    // Apply MMR dedup to ensure diversity in final results
    return mmrRerank(scored, limit);
  }

  /**
   * Find the most similar existing memory across all types.
   * Returns the entry + score, or null if nothing similar enough exists.
   */
  async findSimilar(
    content: string,
    _type: string,
    threshold = 0.75,
    namespace = "default",
  ): Promise<{ entry: MemoryEntry; score: number } | null> {
    // Search across ALL types — same info stored under different types
    // (e.g. "fact" vs "entity") should still be detected as duplicate
    const results = await this.search({
      query: content,
      limit: 10,
      bm25Weight: 0,
      semanticWeight: 1.0,
      recencyWeight: 0,
      importanceWeight: 0,
      namespace,
    });
    if (results.length === 0) return null;

    // Also check exact text match (normalized) as a guaranteed dedup
    const normalized = content.toLowerCase().trim();
    for (const r of results) {
      if (r.entry.content.toLowerCase().trim() === normalized) {
        return { entry: r.entry, score: 1.0 };
      }
    }

    // Return top result if above threshold
    if (results[0].score >= threshold) {
      return { entry: results[0].entry, score: results[0].score };
    }
    return null;
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as MemoryRow | undefined;

    if (!row) return undefined;

    // Update access stats
    this.db
      .prepare(
        "UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?",
      )
      .run(id);

    return rowToMemoryEntry(row);
  }

  async update(
    id: string,
    updates: Partial<MemoryEntry>,
  ): Promise<MemoryEntry> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Memory entry not found: ${id}`);
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const normalizedUpdates = { ...updates };

    if (
      normalizedUpdates.content !== undefined &&
      normalizedUpdates.embedding === undefined
    ) {
      normalizedUpdates.embedding = await this.generateEmbedding(
        normalizedUpdates.content,
      );
    }

    if (normalizedUpdates.type !== undefined) {
      sets.push("type = ?");
      params.push(normalizedUpdates.type);
    }
    if (normalizedUpdates.content !== undefined) {
      sets.push("content = ?");
      params.push(normalizedUpdates.content);
    }
    if (normalizedUpdates.importance !== undefined) {
      sets.push("importance = ?");
      params.push(normalizedUpdates.importance);
    }
    if (normalizedUpdates.embedding !== undefined) {
      sets.push("embedding = ?");
      params.push(
        normalizedUpdates.embedding
          ? Buffer.from(new Float64Array(normalizedUpdates.embedding).buffer)
          : null,
      );
    }
    if (normalizedUpdates.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(
        normalizedUpdates.metadata
          ? JSON.stringify(normalizedUpdates.metadata)
          : null,
      );
    }

    const updateFn = this.db.transaction(() => {
      if (sets.length > 0) {
        params.push(id);
        this.db
          .prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`)
          .run(...params);
      }

      // Sync FTS5 index when content changes
      if (normalizedUpdates.content !== undefined && this.hasFts) {
        this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
        this.db
          .prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)")
          .run(id, normalizedUpdates.content);
      }
    });
    updateFn();

    // Fetch the updated row
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as MemoryRow;

    return rowToMemoryEntry(row);
  }

  async delete(id: string): Promise<void> {
    const deleteFn = this.db.transaction(() => {
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      // Sync FTS5 index
      if (this.hasFts) {
        this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
      }
    });
    deleteFn();
  }

  async recordMemoryUsage(event: MemoryUsageEvent): Promise<MemoryUsageRecord> {
    const id = randomUUID();
    const usedAt = (event.usedAt ?? new Date()).toISOString();
    const metadata = event.metadata ? JSON.stringify(event.metadata) : null;

    this.db
      .prepare(
        `INSERT INTO memory_usage (
          id, memory_id, source, conversation_id, trace_id, agent_id, metadata, used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.memoryId,
        event.source,
        event.conversationId ?? null,
        event.traceId ?? null,
        event.agentId ?? null,
        metadata,
        usedAt,
      );

    return {
      id,
      memoryId: event.memoryId,
      source: event.source,
      conversationId: event.conversationId,
      traceId: event.traceId,
      agentId: event.agentId,
      metadata: event.metadata,
      usedAt: new Date(usedAt),
    };
  }

  async listMemoryEffectiveness(options?: {
    namespace?: string;
  }): Promise<MemoryEffectivenessStats[]> {
    const where = options?.namespace ? "WHERE m.namespace = ?" : "";
    const params = options?.namespace ? [options.namespace] : [];
    const rows = this.db
      .prepare(
        `SELECT
           m.id,
           m.type,
           m.content,
           m.importance,
           m.metadata AS memory_metadata,
           u.source,
           u.metadata AS usage_metadata,
           u.used_at
         FROM memories m
         LEFT JOIN memory_usage u ON u.memory_id = m.id
         ${where}
         ORDER BY m.importance DESC, u.used_at DESC`,
      )
      .all(...params) as Array<{
      id: string;
      type: string;
      content: string;
      importance: number;
      memory_metadata: string | null;
      source: string | null;
      usage_metadata: string | null;
      used_at: string | null;
    }>;

    const byMemory = new Map<string, MemoryEffectivenessStats>();
    for (const row of rows) {
      const metadata = row.memory_metadata
        ? (JSON.parse(row.memory_metadata) as Record<string, unknown>)
        : undefined;
      const current =
        byMemory.get(row.id) ??
        ({
          memoryId: row.id,
          type: row.type as MemoryEntry["type"],
          content: row.content,
          importance: row.importance,
          status:
            typeof metadata?.status === "string" ? metadata.status : undefined,
          totalUses: 0,
          activeMemoryUses: 0,
          helpfulUses: 0,
          pollutingUses: 0,
          effectivenessRate: 0,
          pollutionRate: 0,
          metadata,
        } satisfies MemoryEffectivenessStats);

      if (row.used_at) {
        current.totalUses++;
        if (row.source === "active_memory") current.activeMemoryUses++;
        const usageMetadata = row.usage_metadata
          ? (JSON.parse(row.usage_metadata) as Record<string, unknown>)
          : undefined;
        const outcome = readMemoryUsageOutcome(usageMetadata);
        if (outcome === "helpful") current.helpfulUses++;
        if (outcome === "polluting") current.pollutingUses++;
        const usedAt = new Date(row.used_at);
        if (!current.lastUsedAt || usedAt > current.lastUsedAt) {
          current.lastUsedAt = usedAt;
        }
      }

      byMemory.set(row.id, current);
    }

    const stats = [...byMemory.values()];
    for (const stat of stats) {
      stat.effectivenessRate =
        stat.totalUses > 0 ? roundRatio(stat.helpfulUses / stat.totalUses) : 0;
      stat.pollutionRate =
        stat.totalUses > 0
          ? roundRatio(stat.pollutingUses / stat.totalUses)
          : 0;
    }
    return stats.sort((a, b) => b.pollutionRate - a.pollutionRate);
  }

  async runMemoryJanitor(
    options: MemoryJanitorOptions = {},
  ): Promise<MemoryJanitorResult> {
    const minUses = options.minUses ?? 2;
    const pollutionRateThreshold = options.pollutionRateThreshold ?? 0.5;
    const stats = await this.listMemoryEffectiveness({
      namespace: options.namespace,
    });
    const candidates = stats.filter(
      (stat) =>
        stat.status !== "deprecated" &&
        stat.status !== "superseded" &&
        stat.totalUses >= minUses &&
        stat.pollutingUses > stat.helpfulUses &&
        stat.pollutionRate >= pollutionRateThreshold,
    );

    if (!options.dryRun && candidates.length > 0) {
      const updatedAt = new Date().toISOString();
      const updateMetadata = this.db.prepare(
        "UPDATE memories SET metadata = ? WHERE id = ?",
      );
      const txn = this.db.transaction(() => {
        for (const candidate of candidates) {
          updateMetadata.run(
            JSON.stringify({
              ...candidate.metadata,
              status: "deprecated",
              deprecatedReason: "memory_janitor:pollution",
              deprecatedAt: updatedAt,
              janitor: {
                reason: "pollution",
                totalUses: candidate.totalUses,
                helpfulUses: candidate.helpfulUses,
                pollutingUses: candidate.pollutingUses,
                pollutionRate: candidate.pollutionRate,
              },
            }),
            candidate.memoryId,
          );
        }
      });
      txn();
    }

    return {
      reviewed: stats.length,
      deprecated: candidates.length,
      deprecatedIds: candidates.map((candidate) => candidate.memoryId),
    };
  }

  // ─── Usage stats ─────────────────────────────────────────────

  async recordSkillUsage(event: SkillUsageEvent): Promise<void> {
    const usedAt = (event.usedAt ?? new Date()).toISOString();
    const skillName = event.skillName ?? event.skillId;
    const metadata = event.metadata ? JSON.stringify(event.metadata) : null;
    const successInc = event.success ? 1 : 0;
    const failureInc = event.success ? 0 : 1;

    this.db
      .prepare(
        `INSERT INTO skill_usage (
           skill_id, skill_name, use_count, success_count, failure_count,
           last_used_at, last_error, agent_id, metadata, created_at, updated_at
         )
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(skill_id) DO UPDATE SET
           skill_name = excluded.skill_name,
           use_count = skill_usage.use_count + 1,
           success_count = skill_usage.success_count + excluded.success_count,
           failure_count = skill_usage.failure_count + excluded.failure_count,
           last_used_at = excluded.last_used_at,
           last_error = COALESCE(excluded.last_error, skill_usage.last_error),
           agent_id = COALESCE(excluded.agent_id, skill_usage.agent_id),
           metadata = COALESCE(excluded.metadata, skill_usage.metadata),
           updated_at = excluded.updated_at`,
      )
      .run(
        event.skillId,
        skillName,
        successInc,
        failureInc,
        usedAt,
        event.error ?? null,
        event.agentId ?? null,
        metadata,
        usedAt,
        usedAt,
      );
  }

  async listSkillUsageStats(limit = 100): Promise<SkillUsageStats[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM skill_usage
         ORDER BY last_used_at DESC
         LIMIT ?`,
      )
      .all(limit) as SkillUsageRow[];

    return rows.map(rowToSkillUsageStats);
  }

  async recordSkillChange(
    change: SkillChangeInput,
  ): Promise<SkillChangeRecord> {
    const id = randomUUID();
    const createdAt = (change.createdAt ?? new Date()).toISOString();
    const skillName = change.skillName ?? change.skillId;
    const evolutionRunId =
      change.evolutionRunId ??
      (await this.createAutomaticEvolutionRun(change, skillName, createdAt));

    this.db
      .prepare(
        `INSERT INTO skill_changes (
           id, skill_id, skill_name, action, success, reason,
           before_hash, after_hash, path, error, agent_id,
           evolution_run_id, trace_id, conversation_id, metadata, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        change.skillId,
        skillName,
        change.action,
        change.success ? 1 : 0,
        change.reason ?? null,
        change.beforeHash ?? null,
        change.afterHash ?? null,
        change.path ?? null,
        change.error ?? null,
        change.agentId ?? null,
        evolutionRunId,
        change.traceId ?? null,
        change.conversationId ?? null,
        change.metadata ? JSON.stringify(change.metadata) : null,
        createdAt,
      );

    await this.recordEvolutionEvent({
      runId: evolutionRunId,
      eventType: "change",
      message: `${change.action} ${change.skillId}`,
      success: change.success,
      traceId: change.traceId,
      changeId: id,
      beforeHash: change.beforeHash ?? null,
      afterHash: change.afterHash ?? null,
      data: {
        action: change.action,
        path: change.path,
        error: change.error,
      },
      createdAt: new Date(createdAt),
    });

    return {
      id,
      skillId: change.skillId,
      skillName,
      action: change.action,
      success: change.success,
      reason: change.reason,
      beforeHash: change.beforeHash,
      afterHash: change.afterHash,
      path: change.path,
      error: change.error,
      agentId: change.agentId,
      evolutionRunId,
      traceId: change.traceId,
      conversationId: change.conversationId,
      metadata: change.metadata,
      createdAt: new Date(createdAt),
    };
  }

  async recordEvolutionRun(
    input: EvolutionRunInput,
  ): Promise<EvolutionRunRecord> {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const startedAt = (input.startedAt ?? new Date()).toISOString();
    const completedAt = input.completedAt?.toISOString() ?? null;
    const status = input.status ?? "proposed";
    const result = input.result ?? "unknown";
    const regressionCount = input.regressionCount ?? 0;

    this.db
      .prepare(
        `INSERT INTO evolution_runs (
           id, target_type, target_id, status, result, reason,
           trigger_trace_id, trigger_conversation_id,
           baseline_score, after_score, regression_count,
           eval_report_path, rollback_path, agent_id, metadata,
           started_at, completed_at, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.targetType,
        input.targetId,
        status,
        result,
        input.reason ?? null,
        input.triggerTraceId ?? null,
        input.triggerConversationId ?? null,
        input.baselineScore ?? null,
        input.afterScore ?? null,
        regressionCount,
        input.evalReportPath ?? null,
        input.rollbackPath ?? null,
        input.agentId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        startedAt,
        completedAt,
        now,
        now,
      );

    const row = this.db
      .prepare("SELECT * FROM evolution_runs WHERE id = ?")
      .get(id) as EvolutionRunRow;
    return rowToEvolutionRunRecord(row);
  }

  async updateEvolutionRun(
    id: string,
    updates: EvolutionRunUpdate,
  ): Promise<EvolutionRunRecord | undefined> {
    const existing = this.db
      .prepare("SELECT * FROM evolution_runs WHERE id = ?")
      .get(id) as EvolutionRunRow | undefined;
    if (!existing) return undefined;

    const next = {
      status: updates.status ?? existing.status,
      result: updates.result ?? existing.result,
      reason: updates.reason !== undefined ? updates.reason : existing.reason,
      baselineScore:
        updates.baselineScore !== undefined
          ? updates.baselineScore
          : existing.baseline_score,
      afterScore:
        updates.afterScore !== undefined
          ? updates.afterScore
          : existing.after_score,
      regressionCount:
        updates.regressionCount !== undefined
          ? updates.regressionCount
          : existing.regression_count,
      evalReportPath:
        updates.evalReportPath !== undefined
          ? updates.evalReportPath
          : existing.eval_report_path,
      rollbackPath:
        updates.rollbackPath !== undefined
          ? updates.rollbackPath
          : existing.rollback_path,
      completedAt:
        updates.completedAt === null
          ? null
          : updates.completedAt !== undefined
            ? updates.completedAt.toISOString()
            : existing.completed_at,
      metadata:
        updates.metadata !== undefined
          ? JSON.stringify(updates.metadata)
          : existing.metadata,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `UPDATE evolution_runs SET
           status = ?, result = ?, reason = ?, baseline_score = ?,
           after_score = ?, regression_count = ?, eval_report_path = ?,
           rollback_path = ?, completed_at = ?, metadata = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.result,
        next.reason,
        next.baselineScore,
        next.afterScore,
        next.regressionCount,
        next.evalReportPath,
        next.rollbackPath,
        next.completedAt,
        next.metadata,
        next.updatedAt,
        id,
      );

    const row = this.db
      .prepare("SELECT * FROM evolution_runs WHERE id = ?")
      .get(id) as EvolutionRunRow;
    return rowToEvolutionRunRecord(row);
  }

  async recordEvolutionEvent(
    event: EvolutionEventInput,
  ): Promise<EvolutionEventRecord> {
    const id = randomUUID();
    const createdAt = (event.createdAt ?? new Date()).toISOString();
    const success = event.success !== false;

    this.db
      .prepare(
        `INSERT INTO evolution_events (
           id, run_id, event_type, message, success, trace_id, change_id,
           before_hash, after_hash, score_before, score_after, data, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.runId,
        event.eventType,
        event.message ?? null,
        success ? 1 : 0,
        event.traceId ?? null,
        event.changeId ?? null,
        event.beforeHash ?? null,
        event.afterHash ?? null,
        event.scoreBefore ?? null,
        event.scoreAfter ?? null,
        event.data ? JSON.stringify(event.data) : null,
        createdAt,
      );

    const row = this.db
      .prepare("SELECT * FROM evolution_events WHERE id = ?")
      .get(id) as EvolutionEventRow;
    return rowToEvolutionEventRecord(row);
  }

  async listEvolutionRuns(
    query: EvolutionRunQuery = {},
  ): Promise<EvolutionRunRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.targetType) {
      clauses.push("target_type = ?");
      params.push(query.targetType);
    }
    if (query.targetId) {
      clauses.push("target_id = ?");
      params.push(query.targetId);
    }
    if (query.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    if (query.triggerTraceId) {
      clauses.push("trigger_trace_id = ?");
      params.push(query.triggerTraceId);
    }
    if (query.triggerConversationId) {
      clauses.push("trigger_conversation_id = ?");
      params.push(query.triggerConversationId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(query.limit ?? 100);

    const rows = this.db
      .prepare(
        `SELECT * FROM evolution_runs
         ${where}
         ORDER BY updated_at DESC, started_at DESC
         LIMIT ?`,
      )
      .all(...params) as EvolutionRunRow[];
    return rows.map(rowToEvolutionRunRecord);
  }

  async listEvolutionEvents(
    query: EvolutionEventQuery = {},
  ): Promise<EvolutionEventRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.runId) {
      clauses.push("run_id = ?");
      params.push(query.runId);
    }
    if (query.traceId) {
      clauses.push("trace_id = ?");
      params.push(query.traceId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(query.limit ?? 100);

    const rows = this.db
      .prepare(
        `SELECT * FROM evolution_events
         ${where}
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(...params) as EvolutionEventRow[];
    return rows.map(rowToEvolutionEventRecord);
  }

  async addObservation(input: ObservationInput): Promise<Observation> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO observations (
           id, trace_id, step_id, tool_name, input_hash, content_hash,
           raw_path, preview, facts, metadata,
           raw_chars, prompt_chars, saved_chars, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.traceId,
        input.stepId,
        input.toolName,
        input.inputHash,
        input.contentHash,
        input.rawPath,
        input.preview,
        JSON.stringify(input.facts),
        JSON.stringify(input.metadata),
        input.rawChars,
        input.promptChars,
        input.savedChars,
        createdAt,
      );

    const row = this.db
      .prepare("SELECT * FROM observations WHERE id = ?")
      .get(id) as ObservationRow;
    return rowToObservation(row);
  }

  async getObservation(id: string): Promise<Observation | null> {
    const row = this.db
      .prepare("SELECT * FROM observations WHERE id = ?")
      .get(id) as ObservationRow | undefined;
    return row ? rowToObservation(row) : null;
  }

  async findObservationByHash(
    contentHash: string,
  ): Promise<Observation | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM observations
         WHERE content_hash = ?
         ORDER BY created_at ASC, rowid ASC
         LIMIT 1`,
      )
      .get(contentHash) as ObservationRow | undefined;
    return row ? rowToObservation(row) : null;
  }

  async recordObservationRead(
    input: ObservationReadInput,
  ): Promise<ObservationRead> {
    const id = randomUUID();
    const readAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO observation_reads (
           id, observation_id, trace_id, step_id, query, offset, length,
           returned_chars, read_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.observationId,
        input.traceId,
        input.stepId,
        input.query ?? null,
        input.offset ?? null,
        input.length ?? null,
        input.returnedChars,
        readAt,
      );

    const row = this.db
      .prepare("SELECT * FROM observation_reads WHERE id = ?")
      .get(id) as ObservationReadRow;
    return rowToObservationRead(row);
  }

  async listObservationReads(
    observationId: string,
  ): Promise<ObservationRead[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM observation_reads
         WHERE observation_id = ?
         ORDER BY read_at ASC, rowid ASC`,
      )
      .all(observationId) as ObservationReadRow[];
    return rows.map(rowToObservationRead);
  }

  private async createAutomaticEvolutionRun(
    change: SkillChangeInput,
    skillName: string,
    createdAt: string,
  ): Promise<string> {
    const run = await this.recordEvolutionRun({
      targetType: "skill",
      targetId: change.skillId,
      status: change.success ? "applied" : "failed",
      result: "unknown",
      reason: change.reason,
      triggerTraceId: change.traceId,
      triggerConversationId: change.conversationId,
      agentId: change.agentId,
      startedAt: new Date(createdAt),
      completedAt: new Date(createdAt),
      metadata: {
        source: "skill_change",
        skillName,
        action: change.action,
      },
    });
    return run.id;
  }

  async listSkillChangeHistory(
    query: SkillChangeQuery = {},
  ): Promise<SkillChangeRecord[]> {
    const limit = query.limit ?? 100;
    const params: unknown[] = [];
    let where = "";
    if (query.skillId) {
      where = "WHERE skill_id = ?";
      params.push(query.skillId);
    }
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM skill_changes
         ${where}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params) as SkillChangeRow[];

    return rows.map(rowToSkillChangeRecord);
  }

  getUsageStats(): {
    totalIn: number;
    totalOut: number;
    totalCalls: number;
    byModel: Array<{
      model: string;
      totalIn: number;
      totalOut: number;
      callCount: number;
    }>;
  } {
    const rows = this.db
      .prepare(
        `SELECT model,
                COUNT(*) AS call_count,
                COALESCE(SUM(tokens_in), 0) AS total_in,
                COALESCE(SUM(tokens_out), 0) AS total_out
         FROM turns
         WHERE role = 'assistant' AND model IS NOT NULL
         GROUP BY model`,
      )
      .all() as Array<{
      model: string;
      call_count: number;
      total_in: number;
      total_out: number;
    }>;

    let totalIn = 0;
    let totalOut = 0;
    let totalCalls = 0;
    const byModel = rows.map((r) => {
      totalIn += r.total_in;
      totalOut += r.total_out;
      totalCalls += r.call_count;
      return {
        model: r.model,
        totalIn: r.total_in,
        totalOut: r.total_out,
        callCount: r.call_count,
      };
    });

    return { totalIn, totalOut, totalCalls, byModel };
  }

  // ─── Token logs (per-call detail) ─────────────────────────────

  getTokenLogs(
    limit = 50,
    offset = 0,
  ): {
    items: Array<{
      id: string;
      conversationId: string;
      model: string;
      tokensIn: number;
      tokensOut: number;
      traceId: string | null;
      createdAt: string;
    }>;
    total: number;
  } {
    const { total } = this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM turns WHERE role = 'assistant' AND model IS NOT NULL`,
      )
      .get() as { total: number };

    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, model, tokens_in, tokens_out, trace_id, created_at
         FROM turns
         WHERE role = 'assistant' AND model IS NOT NULL
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<{
      id: string;
      conversation_id: string;
      model: string;
      tokens_in: number | null;
      tokens_out: number | null;
      trace_id: string | null;
      created_at: string;
    }>;

    return {
      items: rows.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        model: r.model,
        tokensIn: r.tokens_in ?? 0,
        tokensOut: r.tokens_out ?? 0,
        traceId: r.trace_id,
        createdAt: r.created_at,
      })),
      total,
    };
  }

  // ─── Conversation turns ────────────────────────────────────────

  async addTurn(conversationId: string, turn: ConversationTurn): Promise<void> {
    // Auto-create conversation if it doesn't exist
    this.ensureConversation(conversationId);
    const turnId = turn.id || randomUUID();
    const parentId =
      turn.parentId !== undefined
        ? turn.parentId
        : this.getCurrentLeafOrLatestTurnId(conversationId);
    if (parentId) {
      this.assertTurnBelongsToConversation(conversationId, parentId);
    }
    const branchId =
      turn.branchId ??
      (parentId ? this.getTurnBranchId(parentId) : undefined) ??
      "main";

    this.db
      .prepare(
        `INSERT INTO turns (id, conversation_id, parent_id, branch_id, role, content, tool_calls, tool_results, reasoning_content, model, tokens_in, tokens_out, duration_ms, tool_call_count, trace_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turnId,
        conversationId,
        parentId,
        branchId,
        turn.role,
        turn.content,
        turn.toolCalls ?? null,
        turn.toolResults ?? null,
        turn.reasoningContent ?? null,
        turn.model ?? null,
        turn.tokensIn ?? null,
        turn.tokensOut ?? null,
        turn.durationMs ?? null,
        turn.toolCallCount ?? null,
        turn.traceId ?? null,
        turn.createdAt
          ? turn.createdAt.toISOString()
          : new Date().toISOString(),
      );

    // Sync to FTS index
    try {
      this.db
        .prepare(
          "INSERT INTO turns_fts (id, conversation_id, content) VALUES (?, ?, ?)",
        )
        .run(turnId, conversationId, turn.content);
    } catch {
      /* FTS insert failure is non-fatal */
    }

    // Update conversation's updated_at timestamp
    this.db
      .prepare(
        "UPDATE conversations SET active_leaf_turn_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(turnId, conversationId);
  }

  /**
   * Full-text search conversation history by keyword.
   * Searches current conversation first, falls back to LIKE if FTS fails.
   */
  async searchHistory(
    conversationId: string,
    query: string,
    limit = 10,
  ): Promise<Array<{ role: string; content: string; createdAt: string }>> {
    try {
      // FTS5 search scoped to current conversation
      const rows = this.db
        .prepare(
          `SELECT t.role, t.content, t.created_at as createdAt
           FROM turns_fts f
           JOIN turns t ON t.id = f.id
           WHERE turns_fts MATCH ? AND f.conversation_id = ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(query, conversationId, limit) as Array<{
        role: string;
        content: string;
        createdAt: string;
      }>;
      if (rows.length > 0) return rows;
    } catch {
      /* FTS may fail on special characters, fall through to LIKE */
    }

    // Fallback: LIKE search
    return this.db
      .prepare(
        `SELECT role, content, created_at as createdAt
         FROM turns
         WHERE conversation_id = ? AND content LIKE ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(conversationId, `%${query}%`, limit) as Array<{
      role: string;
      content: string;
      createdAt: string;
    }>;
  }

  async getHistory(
    conversationId: string,
    limit?: number,
  ): Promise<ConversationTurn[]> {
    const activeLeafId = this.getActiveLeafId(conversationId);
    if (activeLeafId) {
      const rows = this.db
        .prepare(
          `WITH RECURSIVE path(id, depth) AS (
             SELECT id, 0 FROM turns WHERE id = ? AND conversation_id = ?
             UNION ALL
             SELECT t.parent_id, path.depth + 1
             FROM turns t
             JOIN path ON t.id = path.id
             WHERE t.parent_id IS NOT NULL
           )
           SELECT turns.*
           FROM path
           JOIN turns ON turns.id = path.id
           ORDER BY path.depth DESC`,
        )
        .all(activeLeafId, conversationId) as TurnRow[];
      const turns = rows.map(rowToConversationTurn);
      return limit ? turns.slice(-limit) : turns;
    }

    const sql = limit
      ? "SELECT * FROM (SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC"
      : "SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at ASC";

    const params: unknown[] = [conversationId];
    if (limit) params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as TurnRow[];

    return rows.map(rowToConversationTurn);
  }

  async getConversationTree(conversationId: string): Promise<ConversationTree> {
    const activeLeafId = this.getActiveLeafId(conversationId);
    const rows = this.db
      .prepare(
        "SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at ASC",
      )
      .all(conversationId) as TurnRow[];
    return {
      conversationId,
      activeLeafId,
      turns: rows.map(rowToConversationTurn),
    };
  }

  async setActiveConversationLeaf(
    conversationId: string,
    turnId: string | null,
  ): Promise<void> {
    this.ensureConversation(conversationId);
    if (turnId) {
      this.assertTurnBelongsToConversation(conversationId, turnId);
    }
    this.db
      .prepare(
        "UPDATE conversations SET active_leaf_turn_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(turnId, conversationId);
  }

  async deleteTurnsFrom(
    conversationId: string,
    fromCreatedAt: string,
  ): Promise<number> {
    // Clear memory references first
    this.db
      .prepare(
        `UPDATE memories SET source_turn_id = NULL
         WHERE source_turn_id IN (
           SELECT id FROM turns WHERE conversation_id = ? AND created_at >= ?
         )`,
      )
      .run(conversationId, fromCreatedAt);

    const result = this.db
      .prepare(
        "DELETE FROM turns WHERE conversation_id = ? AND created_at >= ?",
      )
      .run(conversationId, fromCreatedAt);

    const latest = this.getLatestTurnId(conversationId);
    this.db
      .prepare(
        "UPDATE conversations SET active_leaf_turn_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(latest, conversationId);

    return result.changes;
  }

  // ─── Chat Targets (for broadcast persistence) ─────────────────

  saveChatTarget(platform: string, targetId: string, sessionId?: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO chat_targets (platform, target_id, session_id, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(platform, targetId, sessionId ?? null);
  }

  getChatTargets(
    platform: string,
  ): Array<{ targetId: string; sessionId: string | null }> {
    const rows = this.db
      .prepare(
        "SELECT target_id, session_id FROM chat_targets WHERE platform = ?",
      )
      .all(platform) as Array<{ target_id: string; session_id: string | null }>;
    return rows.map((r) => ({
      targetId: r.target_id,
      sessionId: r.session_id,
    }));
  }

  deleteChatTarget(platform: string, targetId: string): void {
    this.db
      .prepare("DELETE FROM chat_targets WHERE platform = ? AND target_id = ?")
      .run(platform, targetId);
  }

  /** List all memory namespaces with counts */
  listNamespaces(): Array<{ namespace: string; count: number }> {
    return this.db
      .prepare(
        "SELECT namespace, COUNT(*) as count FROM memories GROUP BY namespace ORDER BY count DESC",
      )
      .all() as Array<{ namespace: string; count: number }>;
  }

  // ─── Consolidation ───────────────────────────────────────────

  /**
   * Consolidate memories: decay importance, merge duplicates, prune stale entries.
   *
   * 1. Importance decay: memories not accessed in a while lose importance
   *    (half-life = 30 days, floor = 0.1 to never fully forget identity/pref)
   * 2. Dedup merge: find semantically similar pairs (>0.85), keep the longer one
   * 3. Prune: delete memories with importance < 0.15 and accessCount = 0
   *
   * Returns stats about what was changed.
   */
  async consolidate(namespace?: string): Promise<{
    decayed: number;
    merged: number;
    pruned: number;
    janitorDeprecated: number;
  }> {
    const nsFilter = namespace ? "WHERE namespace = ?" : "";
    const nsParams = namespace ? [namespace] : [];

    // ── Phase 1: Importance decay ──
    // Half-life: 30 days. identity/preference have a floor of 0.3 (always relevant).
    const HALF_LIFE_MS = 30 * 86_400_000;
    const FLOOR_IMPORTANT = 0.3; // identity, preference
    const FLOOR_OTHER = 0.1;

    const allRows = this.db
      .prepare(
        `SELECT id, type, importance, accessed_at, access_count FROM memories ${nsFilter}`,
      )
      .all(...nsParams) as Array<{
      id: string;
      type: string;
      importance: number;
      accessed_at: string;
      access_count: number;
    }>;

    const now = Date.now();
    let decayed = 0;

    const decayUpdate = this.db.prepare(
      "UPDATE memories SET importance = ? WHERE id = ?",
    );
    const decayTxn = this.db.transaction(() => {
      for (const row of allRows) {
        const ageMs = now - new Date(row.accessed_at).getTime();
        const factor = Math.pow(0.5, ageMs / HALF_LIFE_MS);
        const floor =
          row.type === "identity" || row.type === "preference"
            ? FLOOR_IMPORTANT
            : FLOOR_OTHER;
        const newImportance = Math.max(floor, row.importance * factor);

        // Only update if changed meaningfully (avoid unnecessary writes)
        if (Math.abs(newImportance - row.importance) > 0.01) {
          decayUpdate.run(Math.round(newImportance * 100) / 100, row.id);
          decayed++;
        }
      }
    });
    decayTxn();

    // ── Phase 2: Dedup merge ──
    // Load all memories with embeddings for pairwise comparison
    const SIMILARITY_THRESHOLD = 0.85;
    const withEmbeddings = this.db
      .prepare(
        `SELECT id, content, embedding, importance, access_count FROM memories ${nsFilter} ORDER BY importance DESC`,
      )
      .all(...nsParams) as Array<{
      id: string;
      content: string;
      embedding: Buffer | Uint8Array | null;
      importance: number;
      access_count: number;
    }>;

    const deleted = new Set<string>();
    let merged = 0;

    // Collect merge/prune decisions first, then batch-execute in one transaction
    const toDelete: string[] = [];
    const toBoost: Array<{ id: string; importance: number }> = [];

    for (let i = 0; i < withEmbeddings.length; i++) {
      if (deleted.has(withEmbeddings[i].id)) continue;
      const a = withEmbeddings[i];
      if (!a.embedding) continue;
      const embA = new Float64Array(
        a.embedding.buffer,
        a.embedding.byteOffset,
        a.embedding.byteLength / 8,
      );

      for (let j = i + 1; j < withEmbeddings.length; j++) {
        if (deleted.has(withEmbeddings[j].id)) continue;
        const b = withEmbeddings[j];
        if (!b.embedding) continue;
        const embB = new Float64Array(
          b.embedding.buffer,
          b.embedding.byteOffset,
          b.embedding.byteLength / 8,
        );

        const minLen = Math.min(embA.length, embB.length);
        const sim = cosineSimilarity(
          Array.from(embA.slice(0, minLen)),
          Array.from(embB.slice(0, minLen)),
        );

        if (sim >= SIMILARITY_THRESHOLD) {
          const keepA =
            a.content.length > b.content.length ||
            (a.content.length === b.content.length &&
              a.importance >= b.importance);
          const [keep, remove] = keepA ? [a, b] : [b, a];

          toBoost.push({
            id: keep.id,
            importance: Math.min(1.0, keep.importance + 0.05),
          });
          toDelete.push(remove.id);
          deleted.add(remove.id);
          merged++;
        }
      }
    }

    // ── Phase 3: Prune stale memories ──
    const PRUNE_THRESHOLD = 0.15;
    const pruneRows = this.db
      .prepare(
        `SELECT id FROM memories ${nsFilter ? nsFilter + " AND" : "WHERE"} importance < ? AND access_count = 0`,
      )
      .all(...nsParams, PRUNE_THRESHOLD) as Array<{ id: string }>;

    let pruned = 0;
    for (const row of pruneRows) {
      if (!deleted.has(row.id)) {
        toDelete.push(row.id);
        deleted.add(row.id);
        pruned++;
      }
    }

    // Batch execute all merges + prunes in a single transaction
    if (toDelete.length > 0 || toBoost.length > 0) {
      const batchFn = this.db.transaction(() => {
        for (const b of toBoost) {
          this.db
            .prepare("UPDATE memories SET importance = ? WHERE id = ?")
            .run(b.importance, b.id);
        }
        for (const id of toDelete) {
          this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
          if (this.hasFts) {
            this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
          }
        }
      });
      batchFn();
    }

    const janitor = await this.runMemoryJanitor({ namespace });

    console.log(
      `[memory-consolidation] namespace=${namespace || "all"} decayed=${decayed} merged=${merged} pruned=${pruned} janitorDeprecated=${janitor.deprecated}`,
    );
    return { decayed, merged, pruned, janitorDeprecated: janitor.deprecated };
  }

  // ─── Reindex ──────────────────────────────────────────────────

  /** Regenerate embeddings for all memories and rebuild FTS index */
  async reindexEmbeddings(): Promise<{ total: number; updated: number }> {
    const rows = this.db
      .prepare("SELECT id, content FROM memories")
      .all() as Array<{ id: string; content: string }>;

    let updated = 0;
    for (const row of rows) {
      const embedding = await this.generateEmbedding(row.content);
      this.db
        .prepare("UPDATE memories SET embedding = ? WHERE id = ?")
        .run(Buffer.from(new Float64Array(embedding).buffer), row.id);
      updated++;
    }

    // Rebuild FTS5 index
    if (this.hasFts) {
      this.db.exec("DELETE FROM memories_fts");
      this.db.exec(
        "INSERT INTO memories_fts (id, content) SELECT id, content FROM memories",
      );
    }

    return { total: rows.length, updated };
  }

  // ─── BM25 / FTS5 helpers ──────────────────────────────────────

  /**
   * Run FTS5 BM25 search and return a map of memory id → normalized score (0-1).
   * Returns an empty map if FTS is unavailable or the query is empty.
   */
  private bm25Search(query: string, limit: number): Map<string, number> {
    const result = new Map<string, number>();
    if (!this.hasFts || !query) return result;

    const escaped = escapeFtsQuery(query);
    if (!escaped) return result;

    try {
      const rows = this.db
        .prepare(
          `SELECT id, bm25(memories_fts) AS rank
           FROM memories_fts
           WHERE content MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(escaped, limit) as Array<{ id: string; rank: number }>;

      if (rows.length === 0) return result;

      // BM25 returns negative scores (lower = better match).
      // Normalize to 0-1 where 1 = best match.
      const ranks = rows.map((r) => r.rank);
      const minRank = Math.min(...ranks); // most negative = best
      const maxRank = Math.max(...ranks); // least negative = worst
      const range = maxRank - minRank;

      for (const row of rows) {
        const normalized = range === 0 ? 1 : (maxRank - row.rank) / range;
        result.set(row.id, normalized);
      }
    } catch {
      // FTS query failed (e.g. syntax error after escaping) — degrade gracefully
    }

    return result;
  }

  // ─── Helpers ───────────────────────────────────────────────────

  /** Generate embedding for text — uses LLM embed if available, else bag-of-words */
  private async generateEmbedding(text: string): Promise<number[]> {
    if (this.embedFn) {
      try {
        const [embedding] = await this.embedFn([text]);
        return embedding;
      } catch {
        // Fall back to bag-of-words on error
      }
    }
    return this.bow.embed(text);
  }

  // ─── Sessions ────────────────────────────────────────────────

  async saveSession(session: SessionData): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (id, conversation_id, project_id, created_at, last_active_at, title, status, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.conversationId,
        session.projectId ?? null,
        session.createdAt.toISOString(),
        session.lastActiveAt.toISOString(),
        session.title ?? null,
        session.status ?? "active",
        session.metadata ? JSON.stringify(session.metadata) : null,
      );
  }

  async getSessionById(id: string): Promise<SessionData | null> {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    if (!row) return null;
    return rowToSession(row);
  }

  async listSessions(): Promise<
    Array<Omit<SessionData, "metadata"> & { preview?: string }>
  > {
    const rows = this.db
      .prepare(
        `SELECT s.*,
          (SELECT SUBSTR(t.content, 1, 100) FROM turns t
           WHERE t.conversation_id = s.conversation_id AND t.role = 'user'
           ORDER BY t.created_at ASC LIMIT 1) as preview
         FROM sessions s
         WHERE s.metadata IS NULL OR json_extract(s.metadata, '$.hidden') IS NOT 1
         ORDER BY s.last_active_at DESC`,
      )
      .all() as (SessionRow & { preview?: string })[];
    return rows.map((r) => ({
      ...rowToSession(r),
      preview: r.preview ?? undefined,
    }));
  }

  async deleteSession(id: string): Promise<void> {
    const deleteInTransaction = this.db.transaction((sessionId: string) => {
      const row = this.db
        .prepare("SELECT conversation_id FROM sessions WHERE id = ?")
        .get(sessionId) as { conversation_id: string } | undefined;
      if (row) {
        this.db
          .prepare(
            "UPDATE memories SET source_turn_id = NULL WHERE source_turn_id IN (SELECT id FROM turns WHERE conversation_id = ?)",
          )
          .run(row.conversation_id);
        this.db
          .prepare("DELETE FROM turns WHERE conversation_id = ?")
          .run(row.conversation_id);
        this.db
          .prepare("DELETE FROM traces WHERE conversation_id = ?")
          .run(row.conversation_id);
        this.db
          .prepare("DELETE FROM conversations WHERE id = ?")
          .run(row.conversation_id);
      }
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    });
    deleteInTransaction(id);
  }

  // ─── Projects ───────────────────────────────────────────

  async createProject(
    project: Omit<Project, "id" | "createdAt" | "updatedAt">,
  ): Promise<Project> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, instructions, color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        project.name,
        project.description ?? "",
        project.instructions ?? "",
        project.color ?? "#6B7F5E",
        now,
        now,
      );
    return {
      id,
      name: project.name,
      description: project.description,
      instructions: project.instructions,
      color: project.color ?? "#6B7F5E",
      createdAt: new Date(now),
      updatedAt: new Date(now),
      sessionCount: 0,
    };
  }

  async getProject(id: string): Promise<Project | undefined> {
    const row = this.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM sessions WHERE project_id = p.id) AS session_count
         FROM projects p WHERE p.id = ?`,
      )
      .get(id) as ProjectRow | undefined;
    if (!row) return undefined;
    return rowToProject(row);
  }

  async listProjects(): Promise<Project[]> {
    const rows = this.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM sessions WHERE project_id = p.id) AS session_count
         FROM projects p ORDER BY p.updated_at DESC`,
      )
      .all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  async updateProject(
    id: string,
    updates: Partial<Omit<Project, "id" | "createdAt" | "updatedAt">>,
  ): Promise<Project> {
    const sets: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];
    if (updates.name !== undefined) {
      sets.push("name = ?");
      params.push(updates.name);
    }
    if (updates.description !== undefined) {
      sets.push("description = ?");
      params.push(updates.description);
    }
    if (updates.instructions !== undefined) {
      sets.push("instructions = ?");
      params.push(updates.instructions);
    }
    if (updates.color !== undefined) {
      sets.push("color = ?");
      params.push(updates.color);
    }
    params.push(id);
    this.db
      .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    const project = await this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return project;
  }

  async deleteProject(id: string): Promise<void> {
    const deleteFn = this.db.transaction(() => {
      // Unlink sessions (don't delete them)
      this.db
        .prepare("UPDATE sessions SET project_id = NULL WHERE project_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
    deleteFn();
  }

  // ─── Tasks (human & bot shared) ──────────────────────

  addTask(task: {
    id: string;
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    dueDate?: string;
    assignee?: string;
    createdBy?: string;
    sessionId?: string;
    traceId?: string;
    tags?: string[];
    executor?: string;
    source?: string;
    metadata?: Record<string, unknown>;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, priority, due_date, assignee, created_by, session_id, trace_id, tags, executor, source, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.title,
        task.description ?? "",
        task.status ?? "todo",
        task.priority ?? "normal",
        task.dueDate ?? null,
        task.assignee ?? "human",
        task.createdBy ?? "human",
        task.sessionId ?? null,
        task.traceId ?? null,
        JSON.stringify(task.tags ?? []),
        task.executor ?? "human",
        task.source ?? "web",
        task.metadata ? JSON.stringify(task.metadata) : null,
        now,
        now,
      );
  }

  updateTask(
    id: string,
    updates: {
      title?: string;
      description?: string;
      status?: string;
      priority?: string;
      dueDate?: string | null;
      assignee?: string;
      tags?: string[];
      sessionId?: string;
      traceId?: string;
      executor?: string;
      source?: string;
      scheduledAt?: string | null;
      deadline?: string | null;
      recurrence?: string | null;
      parentId?: string | null;
      result?: string | null;
      decisionContext?: string | null;
      decisionOptions?: string[] | null;
      decisionResult?: string | null;
      traceIds?: string[];
      progress?: number;
      completedAt?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): boolean {
    const { sets, params } = buildSetClause(updates, {
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      dueDate: "due_date",
      assignee: "assignee",
      tags: (v) => JSON.stringify(v),
      sessionId: "session_id",
      traceId: "trace_id",
      executor: "executor",
      source: "source",
      scheduledAt: "scheduled_at",
      deadline: "deadline",
      recurrence: "recurrence",
      parentId: "parent_id",
      result: "result",
      decisionContext: "decision_context",
      decisionOptions: (v) =>
        v ? (typeof v === "string" ? v : JSON.stringify(v)) : null,
      decisionResult: "decision_result",
      traceIds: (v) => JSON.stringify(v),
      progress: "progress",
      completedAt: "completed_at",
      metadata: (v) => (v ? JSON.stringify(v) : null),
    });

    if (sets.length === 0) return false;

    sets.push("updated_at = datetime('now')");
    params.push(id);

    const result = this.db
      .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    return result.changes > 0;
  }

  getTask(id: string): TaskRow | null {
    return (
      (this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
        | TaskRow
        | undefined) ?? null
    );
  }

  deleteTask(id: string): boolean {
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getTaskStats(): {
    inbox: number;
    triaged: number;
    queued: number;
    running: number;
    blocked: number;
    waiting_decision: number;
    done_today: number;
    total_pending: number;
  } {
    const counts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'inbox' THEN 1 ELSE 0 END) AS inbox,
           SUM(CASE WHEN status = 'triaged' THEN 1 ELSE 0 END) AS triaged,
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
           SUM(CASE WHEN status = 'waiting_decision' THEN 1 ELSE 0 END) AS waiting_decision,
           SUM(CASE WHEN status = 'done' AND completed_at >= date('now') THEN 1 ELSE 0 END) AS done_today,
           SUM(CASE WHEN status NOT IN ('done', 'failed') THEN 1 ELSE 0 END) AS total_pending
         FROM tasks`,
      )
      .get() as Record<string, number>;
    return {
      inbox: counts.inbox ?? 0,
      triaged: counts.triaged ?? 0,
      queued: counts.queued ?? 0,
      running: counts.running ?? 0,
      blocked: counts.blocked ?? 0,
      waiting_decision: counts.waiting_decision ?? 0,
      done_today: counts.done_today ?? 0,
      total_pending: counts.total_pending ?? 0,
    };
  }

  listTasks(
    filters?: {
      status?: string;
      priority?: string;
      assignee?: string;
      executor?: string;
    },
    limit = 100,
    offset = 0,
  ): { items: TaskRow[]; total: number } {
    const { where, params } = buildWhereClause({
      status: filters?.status,
      priority: filters?.priority,
      assignee: filters?.assignee,
      executor: filters?.executor,
    });

    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM tasks ${where}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM tasks ${where} ORDER BY
           CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END,
           updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as TaskRow[];

    return { items: rows, total };
  }

  // ─── Task DAG Dependencies ──────────────────────

  addTaskDependency(taskId: string, dependsOnId: string): boolean {
    if (taskId === dependsOnId) return false;
    // 检查依赖是否存在
    const task = this.getTask(taskId);
    const dep = this.getTask(dependsOnId);
    if (!task || !dep) return false;
    // 检查是否已存在
    const existing = this.db
      .prepare(
        "SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?",
      )
      .get(taskId, dependsOnId);
    if (existing) return false;
    // 循环检测：如果 dependsOnId 依赖（直接或间接）taskId，则不能添加
    if (this.wouldCreateCycle(taskId, dependsOnId)) return false;
    this.db
      .prepare(
        "INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)",
      )
      .run(taskId, dependsOnId);
    return true;
  }

  removeTaskDependency(taskId: string, dependsOnId: string): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?",
      )
      .run(taskId, dependsOnId);
    return result.changes > 0;
  }

  getTaskDependencies(taskId: string): TaskRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM tasks t
         JOIN task_dependencies d ON t.id = d.depends_on_id
         WHERE d.task_id = ?`,
      )
      .all(taskId) as TaskRow[];
  }

  getTaskDependents(taskId: string): TaskRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM tasks t
         JOIN task_dependencies d ON t.id = d.task_id
         WHERE d.depends_on_id = ?`,
      )
      .all(taskId) as TaskRow[];
  }

  areDependenciesSatisfied(taskId: string): boolean {
    const deps = this.db
      .prepare("SELECT depends_on_id FROM task_dependencies WHERE task_id = ?")
      .all(taskId) as { depends_on_id: string }[];
    if (deps.length === 0) return true;
    // 检查每个依赖是否都是 done 状态
    for (const dep of deps) {
      const task = this.getTask(dep.depends_on_id);
      if (!task || task.status !== "done") return false;
    }
    return true;
  }

  /** 检查添加 taskId→dependsOnId 是否会产生循环 */
  private wouldCreateCycle(taskId: string, dependsOnId: string): boolean {
    // BFS: 从 dependsOnId 出发，看能否到达 taskId
    const visited = new Set<string>();
    const queue = [dependsOnId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === taskId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const deps = this.db
        .prepare(
          "SELECT depends_on_id FROM task_dependencies WHERE task_id = ?",
        )
        .all(current) as { depends_on_id: string }[];
      for (const d of deps) {
        if (!visited.has(d.depends_on_id)) queue.push(d.depends_on_id);
      }
    }
    return false;
  }

  getCalendarItems(
    year: number,
    month: number,
  ): Array<{
    date: string;
    type: "task" | "schedule";
    id: string;
    title: string;
    status?: string;
    priority?: string;
  }> {
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

    const tasks = this.db
      .prepare(
        `SELECT id, title, due_date, status, priority FROM tasks
         WHERE due_date >= ? AND due_date < ?
         ORDER BY due_date`,
      )
      .all(startDate, endDate) as Array<{
      id: string;
      title: string;
      due_date: string;
      status: string;
      priority: string;
    }>;

    return tasks.map((t) => ({
      date: t.due_date,
      type: "task" as const,
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
    }));
  }

  // ─── SubAgents (persistent records) ─────────────────

  addSubAgent(agent: {
    id: string;
    sessionId?: string;
    goal: string;
    model?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO subagents (id, session_id, goal, model, status, created_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        agent.id,
        agent.sessionId ?? null,
        agent.goal,
        agent.model ?? null,
        now,
      );
  }

  updateSubAgent(
    id: string,
    updates: {
      status?: string;
      result?: string;
      error?: string;
      tokensIn?: number;
      tokensOut?: number;
      toolsUsed?: string[];
      iterations?: number;
      completedAt?: string;
    },
  ): boolean {
    const { sets, params } = buildSetClause(updates, {
      status: "status",
      result: "result",
      error: "error",
      tokensIn: "tokens_in",
      tokensOut: "tokens_out",
      toolsUsed: (v) => JSON.stringify(v),
      iterations: "iterations",
      completedAt: "completed_at",
    });

    if (sets.length === 0) return false;

    params.push(id);
    const result = this.db
      .prepare(`UPDATE subagents SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    return result.changes > 0;
  }

  listSubAgents(
    filters?: { sessionId?: string; status?: string },
    limit = 20,
    offset = 0,
  ): { items: SubAgentRow[]; total: number } {
    const { where, params } = buildWhereClause({
      session_id: filters?.sessionId,
      status: filters?.status,
    });

    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM subagents ${where}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM subagents ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as SubAgentRow[];

    return { items: rows, total };
  }

  getSubAgent(id: string): SubAgentRow | null {
    const row = this.db
      .prepare("SELECT * FROM subagents WHERE id = ?")
      .get(id) as SubAgentRow | undefined;
    return row ?? null;
  }

  // ─── Traces ──────────────────────────────────────────────────

  async addTrace(trace: Trace): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO traces (id, conversation_id, user_input, system_prompt, skill_match, steps, response, model, channel, agent_id, tokens_in, tokens_out, cache_creation_tokens, cache_read_tokens, duration_ms, error, branch_recovery, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trace.id,
        trace.conversationId,
        trace.userInput,
        trace.systemPrompt ?? null,
        trace.skillMatch ?? null,
        JSON.stringify(trace.steps),
        trace.response ?? null,
        trace.model ?? null,
        trace.channel ?? null,
        trace.agentId ?? "default",
        trace.tokensIn,
        trace.tokensOut,
        trace.cacheCreationTokens ?? 0,
        trace.cacheReadTokens ?? 0,
        trace.durationMs,
        trace.error ?? null,
        trace.branchRecovery ? JSON.stringify(trace.branchRecovery) : null,
        trace.createdAt.toISOString(),
      );
  }

  async getTrace(id: string): Promise<Trace | null> {
    const row = this.db.prepare("SELECT * FROM traces WHERE id = ?").get(id) as
      | TraceRow
      | undefined;
    return row ? rowToTrace(row) : null;
  }

  async getTraces(
    limit = 20,
    offset = 0,
    agentId?: string,
    conversationId?: string,
  ): Promise<{ items: Trace[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (agentId) {
      conditions.push("agent_id = ?");
      params.push(agentId);
    }
    if (conversationId) {
      conditions.push("conversation_id = ?");
      params.push(conversationId);
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM traces ${where}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM traces ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as TraceRow[];

    return { items: rows.map(rowToTrace), total };
  }

  /** Get usage stats for an agent within a time period */
  // ─── Knowledge Chunks (RAG) ──────────────────────────────

  /** Store a batch of knowledge chunks with embeddings */
  async addKnowledgeChunks(
    chunks: Array<{
      id: string;
      agentId: string;
      sourceId: string;
      chunkIndex: number;
      content: string;
      embedding?: number[];
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    const insertChunk = this.db.prepare(
      `INSERT OR REPLACE INTO knowledge_chunks (id, agent_id, source_id, chunk_index, content, embedding, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction(() => {
      for (const chunk of chunks) {
        const embBuf = chunk.embedding
          ? Buffer.from(new Float64Array(chunk.embedding).buffer)
          : null;
        insertChunk.run(
          chunk.id,
          chunk.agentId,
          chunk.sourceId,
          chunk.chunkIndex,
          chunk.content,
          embBuf,
          chunk.metadata ? JSON.stringify(chunk.metadata) : null,
        );
      }
    });
    insertMany();
  }

  /** Search knowledge chunks by vector similarity for a given agent + source */
  async searchKnowledgeChunks(
    agentId: string,
    sourceIds: string[],
    queryEmbedding: number[],
    topK = 5,
  ): Promise<
    Array<{
      content: string;
      score: number;
      sourceId: string;
      chunkIndex: number;
    }>
  > {
    if (sourceIds.length === 0) return [];

    const placeholders = sourceIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, source_id, chunk_index, content, embedding FROM knowledge_chunks
         WHERE agent_id = ? AND source_id IN (${placeholders})`,
      )
      .all(agentId, ...sourceIds) as Array<{
      id: string;
      source_id: string;
      chunk_index: number;
      content: string;
      embedding: Buffer | null;
    }>;

    // Score each chunk by cosine similarity
    const scored = rows
      .filter((r) => r.embedding)
      .map((r) => {
        const emb = Array.from(
          new Float64Array(
            r.embedding!.buffer,
            r.embedding!.byteOffset,
            r.embedding!.byteLength / 8,
          ),
        );
        return {
          content: r.content,
          score: cosineSimilarity(queryEmbedding, emb),
          sourceId: r.source_id,
          chunkIndex: r.chunk_index,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  }

  /** Delete all chunks for a given knowledge source */
  deleteKnowledgeChunks(agentId: string, sourceId: string): void {
    this.db
      .prepare(
        "DELETE FROM knowledge_chunks WHERE agent_id = ? AND source_id = ?",
      )
      .run(agentId, sourceId);
  }

  /** Get chunk count for a knowledge source */
  getKnowledgeChunkCount(agentId: string, sourceId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM knowledge_chunks WHERE agent_id = ? AND source_id = ?",
      )
      .get(agentId, sourceId) as { cnt: number };
    return row.cnt;
  }

  getAgentUsage(
    agentId: string,
    sinceHours = 24,
  ): {
    requests: number;
    tokensIn: number;
    tokensOut: number;
    avgDurationMs: number;
  } {
    const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as requests, COALESCE(SUM(tokens_in), 0) as tokensIn,
         COALESCE(SUM(tokens_out), 0) as tokensOut, COALESCE(AVG(duration_ms), 0) as avgDurationMs
         FROM traces WHERE agent_id = ? AND created_at >= ?`,
      )
      .get(agentId, since) as {
      requests: number;
      tokensIn: number;
      tokensOut: number;
      avgDurationMs: number;
    };
    return row;
  }

  /** Aggregate stats for background (hidden) sessions within a date range */
  async getBackgroundStats(since: string): Promise<{
    sessions: number;
    traces: number;
    tokensIn: number;
    tokensOut: number;
    durationMs: number;
  }> {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(DISTINCT t.id) AS traces,
           COUNT(DISTINCT s.id) AS sessions,
           COALESCE(SUM(t.tokens_in), 0) AS tokens_in,
           COALESCE(SUM(t.tokens_out), 0) AS tokens_out,
           COALESCE(SUM(t.duration_ms), 0) AS duration_ms
         FROM traces t
         JOIN sessions s ON s.conversation_id = t.conversation_id
         WHERE json_extract(s.metadata, '$.hidden') = 1
           AND t.created_at >= ?`,
      )
      .get(since) as {
      traces: number;
      sessions: number;
      tokens_in: number;
      tokens_out: number;
      duration_ms: number;
    };
    return {
      sessions: row.sessions,
      traces: row.traces,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      durationMs: row.duration_ms,
    };
  }

  async recordBackgroundJob(job: BackgroundJobInput): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO background_jobs (
           id, command, status, pid, conversation_id, trace_id, agent_id,
           started_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.command,
        job.status,
        job.pid ?? null,
        job.conversationId ?? null,
        job.traceId ?? null,
        job.agentId ?? null,
        job.startedAt.toISOString(),
      );
  }

  async updateBackgroundJob(
    id: string,
    updates: BackgroundJobUpdate,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE background_jobs
         SET status = ?,
             exit_code = ?,
             output = ?,
             error = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(
        updates.status,
        updates.exitCode ?? null,
        updates.output ?? null,
        updates.error ?? null,
        updates.completedAt?.toISOString() ?? null,
        id,
      );
  }

  async getBackgroundJob(id: string): Promise<BackgroundJob | null> {
    const row = this.db
      .prepare("SELECT * FROM background_jobs WHERE id = ?")
      .get(id) as BackgroundJobRow | undefined;
    return row ? rowToBackgroundJob(row) : null;
  }

  async listBackgroundJobs(limit = 50): Promise<BackgroundJob[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM background_jobs
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit) as BackgroundJobRow[];
    return rows.map(rowToBackgroundJob);
  }

  // ─── Settings (key-value store) ─────────────────────────────────

  getSetting(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(key, value);
  }

  // ─── Scheduled Tasks (cron automations) ────────────────────────

  listScheduledTasks(): Array<{
    id: string;
    name: string;
    cron: string;
    action: string;
    enabled: boolean;
    oneShot?: boolean;
    lastRunAt?: Date;
  }> {
    const rows = this.db
      .prepare("SELECT * FROM scheduled_tasks")
      .all() as Array<{
      id: string;
      name: string;
      cron: string;
      action: string;
      enabled: number;
      one_shot: number;
      last_run_at: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      cron: r.cron,
      action: r.action,
      enabled: r.enabled === 1,
      oneShot: r.one_shot === 1 ? true : undefined,
      lastRunAt: r.last_run_at ? new Date(r.last_run_at) : undefined,
    }));
  }

  saveScheduledTask(task: {
    id: string;
    name: string;
    cron: string;
    action: string;
    enabled: boolean;
    oneShot?: boolean;
    lastRunAt?: Date;
  }): void {
    this.db
      .prepare(
        `INSERT INTO scheduled_tasks (id, name, cron, action, enabled, one_shot, last_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, cron = excluded.cron, action = excluded.action,
           enabled = excluded.enabled, one_shot = excluded.one_shot, last_run_at = excluded.last_run_at`,
      )
      .run(
        task.id,
        task.name,
        task.cron,
        task.action,
        task.enabled ? 1 : 0,
        task.oneShot ? 1 : 0,
        task.lastRunAt?.toISOString() ?? null,
      );
  }

  deleteScheduledTask(id: string): void {
    this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
  }

  updateScheduledTaskLastRun(id: string, lastRunAt: Date): void {
    this.db
      .prepare("UPDATE scheduled_tasks SET last_run_at = ? WHERE id = ?")
      .run(lastRunAt.toISOString(), id);
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private getActiveLeafId(conversationId: string): string | null {
    const row = this.db
      .prepare("SELECT active_leaf_turn_id FROM conversations WHERE id = ?")
      .get(conversationId) as
      | { active_leaf_turn_id: string | null }
      | undefined;
    return row?.active_leaf_turn_id ?? null;
  }

  private getLatestTurnId(conversationId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT id FROM turns WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(conversationId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private getCurrentLeafOrLatestTurnId(conversationId: string): string | null {
    return (
      this.getActiveLeafId(conversationId) ??
      this.getLatestTurnId(conversationId)
    );
  }

  private getTurnBranchId(turnId: string): string | null {
    const row = this.db
      .prepare("SELECT branch_id FROM turns WHERE id = ?")
      .get(turnId) as { branch_id: string | null } | undefined;
    return row?.branch_id ?? null;
  }

  private assertTurnBelongsToConversation(
    conversationId: string,
    turnId: string,
  ): void {
    const row = this.db
      .prepare("SELECT id FROM turns WHERE id = ? AND conversation_id = ?")
      .get(turnId, conversationId) as { id: string } | undefined;
    if (!row) {
      throw new Error(
        `Turn "${turnId}" does not belong to conversation "${conversationId}"`,
      );
    }
  }

  private ensureConversation(conversationId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?, datetime('now'), datetime('now'))",
      )
      .run(conversationId);
  }
}

// ─── Row types & mapping ──────────────────────────────────────────

interface MemoryRow {
  id: string;
  type: string;
  content: string;
  source_turn_id: string | null;
  importance: number;
  embedding: Buffer | Uint8Array | null;
  created_at: string;
  accessed_at: string;
  access_count: number;
  metadata: string | null;
}

interface SkillUsageRow {
  skill_id: string;
  skill_name: string;
  use_count: number;
  success_count: number;
  failure_count: number;
  last_used_at: string;
  last_error: string | null;
  agent_id: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface SkillChangeRow {
  id: string;
  skill_id: string;
  skill_name: string;
  action: SkillChangeRecord["action"];
  success: number;
  reason: string | null;
  before_hash: string | null;
  after_hash: string | null;
  path: string | null;
  error: string | null;
  agent_id: string | null;
  evolution_run_id: string | null;
  trace_id: string | null;
  conversation_id: string | null;
  metadata: string | null;
  created_at: string;
}

interface EvolutionRunRow {
  id: string;
  target_type: EvolutionRunRecord["targetType"];
  target_id: string;
  status: EvolutionRunRecord["status"];
  result: EvolutionRunRecord["result"];
  reason: string | null;
  trigger_trace_id: string | null;
  trigger_conversation_id: string | null;
  baseline_score: number | null;
  after_score: number | null;
  regression_count: number;
  eval_report_path: string | null;
  rollback_path: string | null;
  agent_id: string | null;
  metadata: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EvolutionEventRow {
  id: string;
  run_id: string;
  event_type: EvolutionEventRecord["eventType"];
  message: string | null;
  success: number;
  trace_id: string | null;
  change_id: string | null;
  before_hash: string | null;
  after_hash: string | null;
  score_before: number | null;
  score_after: number | null;
  data: string | null;
  created_at: string;
}

interface ObservationRow {
  id: string;
  trace_id: string;
  step_id: string;
  tool_name: string;
  input_hash: string;
  content_hash: string;
  raw_path: string;
  preview: string;
  facts: string;
  metadata: string;
  raw_chars: number;
  prompt_chars: number;
  saved_chars: number;
  created_at: string;
}

interface ObservationReadRow {
  id: string;
  observation_id: string;
  trace_id: string;
  step_id: string;
  query: string | null;
  offset: number | null;
  length: number | null;
  returned_chars: number;
  read_at: string;
}

interface TurnRow {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  branch_id: string | null;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_results: string | null;
  reasoning_content: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  duration_ms: number | null;
  tool_call_count: number | null;
  trace_id: string | null;
  created_at: string;
}

function rowToMemoryEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    type: row.type as MemoryEntry["type"],
    content: row.content,
    sourceTurnId: row.source_turn_id ?? undefined,
    importance: row.importance,
    embedding: row.embedding
      ? Array.from(
          new Float64Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 8,
          ),
        )
      : undefined,
    createdAt: new Date(row.created_at),
    accessedAt: new Date(row.accessed_at),
    accessCount: row.access_count,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : undefined,
  };
}

function readMemoryUsageOutcome(
  metadata: Record<string, unknown> | undefined,
): "helpful" | "polluting" | undefined {
  if (!metadata) return undefined;
  if (metadata.helpful === true || metadata.effective === true) {
    return "helpful";
  }
  if (metadata.polluting === true || metadata.harmful === true) {
    return "polluting";
  }
  const outcome = metadata.outcome;
  if (typeof outcome !== "string") return undefined;
  if (["helpful", "effective", "success"].includes(outcome)) {
    return "helpful";
  }
  if (["polluting", "harmful", "wrong", "incorrect"].includes(outcome)) {
    return "polluting";
  }
  return undefined;
}

function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function rowToSkillUsageStats(row: SkillUsageRow): SkillUsageStats {
  return {
    skillId: row.skill_id,
    skillName: row.skill_name,
    useCount: row.use_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastUsedAt: new Date(row.last_used_at),
    lastError: row.last_error ?? undefined,
    agentId: row.agent_id ?? undefined,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToSkillChangeRecord(row: SkillChangeRow): SkillChangeRecord {
  return {
    id: row.id,
    skillId: row.skill_id,
    skillName: row.skill_name,
    action: row.action,
    success: row.success === 1,
    reason: row.reason ?? undefined,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    path: row.path ?? undefined,
    error: row.error ?? undefined,
    agentId: row.agent_id ?? undefined,
    evolutionRunId: row.evolution_run_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : undefined,
    createdAt: new Date(row.created_at),
  };
}

function rowToEvolutionRunRecord(row: EvolutionRunRow): EvolutionRunRecord {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    result: row.result,
    reason: row.reason ?? undefined,
    triggerTraceId: row.trigger_trace_id ?? undefined,
    triggerConversationId: row.trigger_conversation_id ?? undefined,
    baselineScore: row.baseline_score ?? undefined,
    afterScore: row.after_score ?? undefined,
    regressionCount: row.regression_count,
    evalReportPath: row.eval_report_path ?? undefined,
    rollbackPath: row.rollback_path ?? undefined,
    agentId: row.agent_id ?? undefined,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : undefined,
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToEvolutionEventRecord(
  row: EvolutionEventRow,
): EvolutionEventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    eventType: row.event_type,
    message: row.message ?? undefined,
    success: row.success === 1,
    traceId: row.trace_id ?? undefined,
    changeId: row.change_id ?? undefined,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    scoreBefore: row.score_before ?? undefined,
    scoreAfter: row.score_after ?? undefined,
    data: row.data
      ? (JSON.parse(row.data) as Record<string, unknown>)
      : undefined,
    createdAt: new Date(row.created_at),
  };
}

function isDeprecatedMemory(entry: MemoryEntry): boolean {
  const status = entry.metadata?.status;
  return status === "deprecated" || status === "superseded";
}

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    traceId: row.trace_id,
    stepId: row.step_id,
    toolName: row.tool_name,
    inputHash: row.input_hash,
    contentHash: row.content_hash,
    rawPath: row.raw_path,
    preview: row.preview,
    facts: JSON.parse(row.facts) as Array<Record<string, unknown>>,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    rawChars: row.raw_chars,
    promptChars: row.prompt_chars,
    savedChars: row.saved_chars,
    createdAt: new Date(row.created_at),
  };
}

function rowToObservationRead(row: ObservationReadRow): ObservationRead {
  return {
    id: row.id,
    observationId: row.observation_id,
    traceId: row.trace_id,
    stepId: row.step_id,
    query: row.query ?? undefined,
    offset: row.offset ?? undefined,
    length: row.length ?? undefined,
    returnedChars: row.returned_chars,
    readAt: new Date(row.read_at),
  };
}

/**
 * Compute a token-overlap score between two texts.
 * Handles CJK by splitting into individual characters (each is a semantic unit),
 * and Latin/Cyrillic text by splitting on whitespace.
 * Returns a value in [0, 1].
 */
function tokenOverlapScore(query: string, content: string): number {
  const qTokens = tokenizeForOverlap(query);
  const cTokens = tokenizeForOverlap(content);
  if (qTokens.size === 0 || cTokens.size === 0) return 0;

  let overlap = 0;
  for (const t of qTokens) {
    if (cTokens.has(t)) overlap++;
  }

  // Jaccard-like: overlap / querySize (recall-oriented)
  return overlap / qTokens.size;
}

/** Tokenize text into a Set of lowercased tokens. CJK chars become individual tokens. */
function tokenizeForOverlap(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();

  // Split CJK characters individually, keep Latin/Cyrillic words together
  const parts = lower.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]{2,}/gu,
  );
  if (parts) {
    for (const p of parts) tokens.add(p);
  }
  return tokens;
}

/**
 * Escape a user query for FTS5 MATCH syntax.
 * Wraps each token in double quotes to prevent syntax errors from special chars.
 * Returns null if the query has no usable tokens.
 */
function escapeFtsQuery(query: string): string | null {
  // Extract tokens: CJK characters individually, Latin/Cyrillic words (2+ chars)
  const tokens = query.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]{2,}/gu,
  );
  if (!tokens || tokens.length === 0) return null;

  // Quote each token and join with OR for broad matching
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * MMR (Maximal Marginal Relevance) reranking for result diversity.
 *
 * Iteratively selects results that balance relevance (score) with diversity
 * (dissimilarity to already-selected entries). This prevents returning
 * multiple near-duplicate memories.
 *
 * @param results - Scored results sorted by relevance (descending)
 * @param limit - Maximum number of results to return
 * @param lambda - Balance factor: 1.0 = pure relevance, 0.0 = pure diversity
 */
function mmrRerank(
  results: MemorySearchResult[],
  limit: number,
  lambda = 0.7,
): MemorySearchResult[] {
  if (results.length <= 1 || limit <= 0) return results.slice(0, limit);

  const selected: MemorySearchResult[] = [];
  const remaining = new Set(results.map((_, i) => i));

  // Start with the highest-scored result
  selected.push(results[0]);
  remaining.delete(0);

  while (selected.length < limit && remaining.size > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (const idx of remaining) {
      const candidate = results[idx];

      // Find max similarity to any already-selected entry
      let maxSim = 0;
      for (const sel of selected) {
        const sim = tokenOverlapScore(
          candidate.entry.content,
          sel.entry.content,
        );
        if (sim > maxSim) maxSim = sim;
      }

      // MMR score: balance relevance vs diversity
      const mmrScore = lambda * candidate.score - (1 - lambda) * maxSim;

      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = idx;
      }
    }

    if (bestIdx === -1) break;

    selected.push(results[bestIdx]);
    remaining.delete(bestIdx);
  }

  return selected;
}

// ─── SQL builder helpers ──────────────────────────────────────────

/**
 * Build a dynamic SET clause from an updates object.
 *
 * `mapping` maps each property key to either:
 *  - a string (the SQL column name, value passed as-is)
 *  - a function (transforms the value before binding, column name derived from camelCase → snake_case)
 *
 * Only defined (non-undefined) values are included.
 */
type ColumnMapping<T> = {
  [K in keyof T]?: string | ((value: NonNullable<T[K]>) => unknown);
};

function buildSetClause<T extends Record<string, unknown>>(
  updates: T,
  mapping: ColumnMapping<T>,
): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const key of Object.keys(mapping) as Array<keyof T & string>) {
    if (updates[key] === undefined) continue;
    const spec = mapping[key]!;
    if (typeof spec === "function") {
      const column = camelToSnake(key);
      sets.push(`${column} = ?`);
      params.push(spec(updates[key] as NonNullable<T[typeof key]>));
    } else {
      sets.push(`${spec} = ?`);
      params.push(updates[key]);
    }
  }

  return { sets, params };
}

/**
 * Build a WHERE clause from a filters object.
 *
 * Keys are SQL column names (optionally with operator like "importance >=").
 * Undefined/null values are skipped.
 */
function buildWhereClause(filters: Record<string, unknown>): {
  where: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    // Support operators in key, e.g. "importance >="
    if (key.includes(" ")) {
      conditions.push(`${key} ?`);
    } else {
      conditions.push(`${key} = ?`);
    }
    params.push(value);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

/** Convert camelCase to snake_case */
function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// ─── Row types & mapping ──────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
  session_count: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    instructions: row.instructions ?? undefined,
    color: row.color ?? "#6B7F5E",
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    sessionCount: row.session_count,
  };
}

interface SessionRow {
  id: string;
  conversation_id: string;
  project_id: string | null;
  created_at: string;
  last_active_at: string;
  title: string | null;
  status: string | null;
  metadata: string | null;
}

function rowToSession(row: SessionRow): SessionData {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id ?? undefined,
    createdAt: new Date(row.created_at),
    lastActiveAt: new Date(row.last_active_at),
    title: row.title ?? undefined,
    status: (row.status as SessionData["status"]) ?? "active",
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : undefined,
  };
}

interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  due_date: string | null;
  assignee: string;
  created_by: string;
  session_id: string | null;
  trace_id: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
  // Task Manager v2 fields
  executor: string;
  source: string;
  source_msg_id: string | null;
  scheduled_at: string | null;
  deadline: string | null;
  recurrence: string | null;
  parent_id: string | null;
  result: string | null;
  decision_context: string | null;
  decision_options: string | null;
  decision_result: string | null;
  trace_ids: string;
  progress: number;
  completed_at: string | null;
  metadata: string | null;
}

interface SubAgentRow {
  id: string;
  session_id: string | null;
  goal: string;
  model: string | null;
  status: string;
  result: string | null;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  tools_used: string;
  iterations: number;
  created_at: string;
  completed_at: string | null;
}

interface BackgroundJobRow {
  id: string;
  command: string;
  status: string;
  pid: number | null;
  conversation_id: string | null;
  trace_id: string | null;
  agent_id: string | null;
  exit_code: number | null;
  output: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

function rowToBackgroundJob(row: BackgroundJobRow): BackgroundJob {
  return {
    id: row.id,
    command: row.command,
    status: row.status as BackgroundJob["status"],
    pid: row.pid ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    exitCode: row.exit_code,
    output: row.output ?? undefined,
    error: row.error,
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
  };
}

interface TraceRow {
  id: string;
  conversation_id: string;
  user_input: string;
  system_prompt: string | null;
  skill_match: string | null;
  steps: string;
  response: string | null;
  model: string | null;
  channel: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  duration_ms: number;
  error: string | null;
  branch_recovery: string | null;
  created_at: string;
}

function rowToTrace(row: TraceRow): Trace {
  let steps: Trace["steps"] = [];
  try {
    steps = JSON.parse(row.steps);
  } catch {
    // corrupted data — return empty steps
  }
  const effects = deriveTraceEffects(steps);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userInput: row.user_input,
    systemPrompt: row.system_prompt ?? undefined,
    skillMatch: row.skill_match ?? undefined,
    steps,
    effects: effects.length > 0 ? effects : undefined,
    response: row.response ?? undefined,
    model: row.model ?? undefined,
    channel: row.channel ?? undefined,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    cacheCreationTokens: row.cache_creation_tokens || undefined,
    cacheReadTokens: row.cache_read_tokens || undefined,
    durationMs: row.duration_ms,
    error: row.error ?? undefined,
    branchRecovery: parseBranchRecovery(row.branch_recovery),
    createdAt: new Date(row.created_at),
  };
}

function parseBranchRecovery(
  value: string | null,
): Trace["branchRecovery"] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Trace["branchRecovery"];
    if (!parsed) return undefined;
    return {
      ...parsed,
      createdAt: new Date(parsed.createdAt),
    };
  } catch {
    return undefined;
  }
}

function deriveTraceEffects(steps: Trace["steps"]): ToolEffect[] {
  return steps
    .map((step) => step.effect)
    .filter((effect): effect is ToolEffect => {
      return (
        typeof effect === "object" &&
        effect !== null &&
        "kind" in effect &&
        "reversible" in effect
      );
    });
}

function rowToConversationTurn(row: TurnRow): ConversationTurn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    branchId: row.branch_id ?? "main",
    role: row.role as ConversationTurn["role"],
    content: row.content,
    toolCalls: row.tool_calls ?? undefined,
    toolResults: row.tool_results ?? undefined,
    reasoningContent: row.reasoning_content ?? undefined,
    model: row.model ?? undefined,
    tokensIn: row.tokens_in ?? undefined,
    tokensOut: row.tokens_out ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    toolCallCount: row.tool_call_count ?? undefined,
    traceId: row.trace_id ?? undefined,
    createdAt: new Date(row.created_at),
  };
}
