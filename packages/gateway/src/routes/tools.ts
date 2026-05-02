import type { FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  rmSync,
  readdirSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import path from "node:path";
import type { AppContext } from "../bootstrap.js";
import { loadConfig, saveConfig } from "../config.js";
import type {
  EvolutionRunStatus,
  EvolutionTargetType,
  ToolExecutionContext,
} from "@agentclaw/types";

export function registerToolRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  // GET /api/tools - List tools (with disabled state)
  app.get("/api/tools", async (_req, reply) => {
    try {
      const tools = ctx.toolRegistry.list();
      const cfg = loadConfig();
      const disabled = new Set(cfg.disabledTools || []);
      const perms = cfg.toolPermissions || {};
      const result = tools.map((t) => ({
        name: t.name,
        description: t.description,
        category: t.category,
        disabled: disabled.has(t.name),
        permission: perms[t.name]?.mode || "allow",
      }));
      return reply.send(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // PUT /api/tools/:name/disabled - Toggle tool disabled state
  app.put<{ Params: { name: string }; Body: { disabled: boolean } }>(
    "/api/tools/:name/disabled",
    async (req, reply) => {
      try {
        const { name } = req.params;
        const { disabled } = req.body;
        const cfg = loadConfig();
        const set = new Set(cfg.disabledTools || []);
        if (disabled) set.add(name);
        else set.delete(name);
        const list = [...set];
        saveConfig({ disabledTools: list });
        // Update orchestrator in real-time
        (
          ctx.orchestrator as { setDisabledTools?: (t: string[]) => void }
        ).setDisabledTools?.(list);
        return reply.send({ name, disabled });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // PUT /api/tools/:name/permissions - Set tool permission mode
  app.put<{
    Params: { name: string };
    Body: { mode: string; blockedPatterns?: string[] };
  }>("/api/tools/:name/permissions", async (req, reply) => {
    try {
      const { name } = req.params;
      const { mode, blockedPatterns } = req.body;
      const cfg = loadConfig();
      const perms = { ...(cfg.toolPermissions || {}) };
      if (mode === "allow" && !blockedPatterns?.length) {
        delete perms[name];
      } else {
        perms[name] = { mode: mode as "allow" | "deny", blockedPatterns };
      }
      saveConfig({ toolPermissions: perms });
      return reply.send({ name, mode, blockedPatterns });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // GET /api/skills - List skills
  app.get("/api/skills", async (_req, reply) => {
    try {
      const skills = ctx.skillRegistry.list();
      const result = skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        enabled: s.enabled,
      }));
      return reply.send(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // GET /api/skills/usage - Skill usage telemetry
  app.get<{ Querystring: { limit?: string } }>(
    "/api/skills/usage",
    async (req, reply) => {
      try {
        const limit = parseLimit(req.query.limit, 100);
        return reply.send(await ctx.memoryStore.listSkillUsageStats(limit));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // GET /api/skills/changes - Skill lifecycle history
  app.get<{ Querystring: { skillId?: string; limit?: string } }>(
    "/api/skills/changes",
    async (req, reply) => {
      try {
        const limit = parseLimit(req.query.limit, 100);
        return reply.send(
          await ctx.memoryStore.listSkillChangeHistory({
            skillId: req.query.skillId,
            limit,
          }),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // GET /api/evolution/runs - 查询进化账本运行历史
  app.get<{
    Querystring: {
      targetType?: string;
      targetId?: string;
      status?: string;
      triggerTraceId?: string;
      triggerConversationId?: string;
      limit?: string;
    };
  }>("/api/evolution/runs", async (req, reply) => {
    try {
      const limit = parseLimit(req.query.limit, 100);
      return reply.send(
        await ctx.memoryStore.listEvolutionRuns({
          targetType: req.query.targetType as EvolutionTargetType | undefined,
          targetId: req.query.targetId,
          status: req.query.status as EvolutionRunStatus | undefined,
          triggerTraceId: req.query.triggerTraceId,
          triggerConversationId: req.query.triggerConversationId,
          limit,
        }),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // GET /api/evolution/events - 查询进化账本事件历史
  app.get<{
    Querystring: { runId?: string; traceId?: string; limit?: string };
  }>(
    "/api/evolution/events",
    async (req, reply) => {
      try {
        const limit = parseLimit(req.query.limit, 100);
        return reply.send(
          await ctx.memoryStore.listEvolutionEvents({
            runId: req.query.runId,
            traceId: req.query.traceId,
            limit,
          }),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // POST /api/skills/curate - Run curator analyze/status/backup/archive
  app.post<{ Body: Record<string, unknown> }>(
    "/api/skills/curate",
    async (req, reply) => {
      const body = req.body ?? {};
      const result = await ctx.toolRegistry.execute(
        "skill_curator",
        { action: "analyze", dryRun: true, ...body },
        createSkillToolContext(ctx),
      );
      if (result.isError) {
        return reply.status(400).send({ error: result.content });
      }
      return reply.send(result.metadata ?? JSON.parse(result.content));
    },
  );

  // PUT /api/skills/:id/enabled - Toggle skill enabled state
  app.put<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/skills/:id/enabled",
    async (req, reply) => {
      try {
        const { id } = req.params;
        const { enabled } = req.body;
        const skill = ctx.skillRegistry.get(id);
        if (!skill) {
          return reply.status(404).send({ error: "Skill not found" });
        }
        ctx.skillRegistry.setEnabled(id, enabled);
        return reply.send({ id, enabled });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // POST /api/skills/import/github - Import skill from GitHub repository
  app.post<{ Body: { url: string } }>(
    "/api/skills/import/github",
    async (req, reply) => {
      const { url } = req.body;
      if (!url) return reply.status(400).send({ error: "Missing url" });

      // Extract repo name from URL for skill directory name
      const repoName = url
        .replace(/\.git$/, "")
        .split("/")
        .pop();
      if (!repoName)
        return reply.status(400).send({ error: "Invalid GitHub URL" });

      const skillsDir = ctx.config.skillsDir || "./skills/";
      const targetDir = path.join(skillsDir, repoName);

      if (existsSync(targetDir)) {
        return reply
          .status(409)
          .send({ error: `Skill '${repoName}' already exists` });
      }

      try {
        execFileSync("git", ["clone", "--depth", "1", url, targetDir], {
          timeout: 30000,
          windowsHide: true,
        });
      } catch (err) {
        return reply.status(500).send({
          error:
            "Git clone failed: " +
            (err instanceof Error ? err.message : String(err)),
        });
      }

      // Verify SKILL.md exists
      const skillMdPath = path.join(targetDir, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        rmSync(targetDir, { recursive: true, force: true });
        return reply
          .status(400)
          .send({ error: "No SKILL.md found in repository" });
      }

      // fs.watch will auto-detect, wait briefly for it to pick up
      await new Promise((r) => setTimeout(r, 500));
      const skill = ctx.skillRegistry.get(repoName);

      return reply.send({
        success: true,
        skill: skill
          ? {
              id: skill.id,
              name: skill.name,
              description: skill.description,
              enabled: skill.enabled,
            }
          : { id: repoName },
      });
    },
  );

  // POST /api/skills/import/zip - Import skill from uploaded zip file
  app.post("/api/skills/import/zip", async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.status(400).send({ error: "No file uploaded" });

    const skillsDir = ctx.config.skillsDir || "./skills/";

    // Save to temp file
    const tmpDir = path.join(process.cwd(), "data", "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const tmpZip = path.join(tmpDir, `skill-import-${Date.now()}.zip`);
    const buf = await data.toBuffer();
    writeFileSync(tmpZip, buf);

    // Get skill name from filename (without .zip extension)
    const skillName = data.filename.replace(/\.zip$/i, "");
    const targetDir = path.join(skillsDir, skillName);

    if (existsSync(targetDir)) {
      unlinkSync(tmpZip);
      return reply
        .status(409)
        .send({ error: `Skill '${skillName}' already exists` });
    }

    // Extract zip — try tar first (Windows 10+ built-in), fallback to PowerShell
    try {
      mkdirSync(targetDir, { recursive: true });
      try {
        execFileSync("tar", ["-xf", tmpZip, "-C", targetDir], {
          timeout: 15000,
          windowsHide: true,
        });
      } catch {
        // Fallback: PowerShell Expand-Archive (Windows)
        execFileSync(
          "powershell",
          [
            "-Command",
            `Expand-Archive -Path '${tmpZip}' -DestinationPath '${targetDir}'`,
          ],
          {
            timeout: 15000,
            windowsHide: true,
          },
        );
      }
    } catch (_err) {
      rmSync(targetDir, { recursive: true, force: true });
      unlinkSync(tmpZip);
      return reply.status(500).send({ error: "Extraction failed" });
    }

    unlinkSync(tmpZip);

    // Check for SKILL.md — it might be in a subdirectory (common zip wrapping)
    let skillMdPath = path.join(targetDir, "SKILL.md");
    if (!existsSync(skillMdPath)) {
      const entries = readdirSync(targetDir);
      if (entries.length === 1) {
        const nested = path.join(targetDir, entries[0], "SKILL.md");
        if (existsSync(nested)) {
          // Move contents up one level
          const nestedDir = path.join(targetDir, entries[0]);
          for (const f of readdirSync(nestedDir)) {
            renameSync(path.join(nestedDir, f), path.join(targetDir, f));
          }
          rmdirSync(nestedDir);
          skillMdPath = path.join(targetDir, "SKILL.md");
        }
      }
    }

    if (!existsSync(skillMdPath)) {
      rmSync(targetDir, { recursive: true, force: true });
      return reply.status(400).send({ error: "No SKILL.md found in archive" });
    }

    await new Promise((r) => setTimeout(r, 500));
    const skill = ctx.skillRegistry.get(skillName);

    return reply.send({
      success: true,
      skill: skill
        ? {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            enabled: skill.enabled,
          }
        : { id: skillName },
    });
  });

  // DELETE /api/skills/:id - Delete a skill
  app.delete<{ Params: { id: string } }>(
    "/api/skills/:id",
    async (req, reply) => {
      const { id } = req.params;
      const skill = ctx.skillRegistry.get(id);
      if (!skill) return reply.status(404).send({ error: "Skill not found" });

      // Remove the skill directory (skill.path points to SKILL.md)
      const skillDir = path.dirname(skill.path);
      try {
        rmSync(skillDir, { recursive: true, force: true });
      } catch {
        return reply
          .status(500)
          .send({ error: "Failed to delete skill directory" });
      }

      // fs.watch will auto-detect removal
      return reply.send({ success: true });
    },
  );
}

function createSkillToolContext(ctx: AppContext): ToolExecutionContext {
  return {
    skillRegistry: ctx.skillRegistry,
    skillsDir: ctx.config.skillsDir,
    skillArchiveDir: path.join(process.cwd(), "data", "skills-archive"),
    skillBackupDir: path.join(process.cwd(), "data", "skills-backup"),
    recordSkillUsage: (event) => ctx.memoryStore.recordSkillUsage(event),
    listSkillUsageStats: (limit) => ctx.memoryStore.listSkillUsageStats(limit),
    recordSkillChange: (change) => ctx.memoryStore.recordSkillChange(change),
    listSkillChangeHistory: (query) =>
      ctx.memoryStore.listSkillChangeHistory(query),
    recordEvolutionRun: (input) => ctx.memoryStore.recordEvolutionRun(input),
    updateEvolutionRun: (id, updates) =>
      ctx.memoryStore.updateEvolutionRun(id, updates),
    recordEvolutionEvent: (event) =>
      ctx.memoryStore.recordEvolutionEvent(event),
    listEvolutionRuns: (query) => ctx.memoryStore.listEvolutionRuns(query),
    listEvolutionEvents: (query) => ctx.memoryStore.listEvolutionEvents(query),
  };
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}
