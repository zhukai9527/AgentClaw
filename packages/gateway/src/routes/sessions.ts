import type { FastifyInstance } from "fastify";
import type { AppContext } from "../bootstrap.js";
import type {
  ConversationTurn,
  Message,
  ToolExecutionContext,
} from "@agentclaw/types";
import { basename, join, resolve, relative } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";
import { extractText } from "../utils.js";

function serializeSession(session: {
  id: string;
  conversationId: string;
  createdAt: Date;
  lastActiveAt: Date;
  title?: string;
  status?: string;
  projectId?: string;
  preview?: string;
  metadata?: Record<string, unknown>;
}) {
  return {
    id: session.id,
    conversationId: session.conversationId,
    createdAt: session.createdAt.toISOString(),
    lastActiveAt: session.lastActiveAt.toISOString(),
    title: session.title,
    status: session.status ?? "active",
    projectId: session.projectId ?? null,
    preview: session.preview ?? null,
    agentId: (session.metadata?.agentId as string) || "default",
  };
}

function serializeMessage(msg: Message) {
  return {
    role: msg.role,
    content: extractText(msg.content),
    model: msg.model,
    tokensIn: msg.tokensIn,
    tokensOut: msg.tokensOut,
    durationMs: msg.durationMs,
    toolCallCount: msg.toolCallCount,
    createdAt: msg.createdAt.toISOString(),
  };
}

function serializeTurn(turn: ConversationTurn) {
  return {
    id: turn.id,
    parentId: turn.parentId ?? null,
    branchId: turn.branchId ?? "main",
    role: turn.role,
    content: turn.content,
    model: turn.model,
    tokensIn: turn.tokensIn,
    tokensOut: turn.tokensOut,
    durationMs: turn.durationMs,
    toolCallCount: turn.toolCallCount,
    traceId: turn.traceId,
    createdAt: turn.createdAt.toISOString(),
    ...(turn.toolCalls ? { toolCalls: turn.toolCalls } : {}),
    ...(turn.toolResults ? { toolResults: turn.toolResults } : {}),
  };
}

function createRestToolContext(): ToolExecutionContext {
  const tmpDir = resolve(process.cwd(), "data", "tmp");
  const sentFiles: Array<{ url: string; filename: string }> = [];
  return {
    sentFiles,
    sendFile: async (filePath: string) => {
      const filename = basename(filePath);
      const abs = resolve(filePath);
      let relPath = filename;
      if (abs.startsWith(tmpDir)) {
        relPath = relative(tmpDir, abs).replace(/\\/g, "/");
      } else {
        mkdirSync(tmpDir, { recursive: true });
        try {
          copyFileSync(abs, join(tmpDir, filename));
        } catch {}
      }
      const url = `/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
      if (!sentFiles.some((f) => f.url === url)) {
        sentFiles.push({ url, filename });
      }
    },
  };
}

function serializeTree(
  tree: Awaited<ReturnType<AppContext["orchestrator"]["getSessionTree"]>>,
) {
  if (!tree) return undefined;
  return {
    conversationId: tree.conversationId,
    activeLeafId: tree.activeLeafId,
    turns: tree.turns.map(serializeTurn),
  };
}

function buildAutoRecoveryPrompt(
  originalContent: string,
  failedToolNames: string[],
): string {
  const failedTools = failedToolNames.join(", ");
  return [
    "[自动恢复分支]",
    failedTools
      ? `上一条执行路径失败，失败工具：${failedTools}。本轮禁止再调用这些失败工具。`
      : "上一条执行路径失败。本轮必须换一种执行路径。",
    "请基于下面的原始请求继续完成任务；如果被禁用的工具是唯一可行路径，直接说明阻塞原因和下一步需要的人类输入，不要重复失败工具调用。",
    "",
    "原始请求：",
    originalContent,
  ].join("\n");
}

export function registerSessionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  // POST /api/sessions - Create session (optional agentId, projectId in body)
  app.post<{ Body: { agentId?: string; projectId?: string } }>(
    "/api/sessions",
    async (req, reply) => {
      try {
        const agentId = req.body?.agentId || "default";
        const projectId = req.body?.projectId;
        const session = await ctx.orchestrator.createSession({
          agentId,
          channel: "web",
        });
        // Attach project if specified
        if (projectId) {
          (session as { projectId?: string }).projectId = projectId;
          await ctx.memoryStore.saveSession(session);
        }
        return reply.send(serializeSession(session));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // GET /api/sessions - List sessions (optional ?projectId=xxx filter)
  app.get<{ Querystring: { projectId?: string } }>(
    "/api/sessions",
    async (req, reply) => {
      try {
        const sessions = await ctx.orchestrator.listSessions();
        const { projectId } = req.query;
        const filtered = projectId
          ? sessions.filter(
              (s) =>
                (s as typeof s & { projectId?: string }).projectId ===
                projectId,
            )
          : sessions;
        return reply.send(
          filtered.map((s) =>
            serializeSession(
              s as typeof s & { metadata?: Record<string, unknown> },
            ),
          ),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // GET /api/active-loops - List session IDs with active agent loops
  app.get("/api/active-loops", async (_req, reply) => {
    return reply.send(ctx.orchestrator.getActiveSessionIds());
  });

  // DELETE /api/sessions/:id - Close session
  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id",
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
        await ctx.orchestrator.closeSession(req.params.id);
        return reply.status(204).send();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // PATCH /api/sessions/:id - Update session (title, status, projectId)
  app.patch<{
    Params: { id: string };
    Body: { title?: string; status?: string; projectId?: string | null };
  }>(
    "/api/sessions/:id",
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
        const session = await ctx.orchestrator.getSession(req.params.id);
        if (!session) {
          return reply.status(404).send({ error: "Session not found" });
        }
        const updates: Parameters<typeof ctx.orchestrator.updateSession>[1] =
          {};
        if (req.body.title !== undefined) {
          updates.title = req.body.title;
          updates.metadata = { ...session.metadata, titleSource: "manual" };
        }
        if (req.body.status !== undefined)
          updates.status = req.body.status as typeof updates.status;
        if (req.body.projectId !== undefined) {
          updates.projectId = req.body.projectId ?? undefined;
        }
        const updated = await ctx.orchestrator.updateSession(
          req.params.id,
          updates,
        );
        if (!updated) {
          return reply.status(404).send({ error: "Session not found" });
        }
        return reply.send(serializeSession(updated));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // POST /api/sessions/:id/chat - Send message
  app.post<{ Params: { id: string }; Body: { content: string } }>(
    "/api/sessions/:id/chat",
    {
      schema: {
        // 校验路径参数：id 不能为空
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        // 校验请求体：content 必填，至少 1 个字符
        body: {
          type: "object",
          required: ["content"],
          properties: {
            content: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { id } = req.params;
        const { content } = req.body;

        const session = await ctx.orchestrator.getSession(id);
        if (!session) {
          return reply.status(404).send({ error: `Session not found: ${id}` });
        }

        // Provide sendFile so tools like send_file work in REST mode too
        const toolContext = createRestToolContext();
        const message = await ctx.orchestrator.processInput(
          id,
          content,
          toolContext,
        );
        return reply.send({ message: serializeMessage(message) });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // POST /api/sessions/:id/recover-branch - Replace a failed user turn with a new branch input
  app.post<{
    Params: { id: string };
    Body: { fromTurnId: string; content: string };
  }>(
    "/api/sessions/:id/recover-branch",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["fromTurnId", "content"],
          properties: {
            fromTurnId: { type: "string", minLength: 1 },
            content: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const session = await ctx.orchestrator.getSession(req.params.id);
        if (!session) {
          return reply
            .status(404)
            .send({ error: `Session not found: ${req.params.id}` });
        }
        const tree = await ctx.orchestrator.getSessionTree(req.params.id);
        if (!tree) {
          return reply
            .status(404)
            .send({ error: `Session not found: ${req.params.id}` });
        }
        const sourceTurn = tree.turns.find(
          (turn) => turn.id === req.body.fromTurnId,
        );
        if (!sourceTurn) {
          return reply.status(400).send({
            error: `Turn not found in session: ${req.body.fromTurnId}`,
          });
        }
        if (sourceTurn.role !== "user") {
          return reply.status(400).send({
            error: "recover-branch requires a user turn as fromTurnId",
          });
        }

        const toolContext = createRestToolContext();
        const message = await ctx.orchestrator.processInput(
          req.params.id,
          req.body.content,
          {
            ...toolContext,
            conversationParentTurnId: sourceTurn.parentId ?? null,
            conversationBranchId: `recovery:${sourceTurn.id}`,
          },
        );
        const updatedTree = await ctx.orchestrator.getSessionTree(
          req.params.id,
        );
        return reply.send({
          message: serializeMessage(message),
          tree: serializeTree(updatedTree),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // POST /api/sessions/:id/auto-recover-branch - Retry a failed user turn on a controlled branch
  app.post<{ Params: { id: string }; Body: { fromTurnId: string } }>(
    "/api/sessions/:id/auto-recover-branch",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["fromTurnId"],
          properties: {
            fromTurnId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const session = await ctx.orchestrator.getSession(req.params.id);
        if (!session) {
          return reply
            .status(404)
            .send({ error: `Session not found: ${req.params.id}` });
        }
        const tree = await ctx.orchestrator.getSessionTree(req.params.id);
        if (!tree) {
          return reply
            .status(404)
            .send({ error: `Session not found: ${req.params.id}` });
        }
        const sourceTurn = tree.turns.find(
          (turn) => turn.id === req.body.fromTurnId,
        );
        if (!sourceTurn) {
          return reply.status(400).send({
            error: `Turn not found in session: ${req.body.fromTurnId}`,
          });
        }
        if (sourceTurn.role !== "user") {
          return reply.status(400).send({
            error: "auto-recover-branch requires a user turn as fromTurnId",
          });
        }
        const traces = await ctx.memoryStore.getTraces(
          50,
          0,
          undefined,
          session.conversationId,
        );
        const suggestion = traces.items
          .map((trace) => trace.branchRecovery)
          .find(
            (candidate) =>
              candidate !== undefined && candidate.fromTurnId === sourceTurn.id,
          );
        if (!suggestion) {
          return reply.status(400).send({
            error: `No recovery suggestion found for turn: ${sourceTurn.id}`,
          });
        }

        const failedToolNames = suggestion.failedToolNames ?? [];
        const toolContext = createRestToolContext();
        const message = await ctx.orchestrator.processInput(
          req.params.id,
          buildAutoRecoveryPrompt(sourceTurn.content, failedToolNames),
          {
            ...toolContext,
            conversationParentTurnId: sourceTurn.parentId ?? null,
            conversationBranchId: `auto-recovery:${sourceTurn.id}`,
            originalUserText: failedToolNames.length
              ? `[自动恢复分支] 已从失败路径换路恢复；本轮禁用失败工具：${failedToolNames.join(", ")}。`
              : "[自动恢复分支] 已从失败路径换路恢复。",
            toolPolicy:
              failedToolNames.length > 0
                ? { deny: failedToolNames }
                : undefined,
          },
        );
        const updatedTree = await ctx.orchestrator.getSessionTree(
          req.params.id,
        );
        return reply.send({
          message: serializeMessage(message),
          deniedTools: failedToolNames,
          tree: serializeTree(updatedTree),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // GET /api/sessions/:id/history - Get conversation history
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/sessions/:id/history",
    {
      schema: {
        // 校验路径参数：id 不能为空
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        // 校验查询参数：limit 可选，数字字符串
        querystring: {
          type: "object",
          properties: {
            limit: { type: "string", pattern: "^[0-9]+$" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { id } = req.params;
        const limit = req.query.limit
          ? parseInt(req.query.limit, 10)
          : undefined;

        const session = await ctx.orchestrator.getSession(id);
        if (!session) {
          return reply.status(404).send({ error: `Session not found: ${id}` });
        }

        const turns = await ctx.memoryStore.getHistory(
          session.conversationId,
          limit,
        );
        const messages = turns.map((turn) => ({
          role: turn.role,
          content: turn.content,
          model: turn.model,
          tokensIn: turn.tokensIn,
          tokensOut: turn.tokensOut,
          durationMs: turn.durationMs,
          toolCallCount: turn.toolCallCount,
          createdAt: turn.createdAt.toISOString(),
          ...(turn.toolCalls ? { toolCalls: turn.toolCalls } : {}),
          ...(turn.toolResults ? { toolResults: turn.toolResults } : {}),
        }));

        return reply.send(messages);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // GET /api/sessions/:id/tree - Get full conversation tree
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/tree",
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
        const tree = await ctx.orchestrator.getSessionTree(req.params.id);
        if (!tree) {
          return reply
            .status(404)
            .send({ error: `Session not found: ${req.params.id}` });
        }
        return reply.send({
          conversationId: tree.conversationId,
          activeLeafId: tree.activeLeafId,
          turns: tree.turns.map(serializeTurn),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // POST /api/sessions/:id/active-leaf - Switch current branch pointer
  app.post<{ Params: { id: string }; Body: { turnId?: string | null } }>(
    "/api/sessions/:id/active-leaf",
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
            turnId: {
              anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const tree = await ctx.orchestrator.setSessionActiveLeaf(
          req.params.id,
          req.body.turnId ?? null,
        );
        if (!tree) {
          return reply
            .status(404)
            .send({ error: `Session not found: ${req.params.id}` });
        }
        return reply.send({
          conversationId: tree.conversationId,
          activeLeafId: tree.activeLeafId,
          turns: tree.turns.map(serializeTurn),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // GET /api/sessions/:id/recovery-suggestions - List branch recovery points
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/recovery-suggestions",
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
        const session = await ctx.orchestrator.getSession(req.params.id);
        if (!session) {
          return reply
            .status(404)
            .send({ error: `Session not found: ${req.params.id}` });
        }
        const traces = await ctx.memoryStore.getTraces(
          50,
          0,
          undefined,
          session.conversationId,
        );
        const activeTurns = await ctx.memoryStore.getHistory(
          session.conversationId,
        );
        const activeTurnIds = new Set(activeTurns.map((turn) => turn.id));
        const suggestions = traces.items
          .map((trace) => trace.branchRecovery)
          .filter(
            (suggestion): suggestion is NonNullable<typeof suggestion> =>
              suggestion !== undefined &&
              activeTurnIds.has(suggestion.fromTurnId),
          )
          .map((suggestion) => ({
            ...suggestion,
            createdAt: suggestion.createdAt.toISOString(),
          }));
        return reply.send(suggestions);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // DELETE /api/sessions/:id/turns?from=<ISO timestamp>
  // Truncate conversation history from a given timestamp (inclusive)
  app.delete<{ Params: { id: string }; Querystring: { from: string } }>(
    "/api/sessions/:id/turns",
    async (req, reply) => {
      try {
        const { id } = req.params;
        const from = req.query.from;
        if (!from) {
          return reply
            .status(400)
            .send({ error: 'Missing required query param "from"' });
        }

        const session = await ctx.orchestrator.getSession(id);
        if (!session) {
          return reply.status(404).send({ error: `Session not found: ${id}` });
        }

        if (!ctx.memoryStore.deleteTurnsFrom) {
          return reply
            .status(501)
            .send({ error: "deleteTurnsFrom not supported" });
        }

        const deleted = await ctx.memoryStore.deleteTurnsFrom(
          session.conversationId,
          from,
        );
        return reply.send({ deleted });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );
}
