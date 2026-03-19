import type {
  Tool,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistry,
  ToolResult,
} from "@agentclaw/types";

export class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool, overwrite = false): void {
    if (this.tools.has(tool.name) && !overwrite) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    if (!this.tools.has(name)) {
      throw new Error(`Tool "${name}" is not registered`);
    }
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  definitions(): ToolDefinition[] {
    return this.list().map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  /** Create a shallow copy of this registry */
  clone(): ToolRegistryImpl {
    return this.filter(() => true);
  }

  /** Create a filtered copy containing only tools that pass the predicate */
  filter(predicate: (tool: Tool) => boolean): ToolRegistryImpl {
    const filtered = new ToolRegistryImpl();
    for (const tool of this.tools.values()) {
      if (predicate(tool)) {
        filtered.tools.set(tool.name, tool);
      }
    }
    return filtered;
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      // Auto-redirect: LLM called a skill name as if it were a tool.
      // Handles both exact match ("agent-browser") and compound names
      // like "agent-browser snapshot" where the skill name is a prefix.
      const skillRegistry = context?.skillRegistry;
      if (skillRegistry) {
        const skill =
          skillRegistry.get(name) ??
          skillRegistry
            .list()
            .find(
              (s) =>
                s.enabled &&
                name.startsWith(s.name) &&
                (name.length === s.name.length ||
                  name[s.name.length] === " " ||
                  name[s.name.length] === "_"),
            );
        if (skill) {
          const useSkill = this.tools.get("use_skill");
          if (useSkill) {
            const skillName =
              "id" in skill ? (skill as { id: string }).id : skill.name;
            console.log(
              `[tool-registry] Auto-redirect "${name}" → use_skill("${skillName}")`,
            );
            return useSkill.execute({ name: skillName }, context);
          }
        }
      }
      const available = this.list()
        .map((t) => t.name)
        .join(", ");
      return {
        content: `Tool "${name}" does not exist. You can ONLY use: ${available}`,
        isError: true,
      };
    }
    try {
      return await tool.execute(input, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Tool execution failed: ${message}`, isError: true };
    }
  }
}
