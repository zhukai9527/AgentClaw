import type { FastifyInstance } from "fastify";
import type { AppContext } from "../bootstrap.js";
import type { MemoryEntry, MemoryType } from "@agentclaw/types";

const MEMORY_TYPES = new Set([
  "identity",
  "fact",
  "preference",
  "entity",
  "episodic",
]);

function serializeMemory(memory: MemoryEntry) {
  return {
    id: memory.id,
    type: memory.type,
    content: memory.content,
    importance: memory.importance,
    namespace:
      (memory as unknown as Record<string, unknown>).namespace || "default",
    createdAt: memory.createdAt.toISOString(),
    accessedAt: memory.accessedAt.toISOString(),
    accessCount: memory.accessCount,
    metadata: memory.metadata,
  };
}

function validateMemoryType(type: unknown): MemoryType | undefined {
  if (type === undefined) return undefined;
  if (typeof type !== "string" || !MEMORY_TYPES.has(type)) {
    throw new Error(`Invalid memory type: ${String(type)}`);
  }
  return type as MemoryType;
}

function validateImportance(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || value < 0 || value > 1) {
    throw new Error("importance must be a number between 0 and 1");
  }
  return value;
}

export function registerMemoryRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  // GET /api/memories - Search memories
  app.get<{
    Querystring: {
      q?: string;
      type?: string;
      limit?: string;
      namespace?: string;
    };
  }>(
    "/api/memories",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            q: { type: "string" },
            type: { type: "string" },
            limit: { type: "string", pattern: "^[0-9]+$" },
            namespace: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { q, type, limit, namespace } = req.query;
        const results = await ctx.memoryStore.search({
          query: q || undefined,
          type: type ? (type as MemoryType) : undefined,
          limit: limit ? parseInt(limit, 10) : 10,
          namespace: namespace || undefined,
        });

        const memories = results.map((r) => serializeMemory(r.entry));

        return reply.send(memories);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // GET /api/memories/namespaces - List all namespaces with counts
  app.get("/api/memories/namespaces", async (_req, reply) => {
    try {
      const store = ctx.memoryStore as {
        listNamespaces?: () => Array<{ namespace: string; count: number }>;
      };
      if (store.listNamespaces) {
        return reply.send(store.listNamespaces());
      }
      return reply.send([{ namespace: "default", count: 0 }]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // POST /api/memories/reindex - Regenerate all embeddings
  app.post("/api/memories/reindex", async (_req, reply) => {
    try {
      const result = await ctx.memoryStore.reindexEmbeddings();
      return reply.send(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // GET /api/memories/effectiveness - Machine-readable memory quality stats
  app.get<{ Querystring: { namespace?: string } }>(
    "/api/memories/effectiveness",
    async (req, reply) => {
      try {
        const store = ctx.memoryStore as {
          listMemoryEffectiveness?: (options?: {
            namespace?: string;
          }) => Promise<unknown>;
        };
        if (!store.listMemoryEffectiveness) {
          return reply
            .status(501)
            .send({ error: "Memory effectiveness is not supported" });
        }
        const result = await store.listMemoryEffectiveness({
          namespace: req.query.namespace || undefined,
        });
        return reply.send(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // POST /api/memories/janitor - Deprecate memories proven harmful by telemetry
  app.post<{
    Body: {
      namespace?: string;
      minUses?: number;
      pollutionRateThreshold?: number;
      dryRun?: boolean;
    };
  }>("/api/memories/janitor", async (req, reply) => {
    try {
      const store = ctx.memoryStore as {
        runMemoryJanitor?: (options?: {
          namespace?: string;
          minUses?: number;
          pollutionRateThreshold?: number;
          dryRun?: boolean;
        }) => Promise<unknown>;
      };
      if (!store.runMemoryJanitor) {
        return reply
          .status(501)
          .send({ error: "Memory janitor is not supported" });
      }
      const result = await store.runMemoryJanitor({
        namespace: req.body?.namespace,
        minUses: req.body?.minUses,
        pollutionRateThreshold: req.body?.pollutionRateThreshold,
        dryRun: req.body?.dryRun,
      });
      return reply.send(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // POST /api/memories/consolidate - Decay, dedup, prune memories
  app.post<{ Querystring: { namespace?: string } }>(
    "/api/memories/consolidate",
    async (req, reply) => {
      try {
        const store = ctx.memoryStore as {
          consolidate?: (ns?: string) => Promise<unknown>;
        };
        if (!store.consolidate) {
          return reply
            .status(501)
            .send({ error: "Consolidation not supported" });
        }
        const result = await store.consolidate(
          req.query.namespace || undefined,
        );
        return reply.send(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // PATCH /api/memories/:id - Correct memory content/type/importance/metadata
  app.patch<{
    Params: { id: string };
    Body: {
      type?: string;
      content?: string;
      importance?: number;
      metadata?: Record<string, unknown>;
    };
  }>(
    "/api/memories/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          properties: {
            type: { type: "string" },
            content: { type: "string", minLength: 1 },
            importance: { type: "number", minimum: 0, maximum: 1 },
            metadata: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const existing = await ctx.memoryStore.get(req.params.id);
        if (!existing) {
          return reply.status(404).send({ error: "Memory not found" });
        }
        const type = validateMemoryType(req.body.type);
        const importance = validateImportance(req.body.importance);
        const updated = await ctx.memoryStore.update(req.params.id, {
          type,
          content: req.body.content?.trim(),
          importance,
          metadata: req.body.metadata
            ? { ...existing.metadata, ...req.body.metadata }
            : undefined,
        });
        return reply.send(serializeMemory(updated));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: message });
      }
    },
  );

  // POST /api/memories/:id/deprecate - Soft-hide stale memory with audit metadata
  app.post<{
    Params: { id: string };
    Body: { reason?: string };
  }>(
    "/api/memories/:id/deprecate",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          properties: { reason: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      try {
        const existing = await ctx.memoryStore.get(req.params.id);
        if (!existing) {
          return reply.status(404).send({ error: "Memory not found" });
        }
        const updated = await ctx.memoryStore.update(req.params.id, {
          metadata: {
            ...existing.metadata,
            status: "deprecated",
            deprecatedReason: req.body?.reason?.trim() || "manual",
            deprecatedAt: new Date().toISOString(),
          },
        });
        return reply.send(serializeMemory(updated));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // POST /api/memories/merge - Create/update a canonical memory and supersede sources
  app.post<{
    Body: {
      sourceIds: string[];
      targetId?: string;
      content: string;
      type?: string;
      importance?: number;
      namespace?: string;
    };
  }>(
    "/api/memories/merge",
    {
      schema: {
        body: {
          type: "object",
          required: ["sourceIds", "content"],
          properties: {
            sourceIds: {
              type: "array",
              minItems: 2,
              items: { type: "string", minLength: 1 },
            },
            targetId: { type: "string" },
            content: { type: "string", minLength: 1 },
            type: { type: "string" },
            importance: { type: "number", minimum: 0, maximum: 1 },
            namespace: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const sourceIds = [...new Set(req.body.sourceIds)];
        if (sourceIds.length < 2) {
          return reply
            .status(400)
            .send({ error: "sourceIds must contain at least two memories" });
        }
        const sources = (
          await Promise.all(sourceIds.map((id) => ctx.memoryStore.get(id)))
        ).filter((memory): memory is MemoryEntry => Boolean(memory));
        if (sources.length !== sourceIds.length) {
          return reply
            .status(404)
            .send({ error: "Some source memories were not found" });
        }

        const targetType = validateMemoryType(req.body.type) ?? sources[0].type;
        const importance =
          validateImportance(req.body.importance) ??
          Math.max(...sources.map((source) => source.importance));
        const sourceMemoryIds = sources.map((source) => source.id);
        const metadata = {
          layer: "L1",
          source: "manual_merge",
          confidence: Math.max(
            ...sources.map((source) =>
              typeof source.metadata?.confidence === "number"
                ? source.metadata.confidence
                : 0.8,
            ),
          ),
          sourceMemoryIds,
          evidence: { merged: sourceMemoryIds },
          mergedAt: new Date().toISOString(),
        };

        const target = req.body.targetId
          ? await ctx.memoryStore.update(req.body.targetId, {
              type: targetType,
              content: req.body.content.trim(),
              importance,
              metadata: {
                ...(await ctx.memoryStore.get(req.body.targetId))?.metadata,
                ...metadata,
              },
            })
          : await ctx.memoryStore.add(
              {
                type: targetType,
                content: req.body.content.trim(),
                importance,
                metadata,
              },
              req.body.namespace || "default",
            );

        const deprecatedIds: string[] = [];
        for (const source of sources) {
          if (source.id === target.id) continue;
          await ctx.memoryStore.update(source.id, {
            metadata: {
              ...source.metadata,
              status: "superseded",
              supersededBy: target.id,
              supersededAt: new Date().toISOString(),
            },
          });
          deprecatedIds.push(source.id);
        }

        return reply.send({
          target: serializeMemory(target),
          deprecatedIds,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: message });
      }
    },
  );

  // DELETE /api/memories/:id - Delete memory
  app.delete<{ Params: { id: string } }>(
    "/api/memories/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      try {
        await ctx.memoryStore.delete(req.params.id);
        return reply.status(204).send();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );
}
