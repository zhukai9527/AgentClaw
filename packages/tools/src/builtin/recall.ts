import type { Tool, ToolResult, ToolExecutionContext } from "@agentclaw/types";

export const recallTool: Tool = {
  name: "recall",
  description:
    "Search long-term memory for previously stored information. " +
    "Use when the user references something from past conversations, " +
    "or when you need context that might have been saved before. " +
    "This is read-only — it does NOT save anything.",
  category: "builtin",
  pure: true,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to search for in memory (natural language)",
      },
      type: {
        type: "string",
        enum: ["identity", "fact", "preference", "entity", "episodic"],
        description: "Optional: filter by memory type",
      },
      limit: {
        type: "number",
        description: "Max results to return (default 5)",
      },
    },
    required: ["query"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const query = input.query as string;
    const type = input.type as string | undefined;
    const limit = (input.limit as number) || 5;

    if (!context?.searchMemory) {
      return {
        content: "Memory system is not available in this context.",
        isError: true,
      };
    }

    try {
      const results = await context.searchMemory(query, { type, limit });

      if (results.length === 0) {
        return {
          content: `No memories found matching "${query}".`,
          isError: false,
        };
      }

      const lines = results.map(
        (r, i) =>
          `[${i + 1}] (${r.type}, importance=${r.importance}) ${r.content}`,
      );
      return {
        content: `Found ${results.length} memories:\n${lines.join("\n")}`,
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Failed to search memory: ${message}`,
        isError: true,
      };
    }
  },
};
