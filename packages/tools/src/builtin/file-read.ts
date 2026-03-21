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
    const BLOCKED_PATTERNS = [
      /\.env(\.[a-z]+)?$/i, // .env, .env.local, .env.production, .env.staging, etc.
      /credentials\.json$/i,
      /secrets?\.json$/i,
      /\.pem$/i,
      /\.key$/i,
      /id_rsa/i,
      /id_ed25519/i,
      /\.ssh\/config$/i,
    ];
    const BLOCKED_PATH_PREFIXES = ["/proc/", "/sys/", "/dev/"];
    const normalizedPath = filePath.replace(/\\/g, "/");
    const basename = normalizedPath.split("/").pop() || "";
    if (
      BLOCKED_PATTERNS.some(
        (p) => p.test(basename) || p.test(normalizedPath),
      ) ||
      BLOCKED_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))
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
