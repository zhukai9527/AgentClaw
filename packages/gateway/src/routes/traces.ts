import type { FastifyInstance } from "fastify";
import type { AppContext } from "../bootstrap.js";

export function registerTraceRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  // List traces (summary, optional agentId filter)
  app.get<{
    Querystring: { limit?: string; offset?: string; agentId?: string };
  }>(
    "/api/traces",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "string", pattern: "^[0-9]+$" },
            offset: { type: "string", pattern: "^[0-9]+$" },
            agentId: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const limit = Math.min(
          Math.max(parseInt(req.query.limit || "20", 10) || 20, 1),
          200,
        );
        const offset = Math.max(parseInt(req.query.offset || "0", 10) || 0, 0);
        const agentId = req.query.agentId || undefined;
        const result = await ctx.memoryStore.getTraces(limit, offset, agentId);
        return reply.send(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // Per-agent usage stats
  app.get<{
    Params: { agentId: string };
    Querystring: { hours?: string };
  }>("/api/agents/:agentId/usage", async (req, reply) => {
    try {
      const hours = Math.max(parseInt(req.query.hours || "24", 10) || 24, 1);
      const usage = ctx.memoryStore.getAgentUsage(req.params.agentId, hours);
      return reply.send(usage);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // Get latest trace
  app.get("/api/traces/latest", async (_req, reply) => {
    try {
      const result = await ctx.memoryStore.getTraces(1, 0);
      if (result.items.length === 0) {
        return reply.status(404).send({ error: "No traces found" });
      }
      return reply.send(result.items[0]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // Background task runner stats (today)
  app.get<{
    Querystring: { since?: string };
  }>("/api/task-runner-stats", async (req, reply) => {
    try {
      const since =
        req.query.since || `${new Date().toISOString().slice(0, 10)}T00:00:00`;
      const stats = await ctx.memoryStore.getBackgroundStats(since);
      return reply.send(stats);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // Get trace by ID
  app.get<{
    Params: { id: string };
  }>(
    "/api/traces/:id",
    {
      schema: {
        // 校验路径参数：id 不能为空
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      try {
        const trace = await ctx.memoryStore.getTrace(req.params.id);
        if (!trace) {
          return reply.status(404).send({ error: "Trace not found" });
        }
        return reply.send(trace);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );
}
