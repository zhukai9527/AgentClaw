/**
 * Hive Agent API — public endpoints for per-agent access.
 *
 * All routes under /api/v1/agents/:agentId/ are authenticated via per-agent API keys
 * (Bearer token), bypassing the global API key check.
 *
 * Supports two modes:
 * - Stateless: POST /api/v1/agents/:agentId/chat (auto-creates ephemeral session)
 * - Session-based: create session first, then chat within it
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AgentProfile, ToolExecutionContext } from "@agentclaw/types";
import type { AppContext } from "../bootstrap.js";
import { basename, join, resolve, relative } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";
import { findAgentByApiKey } from "./agents.js";
import { extractText } from "../utils.js";

/** Extract Bearer token from request */
function extractBearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

/** Authenticate agent API request. Returns the agent or sends 401/403. */
function authenticateAgent(
  req: FastifyRequest,
  reply: FastifyReply,
): AgentProfile | null {
  const token = extractBearer(req);
  if (!token) {
    reply.status(401).send({ error: "Missing Authorization header" });
    return null;
  }
  const agent = findAgentByApiKey(token);
  if (!agent) {
    reply.status(401).send({ error: "Invalid or expired API key" });
    return null;
  }
  // Verify the URL agentId matches the key's agent
  const params = req.params as Record<string, string>;
  if (params.agentId && params.agentId !== agent.id) {
    reply.status(403).send({ error: "API key does not match agent" });
    return null;
  }
  return agent;
}

/** Build a minimal ToolExecutionContext for REST API calls */
function buildToolContext(): {
  context: ToolExecutionContext;
  sentFiles: Array<{ url: string; filename: string }>;
} {
  const tmpDir = resolve(process.cwd(), "data", "tmp");
  const sentFiles: Array<{ url: string; filename: string }> = [];
  const context: ToolExecutionContext = {
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
  return { context, sentFiles };
}

export function registerAgentApiRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  // ─── Stateless chat ───────────────────────────────────────
  // POST /api/v1/agents/:agentId/chat
  app.post<{
    Params: { agentId: string };
    Body: { input: string };
  }>("/api/v1/agents/:agentId/chat", async (req, reply) => {
    const agent = authenticateAgent(req, reply);
    if (!agent) return;

    const { input } = req.body || {};
    if (!input) {
      return reply.status(400).send({ error: "input is required" });
    }

    try {
      // Create an ephemeral session for this agent
      const session = await ctx.orchestrator.createSession({
        agentId: agent.id,
        channel: "hive-api",
        memoryNamespace: agent.memoryNamespace || agent.id,
      });

      const { context } = buildToolContext();
      const message = await ctx.orchestrator.processInput(
        session.id,
        input,
        context,
      );

      return reply.send({
        sessionId: session.id,
        response: extractText(message.content),
        model: message.model,
        tokensIn: message.tokensIn,
        tokensOut: message.tokensOut,
        durationMs: message.durationMs,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  });

  // ─── Streaming chat ───────────────────────────────────────
  // POST /api/v1/agents/:agentId/chat/stream
  app.post<{
    Params: { agentId: string };
    Body: { input: string; sessionId?: string };
  }>("/api/v1/agents/:agentId/chat/stream", async (req, reply) => {
    const agent = authenticateAgent(req, reply);
    if (!agent) return;

    const { input, sessionId } = req.body || {};
    if (!input) {
      return reply.status(400).send({ error: "input is required" });
    }

    try {
      let sid = sessionId;
      if (!sid) {
        const session = await ctx.orchestrator.createSession({
          agentId: agent.id,
          channel: "hive-api",
          memoryNamespace: agent.memoryNamespace || agent.id,
        });
        sid = session.id;
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const { context } = buildToolContext();
      for await (const event of ctx.orchestrator.processInputStream(
        sid,
        input,
        context,
      )) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!reply.raw.headersSent) {
        return reply.status(500).send({ error: msg });
      }
      reply.raw.write(
        `data: ${JSON.stringify({ type: "error", data: { message: msg } })}\n\n`,
      );
      reply.raw.end();
    }
  });

  // ─── Session management ───────────────────────────────────

  // POST /api/v1/agents/:agentId/sessions — Create a persistent session
  app.post<{
    Params: { agentId: string };
  }>("/api/v1/agents/:agentId/sessions", async (req, reply) => {
    const agent = authenticateAgent(req, reply);
    if (!agent) return;

    const session = await ctx.orchestrator.createSession({
      agentId: agent.id,
      channel: "hive-api",
      memoryNamespace: agent.memoryNamespace || agent.id,
    });

    return reply.status(201).send({
      sessionId: session.id,
      agentId: agent.id,
      createdAt: session.createdAt.toISOString(),
    });
  });

  // POST /api/v1/agents/:agentId/sessions/:sessionId/chat — Chat in session
  app.post<{
    Params: { agentId: string; sessionId: string };
    Body: { input: string };
  }>("/api/v1/agents/:agentId/sessions/:sessionId/chat", async (req, reply) => {
    const agent = authenticateAgent(req, reply);
    if (!agent) return;

    const { input } = req.body || {};
    if (!input) {
      return reply.status(400).send({ error: "input is required" });
    }

    const session = await ctx.orchestrator.getSession(req.params.sessionId);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }
    // Verify session belongs to this agent
    if (session.metadata?.agentId !== agent.id) {
      return reply
        .status(403)
        .send({ error: "Session does not belong to this agent" });
    }

    try {
      const { context } = buildToolContext();
      const message = await ctx.orchestrator.processInput(
        req.params.sessionId,
        input,
        context,
      );

      return reply.send({
        sessionId: req.params.sessionId,
        response: extractText(message.content),
        model: message.model,
        tokensIn: message.tokensIn,
        tokensOut: message.tokensOut,
        durationMs: message.durationMs,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  });

  // GET /api/v1/agents/:agentId/sessions — List sessions for agent
  app.get<{
    Params: { agentId: string };
  }>("/api/v1/agents/:agentId/sessions", async (req, reply) => {
    const agent = authenticateAgent(req, reply);
    if (!agent) return;

    const allSessions = await ctx.orchestrator.listSessions();
    const agentSessions = allSessions
      .filter((s) => s.metadata?.agentId === agent.id)
      .map((s) => ({
        sessionId: s.id,
        title: s.title,
        createdAt: s.createdAt.toISOString(),
        lastActiveAt: s.lastActiveAt.toISOString(),
        status: s.status ?? "active",
      }));

    return reply.send(agentSessions);
  });

  // DELETE /api/v1/agents/:agentId/sessions/:sessionId — Close session
  app.delete<{
    Params: { agentId: string; sessionId: string };
  }>("/api/v1/agents/:agentId/sessions/:sessionId", async (req, reply) => {
    const agent = authenticateAgent(req, reply);
    if (!agent) return;

    const session = await ctx.orchestrator.getSession(req.params.sessionId);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }
    if (session.metadata?.agentId !== agent.id) {
      return reply
        .status(403)
        .send({ error: "Session does not belong to this agent" });
    }

    await ctx.orchestrator.closeSession(req.params.sessionId);
    return reply.status(204).send();
  });
}
