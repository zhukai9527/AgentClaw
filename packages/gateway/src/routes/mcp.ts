import type { FastifyInstance } from "fastify";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { MCPServerConfig } from "@agentclaw/types";
import type { AppContext } from "../bootstrap.js";

export function registerMCPRoutes(app: FastifyInstance, ctx: AppContext): void {
  const mcpConfigPath = resolve(process.cwd(), "data", "mcp-servers.json");

  // GET /api/mcp — list connected MCP servers and their tools
  app.get("/api/mcp", async (_req, reply) => {
    try {
      const servers = ctx.mcpManager.listServers();
      return reply.send(servers);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // POST /api/mcp — add a new MCP server
  app.post<{ Body: MCPServerConfig }>("/api/mcp", async (req, reply) => {
    try {
      const config = req.body;
      if (!config.name || !config.transport) {
        return reply
          .status(400)
          .send({ error: "name and transport are required" });
      }

      const tools = await ctx.mcpManager.addServer(config);
      for (const tool of tools) {
        ctx.toolRegistry.register(tool);
      }

      console.log(
        `[mcp] Server "${config.name}" connected: ${tools.length} tools`,
      );
      return reply.send({
        name: config.name,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // DELETE /api/mcp/:name — disconnect and remove an MCP server
  app.delete<{ Params: { name: string } }>(
    "/api/mcp/:name",
    async (req, reply) => {
      try {
        const { name } = req.params;

        // Unregister all tools from this server before removing
        const serverTools = ctx.mcpManager.getServerTools(name);
        for (const tool of serverTools) {
          try {
            ctx.toolRegistry.unregister(tool.name);
          } catch {
            // tool may already be unregistered
          }
        }

        await ctx.mcpManager.removeServer(name);
        console.log(`[mcp] Server "${name}" disconnected`);
        return reply.send({ success: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  // POST /api/mcp/reload — reload from config file, diff and add/remove
  app.post("/api/mcp/reload", async (_req, reply) => {
    try {
      if (!existsSync(mcpConfigPath)) {
        return reply.status(404).send({ error: "mcp-servers.json not found" });
      }

      const newConfigs = JSON.parse(
        readFileSync(mcpConfigPath, "utf-8"),
      ) as MCPServerConfig[];

      const currentServers = ctx.mcpManager.listServers();
      const currentNames = new Set(currentServers.map((s) => s.name));
      const newNames = new Set(newConfigs.map((c) => c.name));

      const added: string[] = [];
      const removed: string[] = [];
      const errors: string[] = [];

      // Remove servers no longer in config
      for (const name of currentNames) {
        if (!newNames.has(name)) {
          try {
            const serverTools = ctx.mcpManager.getServerTools(name);
            for (const tool of serverTools) {
              try {
                ctx.toolRegistry.unregister(tool.name);
              } catch {
                /* ignore */
              }
            }
            await ctx.mcpManager.removeServer(name);
            removed.push(name);
            console.log(`[mcp] Reload: removed "${name}"`);
          } catch (err) {
            errors.push(
              `Remove "${name}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      // Add new servers not yet connected
      for (const config of newConfigs) {
        if (!currentNames.has(config.name)) {
          try {
            const tools = await ctx.mcpManager.addServer(config);
            for (const tool of tools) {
              ctx.toolRegistry.register(tool);
            }
            added.push(config.name);
            console.log(
              `[mcp] Reload: added "${config.name}" (${tools.length} tools)`,
            );
          } catch (err) {
            errors.push(
              `Add "${config.name}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      return reply.send({ added, removed, errors });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });
}
