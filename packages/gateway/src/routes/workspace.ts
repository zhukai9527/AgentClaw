import { mkdirSync, existsSync, cpSync } from "node:fs";
import { join, basename } from "node:path";
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
    return reply.send({ ok: true, path });
  });
}
