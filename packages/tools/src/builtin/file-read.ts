import { readFile } from "node:fs/promises";
import type { Tool, ToolResult } from "@agentclaw/types";
import { resolveFilePath } from "./resolve-path.js";

export const fileReadTool: Tool = {
  name: "file_read",
  description: "Read a file.",
  category: "builtin",
  pure: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolveFilePath(input.path as string);

    // Block reading sensitive files
    const basename = filePath.replace(/\\/g, "/").split("/").pop() || "";
    const BLOCKED_FILES = [
      ".env",
      ".env.local",
      ".env.production",
      "credentials.json",
      "secrets.json",
    ];
    if (
      BLOCKED_FILES.includes(basename) ||
      basename.endsWith(".pem") ||
      basename.endsWith(".key")
    ) {
      return {
        content: `Access denied: ${basename} is a sensitive file and cannot be read.`,
        isError: true,
      };
    }

    try {
      const content = await readFile(filePath, "utf-8");
      return {
        content,
        isError: false,
        metadata: { path: filePath },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Failed to read file: ${message}`,
        isError: true,
        metadata: { path: filePath },
      };
    }
  },
};
