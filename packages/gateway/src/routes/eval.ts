import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../bootstrap.js";
import {
  evaluateBatch,
  formatEvalReport,
  type TrajectoryTestCase,
} from "@agentclaw/core";

export function registerEvalRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  /**
   * POST /api/eval/run — Run golden test cases against existing traces.
   *
   * Body:
   *   testCases?: TrajectoryTestCase[]  — inline test cases (takes priority)
   *   file?: string                     — path relative to project root (default: data/golden-testcases.json)
   *   limit?: number                    — max traces to fetch (default 200)
   *   agentId?: string                  — filter traces by agent
   */
  app.post<{
    Body: {
      testCases?: TrajectoryTestCase[];
      file?: string;
      limit?: number;
      agentId?: string;
    };
  }>("/api/eval/run", async (req, reply) => {
    try {
      let testCases = req.body?.testCases;

      if (!testCases || testCases.length === 0) {
        const filePath = resolve(
          process.cwd(),
          req.body?.file ?? "data/golden-testcases.json",
        );
        if (!existsSync(filePath)) {
          return reply
            .status(404)
            .send({ error: `Test case file not found: ${filePath}` });
        }
        const raw = readFileSync(filePath, "utf-8");
        testCases = JSON.parse(raw) as TrajectoryTestCase[];
      }

      const limit = Math.min(req.body?.limit ?? 200, 1000);
      const agentId = req.body?.agentId;

      const { items: traces } = await ctx.memoryStore.getTraces(
        limit,
        0,
        agentId,
      );

      const report = evaluateBatch(testCases, traces);

      return reply.send({
        report,
        formatted: formatEvalReport(report),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });
}
