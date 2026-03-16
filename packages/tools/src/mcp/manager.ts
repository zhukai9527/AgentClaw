import type { MCPServerConfig, Tool } from "@agentclaw/types";
import { MCPClient } from "./client.js";

/**
 * Manages connections to multiple MCP servers and aggregates their tools.
 */
export class MCPManager {
  private clients = new Map<string, MCPClient>();
  private toolsByServer = new Map<string, Tool[]>();

  /**
   * Add an MCP server, connect to it, and discover its tools.
   * Returns the list of tools provided by the newly added server.
   */
  async addServer(config: MCPServerConfig): Promise<Tool[]> {
    if (this.clients.has(config.name)) {
      throw new Error(`MCP server "${config.name}" is already connected`);
    }

    const client = new MCPClient(config);
    await client.connect();

    let tools: Tool[];
    try {
      tools = await client.listTools();
    } catch (err) {
      // If tool listing fails, disconnect and propagate the error
      await client.disconnect();
      throw err;
    }

    this.clients.set(config.name, client);
    this.toolsByServer.set(config.name, tools);

    return tools;
  }

  /**
   * Remove an MCP server: disconnect and remove all its tools.
   */
  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`MCP server "${name}" is not connected`);
    }

    await client.disconnect();
    this.clients.delete(name);
    this.toolsByServer.delete(name);
  }

  /**
   * List all connected servers with their tool counts.
   */
  listServers(): Array<{
    name: string;
    toolCount: number;
    tools: Array<{ name: string; description: string }>;
  }> {
    const result: Array<{
      name: string;
      toolCount: number;
      tools: Array<{ name: string; description: string }>;
    }> = [];
    for (const [name, tools] of this.toolsByServer) {
      result.push({
        name,
        toolCount: tools.length,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
    }
    return result;
  }

  /**
   * Get tools for a specific server.
   */
  getServerTools(name: string): Tool[] {
    return this.toolsByServer.get(name) || [];
  }

  /**
   * Get all tools from all currently connected MCP servers.
   */
  getAllTools(): Tool[] {
    const all: Tool[] = [];
    for (const tools of this.toolsByServer.values()) {
      all.push(...tools);
    }
    return all;
  }

  /**
   * Disconnect from all MCP servers and clear internal state.
   */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.clients.values()).map((client) => client.disconnect()),
    );

    this.clients.clear();
    this.toolsByServer.clear();
  }
}
