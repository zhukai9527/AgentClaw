import { mkdirSync, existsSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, basename, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../bootstrap.js";
import { WorkflowRegistryImpl } from "@agentclaw/core";
import {
  loadWorkspaceState,
  saveWorkspaceState,
  setActiveWorkspace,
} from "../workspace.js";

/** Safe directory listing — returns empty array on error */
async function readdirSafe(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}

const WORKSPACES_DIR = resolve(process.cwd(), "data", "workspaces");

/** Load Codex-style skills from a workspace's .codex/skills/ directory */
async function loadCodexSkillsForWorkspace(
  ctx: AppContext,
  workspacePath: string,
): Promise<void> {
  const codexSkillsDir = join(workspacePath, ".codex", "skills");
  await ctx.skillRegistry.loadCodexSkills(codexSkillsDir);
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  // GET /api/workspace/status — current workspace state
  app.get("/api/workspace/status", async (_req, reply) => {
    const state = loadWorkspaceState();
    return reply.send(state);
  });

  // GET /api/workspace/list — list all imported workspaces
  app.get("/api/workspace/list", async (_req, reply) => {
    const { readdirSync, statSync } = await import("node:fs");
    const state = loadWorkspaceState();
    const workspaces: { name: string; path: string; active: boolean }[] = [];
    if (existsSync(WORKSPACES_DIR)) {
      for (const entry of readdirSync(WORKSPACES_DIR)) {
        const full = join(WORKSPACES_DIR, entry);
        if (statSync(full).isDirectory()) {
          workspaces.push({
            name: entry,
            path: full,
            active: full === state.activeWorkspacePath,
          });
        }
      }
    }
    workspaces.sort((a, b) => (a.active ? -1 : b.active ? 1 : a.name.localeCompare(b.name)));
    return reply.send({ workspaces });
  });

  // GET /api/workspace/roots — list available drive roots (Win) or / (Unix)
  app.get("/api/workspace/roots", async (_req, reply) => {
    if (process.platform === "win32") {
      const { accessSync, constants } = await import("node:fs");
      const drives: string[] = [];
      for (let i = 65; i <= 90; i++) {
        const root = String.fromCharCode(i) + ":\\";
        try {
          accessSync(root, constants.R_OK);
          drives.push(root);
        } catch {}
      }
      return reply.send({ roots: drives.length > 0 ? drives : ["C:\\"] });
    }
    return reply.send({ roots: ["/"] });
  });

  // GET /api/workspace/projects — list scanned projects in active workspace
  app.get("/api/workspace/projects", async (_req, reply) => {
    const state = loadWorkspaceState();
    if (!state.activeWorkspacePath) {
      return reply.send({ projects: [] });
    }
    const targetDir = join(state.activeWorkspacePath, "target");
    const projects: { name: string; path: string }[] = [];
    if (existsSync(targetDir)) {
      const { readdirSync, statSync } = await import("node:fs");
      for (const entry of readdirSync(targetDir)) {
        const fullPath = join(targetDir, entry);
        if (statSync(fullPath).isDirectory()) {
          projects.push({ name: entry, path: fullPath });
        }
      }
    }
    return reply.send({ projects });
  });

  // GET /api/workspace/workflows — list workflow YAML files in active workspace
  app.get("/api/workspace/workflows", async (_req, reply) => {
    const state = loadWorkspaceState();
    if (!state.activeWorkspacePath) {
      return reply.send({ workflows: [], poolEntries: [] });
    }
    const registry = new WorkflowRegistryImpl();

    try {
      // Load Codex skills from workspace (idempotent — skips existing skills)
      await loadCodexSkillsForWorkspace(ctx, state.activeWorkspacePath);

      // Scan top-level workflows/ directory (legacy flat format)
      const workflowsDir = join(state.activeWorkspacePath, "workflows");
      await registry.scanDirectory(workflowsDir);

      // Scan Codex-style indexes/ directory if present
      const codexSkillsDir = join(state.activeWorkspacePath, ".codex", "skills");
      const entries = await readdirSafe(codexSkillsDir);
      for (const entry of entries) {
        const indexesDir = join(codexSkillsDir, entry, "workflow", "indexes");
        await registry.scanIndexDirectory(indexesDir);
      }
    } catch (err) {
      console.error("[workspace] Error scanning workflows:", err);
    }

    return reply.send({
      workflows: registry.list(),
      poolEntries: registry.getPoolEntries(),
    });
  });

  // GET /api/workspace/workflows/find-by-type — find workflow by task type
  app.get<{ Querystring: { type: string } }>(
    "/api/workspace/workflows/find-by-type",
    async (req, reply) => {
      const state = loadWorkspaceState();
      if (!state.activeWorkspacePath) {
        return reply.status(400).send({ error: "No active workspace" });
      }
      const { type } = req.query;
      if (!type) {
        return reply.status(400).send({ error: "type is required" });
      }
      const codexSkillsDir = join(state.activeWorkspacePath, ".codex", "skills");
      const registry = new WorkflowRegistryImpl();
      for (const skillDir of await readdirSafe(codexSkillsDir)) {
        const indexesDir = join(codexSkillsDir, skillDir, "workflow", "indexes");
        await registry.scanIndexDirectory(indexesDir);
      }
      const match = registry.findByTaskType(type);
      if (!match) {
        return reply.send({ found: false });
      }
      return reply.send({ found: true, workflow: match });
    },
  );

  // PUT /api/workspace/workflows/:name — save/update workflow YAML
  app.put<{ Params: { name: string }; Body: { definition: any } }>(
    "/api/workspace/workflows/:name",
    async (req, reply) => {
      const state = loadWorkspaceState();
      if (!state.activeWorkspacePath) {
        return reply.status(400).send({ error: "No active workspace" });
      }
      const { name } = req.params;
      const { definition } = req.body;
      if (!definition || !definition.name || !Array.isArray(definition.steps)) {
        return reply.status(400).send({ error: "Invalid workflow definition" });
      }
      const workflowsDir = join(state.activeWorkspacePath, "workflows");
      mkdirSync(workflowsDir, { recursive: true });
      const { stringify } = await import("yaml");
      const yamlContent = stringify(definition);
      const filePath = join(workflowsDir, name.endsWith(".yaml") ? name : `${name}.yaml`);
      writeFileSync(filePath, yamlContent, "utf8");
      return reply.send({ ok: true, path: filePath });
    },
  );

  // DELETE /api/workspace/workflows/:name — delete workflow YAML
  app.delete<{ Params: { name: string } }>(
    "/api/workspace/workflows/:name",
    async (req, reply) => {
      const state = loadWorkspaceState();
      if (!state.activeWorkspacePath) {
        return reply.status(400).send({ error: "No active workspace" });
      }
      const { name } = req.params;
      const filePath = join(
        state.activeWorkspacePath,
        "workflows",
        name.endsWith(".yaml") ? name : `${name}.yaml`,
      );
      if (!existsSync(filePath)) {
        return reply.status(404).send({ error: `Workflow not found: ${name}` });
      }
      rmSync(filePath);
      return reply.send({ ok: true });
    },
  );

  // POST /api/workspace/tasks — create a new task
  app.post<{ Body: { title: string; description?: string; priority?: string } }>(
    "/api/workspace/tasks",
    async (req, reply) => {
      const { title, description, priority } = req.body ?? {};
      if (!title) {
        return reply.status(400).send({ error: "title is required" });
      }
      const state = loadWorkspaceState();
      const task = {
        id: `task-${Date.now()}`,
        title,
        description: description || "",
        status: "todo",
        priority: priority || "medium",
        workspacePath: state.activeWorkspacePath,
        createdAt: new Date().toISOString(),
      };
      const tasksDir = resolve(process.cwd(), "data", "workspace-tasks");
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, `${task.id}.json`), JSON.stringify(task, null, 2), "utf8");
      return reply.send(task);
    },
  );

  // POST /api/workspace/import — clone git repo or copy local directory as workspace
  app.post<{
    Body: { remoteUrl?: string; localPath?: string; name?: string };
  }>("/api/workspace/import", async (req, reply) => {
    const { remoteUrl, localPath, name } = req.body ?? {};
    if (!remoteUrl && !localPath) {
      return reply.status(400).send({ error: "remoteUrl or localPath is required" });
    }

    let dirName: string;
    if (localPath) {
      if (!existsSync(localPath)) {
        return reply.status(400).send({ error: `Local path not found: ${localPath}` });
      }
      dirName = name || basename(localPath);
    } else {
      dirName = name || remoteUrl!.split("/").pop()?.replace(/\.git$/, "") || "workspace";
    }

    const targetPath = join(WORKSPACES_DIR, dirName);
    if (existsSync(targetPath)) {
      setActiveWorkspace(targetPath);
      await loadCodexSkillsForWorkspace(ctx, targetPath);
      return reply.send({
        ok: true,
        name: dirName,
        path: targetPath,
        existed: true,
      });
    }

    mkdirSync(WORKSPACES_DIR, { recursive: true });

    if (localPath) {
      try {
        cpSync(localPath, targetPath, { recursive: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: `Copy failed: ${msg}` });
      }
    } else {
      try {
        execSync(`git clone "${remoteUrl}" "${targetPath}"`, {
          stdio: "pipe",
          timeout: 120_000,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: `Git clone failed: ${msg}` });
      }
    }

    setActiveWorkspace(targetPath);
    await loadCodexSkillsForWorkspace(ctx, targetPath);
    return reply.send({
      ok: true,
      name: dirName,
      path: targetPath,
    });
  });

  // GET /api/workspace/browse — list directories at a given path
  app.get<{ Querystring: { path?: string } }>(
    "/api/workspace/browse",
    async (req, reply) => {
      const { readdirSync, statSync } = await import("node:fs");
      const targetPath = req.query.path || (process.platform === "win32" ? "C:\\" : "/");
      const entries: { name: string; path: string; isDirectory: boolean }[] = [];
      try {
        for (const entry of readdirSync(targetPath)) {
          const full = join(targetPath, entry);
          try {
            const s = statSync(full);
            entries.push({ name: entry, path: full, isDirectory: s.isDirectory() });
          } catch {}
        }
      } catch (err: unknown) {
        return reply.status(500).send({ error: `Cannot read directory: ${targetPath}` });
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return reply.send({ path: targetPath, entries });
    },
  );

  // POST /api/workspace/switch — switch active workspace
  app.post<{
    Body: { path: string };
  }>("/api/workspace/switch", async (req, reply) => {
    const { path } = req.body ?? {};
    if (!path) {
      return reply.status(400).send({ error: "path is required" });
    }
    if (!existsSync(path)) {
      return reply.status(404).send({ error: `Workspace not found: ${path}` });
    }
    setActiveWorkspace(path);
    await loadCodexSkillsForWorkspace(ctx, path);
    return reply.send({ ok: true, path });
  });
}
