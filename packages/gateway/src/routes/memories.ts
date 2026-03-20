import type { FastifyInstance } from "fastify";
import type { AppContext } from "../bootstrap.js";
import type { MemoryType } from "@agentclaw/types";

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

        const memories = results.map((r) => ({
          id: r.entry.id,
          type: r.entry.type,
          content: r.entry.content,
          importance: r.entry.importance,
          namespace:
            (r.entry as Record<string, unknown>).namespace || "default",
          createdAt: r.entry.createdAt.toISOString(),
          accessedAt: r.entry.accessedAt.toISOString(),
          accessCount: r.entry.accessCount,
        }));

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
