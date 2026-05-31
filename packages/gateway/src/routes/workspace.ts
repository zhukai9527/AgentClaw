import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../bootstrap.js";
import {
  loadWorkspaceState,
  saveWorkspaceState,
  setActiveWorkspace,
} from "../workspace.js";

const WORKSPACES_DIR = resolve(process.cwd(), "data", "workspaces");

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  _ctx: AppContext,
): void {
  // GET /api/workspace/status — current workspace state
  app.get("/api/workspace/status", async (_req, reply) => {
    const state = loadWorkspaceState();
    return reply.send(state);
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

  // POST /api/workspace/import — clone a git repository as workspace
  app.post<{
    Body: { remoteUrl: string; name?: string };
  }>("/api/workspace/import", async (req, reply) => {
    const { remoteUrl, name } = req.body ?? {};
    if (!remoteUrl) {
      return reply.status(400).send({ error: "remoteUrl is required" });
    }

    const dirName = name || remoteUrl.split("/").pop()?.replace(/\.git$/, "") || "workspace";
    const targetPath = join(WORKSPACES_DIR, dirName);

    if (existsSync(targetPath)) {
      return reply.status(409).send({
        error: `Workspace "${dirName}" already exists at ${targetPath}. Use POST /api/workspace/switch to activate it.`,
      });
    }

    mkdirSync(WORKSPACES_DIR, { recursive: true });

    try {
      execSync(`git clone "${remoteUrl}" "${targetPath}"`, {
        stdio: "pipe",
        timeout: 120_000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: `Git clone failed: ${msg}` });
    }

    setActiveWorkspace(targetPath);
    return reply.send({
      ok: true,
      name: dirName,
      path: targetPath,
    });
  });

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
    return reply.send({ ok: true, path });
  });
}
