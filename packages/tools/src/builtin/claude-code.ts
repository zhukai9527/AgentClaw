import { spawn, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Tool, ToolResult, ToolExecutionContext } from "@agentclaw/types";

/**
 * Resolve the absolute path to Claude Code's cli.js entry point.
 * On Windows, parses claude.cmd to find the cli.js path, then spawns
 * via process.execPath (Node itself) — no bash/cmd.exe dependency.
 * Returns undefined on non-Windows or if resolution fails.
 */
function findClaudeCliJs(): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    // Locate claude.cmd via `where`
    const cmdPath = execFileSync("where", ["claude"], {
      timeout: 3000,
      encoding: "utf8",
      windowsHide: true,
    })
      .trim()
      .split(/\r?\n/)
      .find((l) => l.endsWith(".cmd"));
    if (!cmdPath) return undefined;

    // Parse cli.js path from claude.cmd content
    const content = readFileSync(cmdPath, "utf8");
    const match = content.match(
      /node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js/,
    );
    if (!match) return undefined;

    const cliJs = join(dirname(cmdPath), match[0]).replace(/\\/g, "/");
    return existsSync(cliJs) ? cliJs : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_TIMEOUT = 600_000; // 10 minutes
const DEFAULT_OUTPUT_DIR = join(process.cwd(), "data", "tmp").replace(
  /\\/g,
  "/",
);

// ─── Session pool for SDK mode ─────────────────────────────────────
// Maps AgentClaw sessionId → Claude Code sessionId for context continuity.
// Idle sessions auto-expire after 10 minutes.

const SESSION_IDLE_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 5;
const sessionPool = new Map<
  string,
  { claudeSessionId: string; lastUsed: number }
>();

function getPooledSession(key: string): string | undefined {
  const entry = sessionPool.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.lastUsed > SESSION_IDLE_MS) {
    sessionPool.delete(key);
    return undefined;
  }
  entry.lastUsed = Date.now();
  return entry.claudeSessionId;
}

function setPooledSession(key: string, claudeSessionId: string): void {
  // Evict oldest if at capacity
  if (sessionPool.size >= MAX_SESSIONS && !sessionPool.has(key)) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [k, v] of sessionPool) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey) sessionPool.delete(oldestKey);
  }
  sessionPool.set(key, { claudeSessionId, lastUsed: Date.now() });
}

// ─── SDK mode (preferred) ──────────────────────────────────────────

let sdkAvailable: boolean | null = null; // null = not checked yet

async function runClaudeSDK(
  prompt: string,
  cwd: string | undefined,
  timeout: number,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  // Dynamic import — only loaded when actually used
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const outputDir = (context?.workDir ?? DEFAULT_OUTPUT_DIR).replace(
    /\\/g,
    "/",
  );
  const fullPrompt = `${prompt}\n\nIMPORTANT: All generated output files MUST be saved to ${outputDir}/ directory. Never save files to the project root or other locations.`;

  const abortController = new AbortController();
  let aborted = false;

  // Wire abort signal
  if (context?.abortSignal) {
    const onAbort = () => {
      aborted = true;
      abortController.abort();
    };
    if (context.abortSignal.aborted) {
      onAbort();
    } else {
      context.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Timeout
  const timer = setTimeout(() => abortController.abort(), timeout);

  // Session continuity: resume if same AgentClaw session
  const sessionKey = context?.workDir || "default";
  const resumeId = getPooledSession(sessionKey);

  const notify = context?.notifyUser;
  let resultSummary = "";
  let toolCallCount = 0;
  const filesChanged: string[] = [];
  let claudeSessionId = "";

  try {
    const q = query({
      prompt: fullPrompt,
      options: {
        cwd: cwd || process.cwd(),
        abortController,
        ...(resumeId ? { resume: resumeId } : {}),
        allowedTools: [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "NotebookEdit",
          "Agent",
        ],
        maxTurns: 50,
      },
    });

    for await (const evt of q) {
      if (aborted) break;

      if (evt.type === "assistant" && evt.message?.content) {
        claudeSessionId = evt.session_id;
        for (const block of evt.message.content) {
          if (block.type === "tool_use") {
            toolCallCount++;
            const name = block.name as string;
            if (
              name === "Edit" ||
              name === "Write" ||
              name === "NotebookEdit"
            ) {
              const path =
                (block.input as Record<string, string>)?.file_path ||
                (block.input as Record<string, string>)?.notebook_path ||
                "";
              if (path && !filesChanged.includes(path)) filesChanged.push(path);
              notify?.(`✏️ ${name}: ${path}`).catch(() => {});
            } else if (name === "Read") {
              notify?.(
                `📖 Read: ${(block.input as Record<string, string>)?.file_path ?? ""}`,
              ).catch(() => {});
            } else if (name === "Bash") {
              const cmd = String(
                (block.input as Record<string, string>)?.command ?? "",
              ).slice(0, 80);
              notify?.(`🔧 Bash: ${cmd}`).catch(() => {});
            } else if (name === "Grep" || name === "Glob") {
              notify?.(
                `🔍 ${name}: ${(block.input as Record<string, string>)?.pattern ?? ""}`,
              ).catch(() => {});
            } else {
              notify?.(`⚙️ ${name}`).catch(() => {});
            }
          } else if (block.type === "text" && block.text) {
            const firstLine = block.text.split("\n")[0].slice(0, 120);
            if (firstLine) notify?.(`💭 ${firstLine}`).catch(() => {});
          }
        }
      } else if (evt.type === "result") {
        const r = evt as { result?: string };
        resultSummary = r.result || "";
      }
    }
  } catch (err) {
    if (aborted) {
      return {
        content: "Claude Code task aborted by user.",
        isError: true,
        metadata: { aborted: true },
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // Save session for continuity
  if (claudeSessionId) {
    setPooledSession(sessionKey, claudeSessionId);
  }

  // Auto-send output files
  const sendFile = context?.sendFile;
  if (sendFile && filesChanged.length > 0) {
    const outputRe = /[/\\]data[/\\]tmp[/\\]/i;
    for (const f of filesChanged) {
      if (outputRe.test(f)) {
        try {
          await sendFile(f);
        } catch {
          /* ignore */
        }
      }
    }
  }

  const parts = [`Claude Code completed (${toolCallCount} tool calls).`];
  if (filesChanged.length > 0)
    parts.push(`Files changed: ${filesChanged.join(", ")}`);
  if (resultSummary) {
    parts.push(
      resultSummary.length > 500
        ? `${resultSummary.slice(0, 500)}...`
        : resultSummary,
    );
  }

  return {
    content: parts.join("\n"),
    isError: false,
    metadata: { exitCode: 0, toolCallCount, transport: "sdk" },
  };
}

// ─── CLI mode (fallback) ───────────────────────────────────────────

async function runClaudeCLI(
  prompt: string,
  cwd: string | undefined,
  timeout: number,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  const outputDir = (context?.workDir ?? DEFAULT_OUTPUT_DIR).replace(
    /\\/g,
    "/",
  );
  const args = [
    "-p",
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  // On Windows, spawn Node directly with cli.js — no bash/cmd.exe dependency.
  // Both bash and cmd.exe are intermittently unreachable from Start-Process contexts.
  // process.execPath (the running Node binary) is always available.
  const cliJs = findClaudeCliJs();
  const spawnCmd = cliJs ? process.execPath : "claude";
  const spawnArgs = cliJs ? [cliJs, ...args] : args;

  return new Promise<ToolResult>((resolve) => {
    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
      cwd: cwd || process.cwd(),
      env: { ...process.env, CLAUDECODE: undefined },
      windowsHide: true,
    });

    let resultSummary = "";
    let toolCallCount = 0;
    const filesChanged: string[] = [];
    let aborted = false;

    if (context?.abortSignal) {
      const killChild = () => {
        aborted = true;
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
            windowsHide: true,
            stdio: "ignore",
          });
        } else {
          child.kill();
        }
      };
      if (context.abortSignal.aborted) {
        killChild();
      } else {
        context.abortSignal.addEventListener("abort", killChild, {
          once: true,
        });
        child.on("close", () =>
          context.abortSignal!.removeEventListener("abort", killChild),
        );
      }
    }

    const notify = context?.notifyUser;
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const evt = JSON.parse(line);
        if (evt.type === "assistant" && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === "tool_use") {
              toolCallCount++;
              const name = block.name as string;
              if (
                name === "Edit" ||
                name === "Write" ||
                name === "NotebookEdit"
              ) {
                const path =
                  block.input?.file_path || block.input?.notebook_path || "";
                if (path && !filesChanged.includes(path))
                  filesChanged.push(path);
                notify?.(`✏️ ${name}: ${path}`).catch(() => {});
              } else if (name === "Read") {
                notify?.(`📖 Read: ${block.input?.file_path ?? ""}`).catch(
                  () => {},
                );
              } else if (name === "Bash") {
                notify?.(
                  `🔧 Bash: ${String(block.input?.command ?? "").slice(0, 80)}`,
                ).catch(() => {});
              } else if (name === "Grep" || name === "Glob") {
                notify?.(`🔍 ${name}: ${block.input?.pattern ?? ""}`).catch(
                  () => {},
                );
              } else {
                notify?.(`⚙️ ${name}`).catch(() => {});
              }
            } else if (block.type === "text" && block.text) {
              const firstLine = block.text.split("\n")[0].slice(0, 120);
              if (firstLine) notify?.(`💭 ${firstLine}`).catch(() => {});
            }
          }
        } else if (evt.type === "result") {
          resultSummary = evt.result || "";
        }
      } catch {
        /* non-JSON */
      }
    });

    let stderrBuf = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderrBuf += data.toString();
    });

    child.stdin!.write(
      `${prompt}\n\nIMPORTANT: All generated output files MUST be saved to ${outputDir}/ directory. Never save files to the project root or other locations.`,
    );
    child.stdin!.end();

    child.on("close", async (code) => {
      if (aborted) {
        resolve({
          content: "Claude Code task aborted by user.",
          isError: true,
          metadata: { aborted: true },
        });
        return;
      }
      if (code !== 0 && code !== null && !resultSummary) {
        resolve({
          content: stderrBuf || `Claude Code exited with code ${code}`,
          isError: true,
          metadata: { exitCode: code },
        });
        return;
      }
      const sendFile = context?.sendFile;
      if (sendFile && filesChanged.length > 0) {
        const outputRe = /[/\\]data[/\\]tmp[/\\]/i;
        for (const f of filesChanged) {
          if (outputRe.test(f)) {
            try {
              await sendFile(f);
            } catch {
              /* ignore */
            }
          }
        }
      }
      const parts = [`Claude Code completed (${toolCallCount} tool calls).`];
      if (filesChanged.length > 0)
        parts.push(`Files changed: ${filesChanged.join(", ")}`);
      if (resultSummary)
        parts.push(
          resultSummary.length > 500
            ? `${resultSummary.slice(0, 500)}...`
            : resultSummary,
        );
      resolve({
        content: parts.join("\n"),
        isError: false,
        metadata: { exitCode: 0, toolCallCount, transport: "cli" },
      });
    });

    child.on("error", (err) => {
      resolve({
        content: `Failed to spawn claude CLI: ${err.message}\nClaude Code is temporarily unavailable. Use other tools (bash, file_write, etc.) to complete the task instead.`,
        isError: true,
      });
    });
  });
}

// ─── Tool definition ───────────────────────────────────────────────

export const claudeCodeTool: Tool = {
  name: "claude_code",
  description:
    "Delegate a coding task to Claude Code. It can read/write files, run shell commands, and make complex code changes autonomously. Use for: code generation, bug fixing, refactoring, project scaffolding, and any task that benefits from full codebase access. Supports session continuity — multiple calls within the same conversation share context.",
  category: "builtin",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The coding task or question for Claude Code.",
      },
      cwd: {
        type: "string",
        description:
          "Working directory for Claude Code. Defaults to current project root.",
      },
      timeout: {
        type: "number",
        description: `Timeout in ms. Default ${DEFAULT_TIMEOUT / 1000}s.`,
        default: DEFAULT_TIMEOUT,
      },
    },
    required: ["prompt"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const prompt = input.prompt as string;
    const cwd = input.cwd as string | undefined;
    let timeout = (input.timeout as number) ?? DEFAULT_TIMEOUT;
    if (timeout > 0 && timeout < 1000) timeout *= 1000;

    // Try SDK mode first (session continuity, no cold start after first use)
    if (sdkAvailable !== false) {
      try {
        const result = await runClaudeSDK(prompt, cwd, timeout, context);
        sdkAvailable = true;
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          `[claude_code] SDK mode failed: ${msg}, falling back to CLI`,
        );
        // Only permanently disable if package not installed; runtime errors retry next time
        if (
          msg.includes("Cannot find module") ||
          msg.includes("ERR_MODULE_NOT_FOUND")
        ) {
          sdkAvailable = false;
        }
      }
    }

    // Fallback to CLI mode
    const result = await runClaudeCLI(prompt, cwd, timeout, context);
    // Retry once on ENOENT
    if (result.isError && result.content.includes("ENOENT")) {
      console.log("[claude_code] ENOENT on first attempt, retrying...");
      await new Promise((r) => setTimeout(r, 1000));
      return runClaudeCLI(prompt, cwd, timeout, context);
    }
    return result;
  },
};
