import type { Tool, ToolResult, ToolExecutionContext } from "@agentclaw/types";

const MAX_RESULT_CHARS = 500;

export const contextSearchTool: Tool = {
  name: "context_search",
  description:
    "Search earlier conversation history that may have been compressed or truncated. " +
    "Use when you need to recall details discussed earlier in a long conversation " +
    "(e.g., specific numbers, file paths, decisions, code snippets). " +
    "Returns matching turns with role, timestamp, and content excerpt.",
  category: "builtin",
  pure: true,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keyword or phrase to search for in conversation history",
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
    const limit = (input.limit as number) || 5;

    if (!query.trim()) {
      return { content: "Error: empty search query", isError: true };
    }

    if (!context?.searchHistory) {
      return {
        content: "History search is not available in this context.",
        isError: true,
      };
    }

    try {
      const results = await context.searchHistory(query, limit);

      if (results.length === 0) {
        return {
          content: `No matches found for "${query}" in conversation history.`,
          isError: false,
        };
      }

      const lines = results.map((r, i) => {
        const content =
          r.content.length > MAX_RESULT_CHARS
            ? r.content.slice(0, MAX_RESULT_CHARS) + "..."
            : r.content;
        return `[${i + 1}] ${r.role} (${r.createdAt}):\n${content}`;
      });

      return {
        content: `Found ${results.length} match(es) for "${query}":\n\n${lines.join("\n\n")}`,
        isError: false,
        metadata: { matchCount: results.length },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Search failed: ${message}`, isError: true };
    }
  },
};
