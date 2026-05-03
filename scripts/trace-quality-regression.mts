import { bootstrap } from "../packages/gateway/src/bootstrap.ts";
import { evaluateTraceQuality } from "../packages/core/src/eval.ts";
import type { ToolExecutionContext } from "@agentclaw/types";

const input = process.argv.slice(2).join(" ").trim() || "在外网搜索今日AI界新闻生成简报";

const ctx = await bootstrap();
const session = await ctx.orchestrator.createSession({
  agentId: "default",
  channel: "quality-regression",
});

const sentFiles: Array<{ url: string; filename: string }> = [];
const toolContext: ToolExecutionContext = {
  sentFiles,
  sendFile: async () => undefined,
};

const started = Date.now();
const message = await ctx.orchestrator.processInput(session.id, input, toolContext);
const traces = await ctx.memoryStore.getTraces(10, 0);
const trace =
  traces.items.find((item) => item.conversationId === session.conversationId) ??
  traces.items[0];

const quality = evaluateTraceQuality(trace, {
  maxLlmCalls: 3,
  maxTokensIn: 40_000,
  maxDurationMs: 60_000,
  maxNetworkExecuteCodeCalls: 3,
  maxWebResearchToolCalls: 8,
  maxOverflowFileReadCalls: 2,
  minObservationsCreated: 0,
  minObservationSavingsRate: 0,
  maxObservationFullReads: 0,
  minCacheReadRate: 0.4,
  forbidOverflowFullRead: true,
  failOnZeroScoreCommentsAfterRss: true,
});

ctx.scheduler.stopAll();

console.log(
  JSON.stringify(
    {
      input,
      sessionId: session.id,
      traceId: trace.id,
      wallMs: Date.now() - started,
      responsePreview:
        typeof message.content === "string"
          ? message.content.slice(0, 800)
          : JSON.stringify(message.content).slice(0, 800),
      quality,
    },
    null,
    2,
  ),
);

process.exit(quality.passed ? 0 : 2);
