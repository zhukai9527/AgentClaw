import type { Tool, ToolResult, ToolExecutionContext, PresentOption } from "@agentclaw/types";

export const presentOptionsTool: Tool = {
  name: "present_options",
  description: "Display a set of structured options to the user and wait for their selection. Use this when you need the user to choose from predefined choices, such as selecting a target repository, picking a workflow branch, or confirming a decision.",
  category: "builtin",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Question or instruction for the user" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Display label for the option" },
            value: { type: "string", description: "Internal value for the option" },
            description: { type: "string", description: "Optional explanation of what this option means" },
          },
          required: ["label", "value"],
        },
        description: "Available choices",
      },
      multiple: { type: "boolean", description: "Allow selecting multiple options (default: false)", default: false },
    },
    required: ["prompt", "options"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const prompt = input.prompt as string;
    const options = input.options as PresentOption[];
    const multiple = !!input.multiple;

    if (context?.presentOptions) {
      const result = await context.presentOptions(prompt, options, multiple);
      return { content: JSON.stringify(result.selected), isError: false };
    }

    // Fallback: serialize options as text via promptUser
    if (context?.promptUser) {
      const lines = options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
      const question = `${prompt}\n\n${lines.join("\n")}\n\nEnter number${multiple ? "s (comma-separated)" : ""}:`;
      const answer = await context.promptUser(question);
      return { content: answer, isError: false };
    }

    return { content: "No user interaction channel available", isError: true };
  },
};
