import type { FastifyInstance } from "fastify";
import type {
  AgentProfile,
  AgentApiKey,
  FileSourceConfig,
} from "@agentclaw/types";
import type { AppContext } from "../bootstrap.js";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { resolve, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { ingestFile, type KnowledgeChunkStore } from "@agentclaw/tools";
import { extractFileContent } from "../knowledge-preprocess.js";

const AGENTS_DIR = resolve(process.cwd(), "data", "agents");

/** Read a single agent from data/agents/<id>/ */
function readAgentFromFs(id: string): AgentProfile | null {
  const dir = resolve(AGENTS_DIR, id);
  if (!existsSync(dir)) return null;

  const soulPath = resolve(dir, "SOUL.md");
  const configPath = resolve(dir, "config.json");

  const soul = existsSync(soulPath)
    ? readFileSync(soulPath, "utf-8").trim()
    : "";

  let config: Partial<AgentProfile> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {}
  }

  return {
    id,
    name: config.name ?? id,
    description: config.description ?? "",
    avatar: config.avatar ?? "",
    soul,
    model: config.model,
    tools: config.tools,
    maxIterations: config.maxIterations,
    temperature: config.temperature,
    sortOrder: config.sortOrder ?? 0,
    apiKeys: config.apiKeys,
    knowledgeSources: config.knowledgeSources,
    memoryNamespace: config.memoryNamespace,
    disabledSkills: config.disabledSkills,
    isPublished: config.isPublished,
    rateLimits: config.rateLimits,
  };
}

/** Read all agents from data/agents/ */
export function loadAgentsFromFs(): AgentProfile[] {
  mkdirSync(AGENTS_DIR, { recursive: true });
  const entries = readdirSync(AGENTS_DIR, { withFileTypes: true });
  const agents: AgentProfile[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agent = readAgentFromFs(entry.name);
    if (agent) agents.push(agent);
  }

  // default first, then by sortOrder, then alphabetical
  agents.sort((a, b) => {
    if (a.id === "default") return -1;
    if (b.id === "default") return 1;
    if (a.sortOrder !== b.sortOrder)
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    return a.name.localeCompare(b.name);
  });

  return agents;
}

/** Write an agent profile to data/agents/<id>/ (config.json + SOUL.md) */
function writeAgentToFs(agent: AgentProfile): void {
  const dir = resolve(AGENTS_DIR, agent.id);
  mkdirSync(dir, { recursive: true });

  writeFileSync(resolve(dir, "SOUL.md"), agent.soul || "", "utf-8");

  const config: Record<string, unknown> = {
    name: agent.name,
    description: agent.description,
    avatar: agent.avatar,
  };
  if (agent.model) config.model = agent.model;
  if (agent.tools) config.tools = agent.tools;
  if (agent.temperature !== undefined) config.temperature = agent.temperature;
  if (agent.maxIterations !== undefined)
    config.maxIterations = agent.maxIterations;
  if (agent.sortOrder) config.sortOrder = agent.sortOrder;
  if (agent.apiKeys?.length) config.apiKeys = agent.apiKeys;
  if (agent.knowledgeSources?.length)
    config.knowledgeSources = agent.knowledgeSources;
  if (agent.memoryNamespace) config.memoryNamespace = agent.memoryNamespace;
  if (agent.disabledSkills?.length)
    config.disabledSkills = agent.disabledSkills;
  if (agent.isPublished !== undefined) config.isPublished = agent.isPublished;
  if (agent.rateLimits) config.rateLimits = agent.rateLimits;
  writeFileSync(
    resolve(dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf-8",
  );
}

/** Remove agent directory from filesystem */
function removeAgentFromFs(id: string): void {
  const dir = resolve(AGENTS_DIR, id);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function registerAgentRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  // GET /api/agents
  app.get("/api/agents", async (_req, reply) => {
    const agents = loadAgentsFromFs();
    return reply.send(agents);
  });

  // POST /api/agents
  app.post<{
    Body: {
      id: string;
      name: string;
      description?: string;
      avatar?: string;
      soul?: string;
      model?: string;
      tools?: string[];
      maxIterations?: number;
      temperature?: number;
      sortOrder?: number;
      disabledSkills?: string[];
      isPublished?: boolean;
      rateLimits?: { requestsPerMinute?: number; requestsPerDay?: number };
    };
  }>("/api/agents", async (req, reply) => {
    const body = req.body;
    if (!body?.id || !body?.name) {
      return reply.status(400).send({ error: "id and name are required" });
    }
    if (readAgentFromFs(body.id)) {
      return reply
        .status(409)
        .send({ error: `Agent "${body.id}" already exists` });
    }
    const agent: AgentProfile = {
      id: body.id,
      name: body.name,
      description: body.description ?? "",
      avatar: body.avatar ?? "",
      soul: body.soul ?? "",
      model: body.model,
      tools: body.tools,
      maxIterations: body.maxIterations,
      temperature: body.temperature,
      sortOrder: body.sortOrder ?? 0,
      memoryNamespace: body.id,
      disabledSkills: body.disabledSkills,
      isPublished: body.isPublished,
      rateLimits: body.rateLimits,
    };
    writeAgentToFs(agent);
    ctx.refreshAgents();
    return reply.status(201).send(agent);
  });

  // PUT /api/agents/:id
  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      avatar?: string;
      soul?: string;
      model?: string;
      tools?: string[];
      maxIterations?: number;
      temperature?: number;
      sortOrder?: number;
      disabledSkills?: string[];
      isPublished?: boolean;
      rateLimits?: { requestsPerMinute?: number; requestsPerDay?: number };
    };
  }>("/api/agents/:id", async (req, reply) => {
    const existing = readAgentFromFs(req.params.id);
    if (!existing) {
      return reply.status(404).send({ error: "Agent not found" });
    }
    const updated: AgentProfile = {
      ...existing,
      ...req.body,
      id: req.params.id,
    };
    writeAgentToFs(updated);
    ctx.refreshAgents();
    return reply.send(updated);
  });

  // DELETE /api/agents/:id
  app.delete<{ Params: { id: string } }>(
    "/api/agents/:id",
    async (req, reply) => {
      if (req.params.id === "default") {
        return reply
          .status(400)
          .send({ error: "Cannot delete the default agent" });
      }
      removeAgentFromFs(req.params.id);
      ctx.refreshAgents();
      return reply.status(204).send();
    },
  );

  // ─── API Key Management ───────────────────────────────────

  // POST /api/agents/:id/api-keys — Generate a new API key
  app.post<{
    Params: { id: string };
    Body: { name?: string; expiresAt?: string };
  }>("/api/agents/:id/api-keys", async (req, reply) => {
    const agent = readAgentFromFs(req.params.id);
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
    }
    const keyId = randomBytes(4).toString("hex");
    const secret = randomBytes(16).toString("hex");
    const newKey: AgentApiKey = {
      keyId,
      key: `ac_${agent.id}_${secret}`,
      name: req.body?.name || "default",
      createdAt: new Date().toISOString(),
      expiresAt: req.body?.expiresAt,
    };
    agent.apiKeys = [...(agent.apiKeys || []), newKey];
    writeAgentToFs(agent);
    ctx.refreshAgents();
    // Return the full key only on creation — it won't be shown again
    return reply.status(201).send(newKey);
  });

  // GET /api/agents/:id/api-keys — List API keys (masked)
  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/api-keys",
    async (req, reply) => {
      const agent = readAgentFromFs(req.params.id);
      if (!agent) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const masked = (agent.apiKeys || []).map((k) => ({
        ...k,
        key: k.key.slice(0, 12) + "..." + k.key.slice(-4),
      }));
      return reply.send(masked);
    },
  );

  // DELETE /api/agents/:id/api-keys/:keyId — Revoke an API key
  app.delete<{ Params: { id: string; keyId: string } }>(
    "/api/agents/:id/api-keys/:keyId",
    async (req, reply) => {
      const agent = readAgentFromFs(req.params.id);
      if (!agent) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const before = agent.apiKeys?.length || 0;
      agent.apiKeys = (agent.apiKeys || []).filter(
        (k) => k.keyId !== req.params.keyId,
      );
      if (agent.apiKeys.length === before) {
        return reply.status(404).send({ error: "API key not found" });
      }
      writeAgentToFs(agent);
      ctx.refreshAgents();
      return reply.status(204).send();
    },
  );

  // ─── Knowledge Source File Upload ───────────────────────────

  // POST /api/agents/:id/knowledge/upload — Upload file and ingest as RAG chunks
  app.post<{ Params: { id: string } }>(
    "/api/agents/:id/knowledge/upload",
    async (req, reply) => {
      const agent = readAgentFromFs(req.params.id);
      if (!agent) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      const file = await req.file();
      if (!file) {
        return reply.status(400).send({ error: "No file uploaded" });
      }

      // Store file in agent knowledge directory
      const knowledgeDir = resolve(AGENTS_DIR, req.params.id, "knowledge");
      mkdirSync(knowledgeDir, { recursive: true });

      const ext = extname(file.filename) || ".txt";
      const fileId = randomBytes(8).toString("hex");
      const savedName = `${fileId}${ext}`;
      const savedPath = resolve(knowledgeDir, savedName);

      await pipeline(file.file, createWriteStream(savedPath));

      // Extract and preprocess content (handles PDF, HTML, plain text)
      const { content, error: extractError } = await extractFileContent(
        savedPath,
        ext,
      );
      if (extractError) {
        return reply.status(400).send({ error: extractError });
      }
      if (!content.trim()) {
        return reply.status(400).send({ error: "File is empty" });
      }

      // Generate a source ID
      const sourceId = `ks_file_${fileId}`;
      const toolName = file.filename
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, "_")
        .slice(0, 40);

      // Get embed function from memory store
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = ctx.memoryStore as any;
      const embedFn = store.getEmbedFn?.();

      // Ingest: chunk → embed → store
      const chunkCount = await ingestFile(
        req.params.id,
        sourceId,
        content,
        store as KnowledgeChunkStore,
        embedFn,
      );

      // Build knowledge source config
      const ksConfig: FileSourceConfig = {
        filename: file.filename,
        storedPath: savedName,
        fileSize: content.length,
        chunkCount,
      };

      const ks = {
        id: sourceId,
        type: "file" as const,
        name: toolName,
        description: `Search the document "${file.filename}" for relevant information`,
        config: ksConfig,
        enabled: true,
      };

      // Append to agent's knowledge sources and save
      agent.knowledgeSources = [...(agent.knowledgeSources || []), ks];
      writeAgentToFs(agent);
      ctx.refreshAgents();

      return reply.status(201).send({
        ...ks,
        chunkCount,
      });
    },
  );

  // DELETE /api/agents/:id/knowledge/:sourceId — Remove a file knowledge source
  app.delete<{ Params: { id: string; sourceId: string } }>(
    "/api/agents/:id/knowledge/:sourceId",
    async (req, reply) => {
      const agent = readAgentFromFs(req.params.id);
      if (!agent) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      const source = agent.knowledgeSources?.find(
        (s) => s.id === req.params.sourceId,
      );
      if (!source) {
        return reply.status(404).send({ error: "Knowledge source not found" });
      }

      // Delete chunks from DB
      ctx.memoryStore.deleteKnowledgeChunks(req.params.id, req.params.sourceId);

      // Delete stored file if it's a file type
      if (source.type === "file") {
        const fc = source.config as FileSourceConfig;
        const filePath = resolve(
          AGENTS_DIR,
          req.params.id,
          "knowledge",
          fc.storedPath,
        );
        if (existsSync(filePath)) {
          rmSync(filePath);
        }
      }

      // Remove from agent config
      agent.knowledgeSources = (agent.knowledgeSources || []).filter(
        (s) => s.id !== req.params.sourceId,
      );
      writeAgentToFs(agent);
      ctx.refreshAgents();

      return reply.status(204).send();
    },
  );
}

/** Find an agent by API key across all agents. Returns null if not found or expired. */
export function findAgentByApiKey(key: string): AgentProfile | null {
  const agents = loadAgentsFromFs();
  for (const agent of agents) {
    if (!agent.apiKeys?.length || !agent.isPublished) continue;
    const match = agent.apiKeys.find((k) => k.key === key);
    if (!match) continue;
    // Check expiration
    if (match.expiresAt && new Date(match.expiresAt) < new Date()) continue;
    // Update lastUsedAt (fire-and-forget, don't block auth)
    match.lastUsedAt = new Date().toISOString();
    try {
      writeAgentToFs(agent);
    } catch {
      /* best-effort */
    }
    return agent;
  }
  return null;
}
