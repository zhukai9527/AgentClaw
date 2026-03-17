import { fork, type ChildProcess } from "child_process";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import type { Tool, ToolResult, ToolExecutionContext } from "@agentclaw/types";

import { shellTool } from "./shell.js";
import { fileReadTool } from "./file-read.js";
import { fileWriteTool } from "./file-write.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";

const MAX_OUTPUT = 12_000;
const MAX_STDOUT = 256_000; // 256KB cap to prevent OOM

/** Direct references to sandbox-allowed tools */
const SANDBOX_TOOLS: Record<string, Tool> = {
  bash: shellTool,
  file_read: fileReadTool,
  file_write: fileWriteTool,
  glob: globTool,
  grep: grepTool,
  web_fetch: webFetchTool,
  web_search: webSearchTool,
};

/** Alias: stub function name → actual tool name */
const TOOL_ALIASES: Record<string, string> = {
  shell: "bash",
};

/**
 * Runner script injected into the child process.
 * Sets up tool stubs as globals, then dynamically imports the user script.
 * Communication with parent via Node.js IPC (process.send / process.on).
 */
const RUNNER_CODE = `
function callTool(name, input) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    process.send({ type: 'tool_call', id, name, input });
    const handler = (msg) => {
      if (msg.type === 'tool_result' && msg.id === id) {
        process.off('message', handler);
        if (msg.isError) reject(new Error(msg.content));
        else resolve(msg.content);
      }
    };
    process.on('message', handler);
  });
}

// High-level helpers — return JS-friendly types
// glob returns string[], others return string
globalThis.web_search = (query, max_results) =>
  callTool('web_search', { query, ...(max_results != null ? { max_results } : {}) });
globalThis.web_fetch = (url) => callTool('web_fetch', { url });
globalThis.file_read = (path) => callTool('file_read', { path });
globalThis.file_write = (path, content) => callTool('file_write', { path, content });
globalThis.shell = (command, opts) =>
  callTool('bash', typeof opts === 'object' ? { command, ...opts } : { command });
globalThis.glob = async (pattern, cwd) => {
  const raw = await callTool('glob', typeof cwd === 'string' ? { pattern, cwd } : { pattern });
  return raw.trim() ? raw.trim().split('\\n') : [];
};
globalThis.grep = (pattern, opts) =>
  callTool('grep', typeof opts === 'object' ? { pattern, ...opts } : { pattern });

// Low-level: call any allowed tool by name
globalThis.callTool = callTool;

// Block native fetch/http — force using sandbox tools
globalThis.fetch = () => { throw new Error('fetch() is disabled. Use web_fetch(url) instead — it returns clean Markdown.'); };

try {
  await import('./_script.mjs');
  process.send({ type: 'done' });
} catch (err) {
  process.stderr.write(err.stack || err.message || String(err));
  process.send({ type: 'done', error: err.message || String(err) });
}
`;

export const executeCodeTool: Tool = {
  name: "execute_code",
  description:
    "Execute JavaScript in a child process with programmatic tool access. " +
    "ES module with top-level await. Tool functions are globals (no import needed): " +
    "web_search(query)→string, web_fetch(url)→string(returns Markdown, not HTML!), " +
    "file_read(path)→string, file_write(path,content)→string, shell(command)→string, " +
    "glob(pattern)→string[] (returns array!), grep(pattern,{path})→string. " +
    "Also: callTool(name, inputObj) for raw access. " +
    "Only console.log() output is returned to you — intermediate tool results " +
    "stay hidden. Use for multi-step chains (search+read+summarize) to save tokens. " +
    "IMPORTANT: Do NOT import/require external packages (cheerio, axios, etc.) — " +
    "use the built-in tool functions above. Do NOT use require() — " +
    "use import for Node.js built-ins only (import fs from 'fs').",
  category: "builtin",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript (ES module). Top-level await supported. " +
          "Use console.log() for output returned to you.",
      },
      timeout: {
        type: "number",
        description: "Timeout in ms (default 120000)",
      },
    },
    required: ["code"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const code = input.code as string;
    const timeout = (input.timeout as number) || 120_000;

    // Create isolated temp directory
    const execId = randomBytes(4).toString("hex");
    const tmpDir = join(process.cwd(), "data", "tmp", `ptc-${execId}`);
    mkdirSync(tmpDir, { recursive: true });

    const runnerPath = join(tmpDir, "_runner.mjs");
    const scriptPath = join(tmpDir, "_script.mjs");

    writeFileSync(runnerPath, RUNNER_CODE, "utf-8");
    writeFileSync(scriptPath, code, "utf-8");

    return new Promise<ToolResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let toolCallCount = 0;

      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Small delay to drain remaining stdout
        setTimeout(() => {
          cleanup();
          resolve(result);
        }, 50);
      };

      // Always use project root as cwd (not session workDir which is an empty temp dir)
      const child: ChildProcess = fork(runnerPath, [], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env },
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish({
          content: truncate(
            `Timeout after ${timeout}ms. Tool calls: ${toolCallCount}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
          ),
          isError: true,
          metadata: { toolCallCount },
        });
      }, timeout);

      // Abort signal
      const onAbort = () => {
        child.kill("SIGTERM");
        finish({ content: "Execution aborted.", isError: true });
      };
      context?.abortSignal?.addEventListener("abort", onAbort, { once: true });

      child.stdout!.on("data", (data: Buffer) => {
        if (stdout.length < MAX_STDOUT) {
          stdout += data.toString("utf-8");
        }
      });

      child.stderr!.on("data", (data: Buffer) => {
        if (stderr.length < MAX_STDOUT) {
          stderr += data.toString("utf-8");
        }
      });

      // IPC: handle tool calls from child
      child.on("message", async (msg: Record<string, unknown>) => {
        if (msg.type === "tool_call") {
          toolCallCount++;
          const rawName = msg.name as string;
          const toolName = TOOL_ALIASES[rawName] || rawName;
          const tool = SANDBOX_TOOLS[toolName];

          if (!tool) {
            child.send?.({
              type: "tool_result",
              id: msg.id,
              content: `Tool "${rawName}" is not available in execute_code sandbox. Available: ${Object.keys(SANDBOX_TOOLS).join(", ")}`,
              isError: true,
            });
            return;
          }

          try {
            // Build isolated context: no interactive callbacks, no workDir override
            const sandboxContext: ToolExecutionContext = {
              abortSignal: context?.abortSignal,
            };
            const result = await tool.execute(
              msg.input as Record<string, unknown>,
              sandboxContext,
            );
            child.send?.({
              type: "tool_result",
              id: msg.id,
              content: result.content,
              isError: result.isError ?? false,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            child.send?.({
              type: "tool_result",
              id: msg.id,
              content: `Tool error: ${message}`,
              isError: true,
            });
          }
        }

        if (msg.type === "done") {
          if (msg.error) {
            finish({
              content: truncate(
                `Script error: ${msg.error}\nTool calls: ${toolCallCount}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
              ),
              isError: true,
              metadata: { toolCallCount },
            });
          } else {
            finish({
              content: truncate(
                stdout || "(no output — use console.log() to produce output)",
              ),
              isError: false,
              metadata: { toolCallCount },
            });
          }
        }
      });

      child.on("error", (err) => {
        finish({
          content: `Failed to start child process: ${err.message}`,
          isError: true,
        });
      });

      child.on("exit", (exitCode) => {
        if (exitCode !== 0 && !settled) {
          finish({
            content: truncate(
              `Process exited with code ${exitCode}\nTool calls: ${toolCallCount}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
            ),
            isError: true,
            metadata: { toolCallCount },
          });
        }
        // Normal exit without 'done' message (shouldn't happen, but handle it)
        if (!settled) {
          finish({
            content: truncate(stdout || "(no output)"),
            isError: false,
            metadata: { toolCallCount },
          });
        }
      });

      function cleanup() {
        context?.abortSignal?.removeEventListener("abort", onAbort);
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });
  },
};

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const half = Math.floor(MAX_OUTPUT / 2) - 50;
  return (
    text.slice(0, half) +
    `\n\n... (truncated ${text.length - MAX_OUTPUT} chars) ...\n\n` +
    text.slice(-half)
  );
}
