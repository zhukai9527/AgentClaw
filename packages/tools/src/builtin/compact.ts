import type { Tool, ToolResult, ToolExecutionContext } from "@agentclaw/types";

export const compactTool: Tool = {
  name: "compact",
  description:
    "Compress conversation context by summarizing older messages. Use when you notice the conversation is getting long and you want to free up context space. This is proactive context management — call it before you run out of room.",
  category: "builtin",
  pure: true,
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },

  async execute(
    _input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (!context?.compactContext) {
      return {
        content: "Context compression is not available in this environment.",
        isError: true,
      };
    }

    try {
      const result = await context.compactContext();
      if (result.deleted === 0) {
        return {
          content: result.summary,
        };
      }
      return {
        content: `Context compressed: ${result.deleted} old messages summarized and removed. You now have more room to work.`,
      };
    } catch (err) {
      return {
        content: `Compression failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
