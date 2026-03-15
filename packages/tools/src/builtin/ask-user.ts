import { createInterface } from "node:readline";
import type { Tool, ToolResult, ToolExecutionContext } from "@agentclaw/types";

export const askUserTool: Tool = {
  name: "ask_user",
  description: "Ask the user a question.",
  category: "builtin",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string" },
    },
    required: ["question"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const question = input.question as string;

    // Use gateway-provided promptUser when available (Telegram, WebSocket, etc.)
    if (context?.promptUser) {
      const answer = await context.promptUser(question);
      return { content: answer, isError: false };
    }

    // Fallback: readline for CLI usage
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    try {
      const answer = await Promise.race([
        new Promise<string>((resolve) => {
          rl.question(`${question}\n> `, (ans) => {
            resolve(ans);
          });
        }),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("[用户未在 5 分钟内回答]"), 5 * 60 * 1000),
        ),
      ]);

      return {
        content: answer,
        isError: false,
      };
    } finally {
      rl.close();
    }
  },
};
