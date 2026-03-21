import type { Tool, ToolResult, ToolExecutionContext } from "@agentclaw/types";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

const BU = "browser-use";
const ENV = { ...process.env, PYTHONIOENCODING: "utf-8" };
const EXEC_TIMEOUT = 30_000;

const STATES_DIR = join(process.cwd(), "data", "browser-states").replace(
  /\\/g,
  "/",
);

/** Run a browser-use CLI command and return stdout */
async function bu(
  args: string[],
  timeout = EXEC_TIMEOUT,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(BU, args, {
    env: ENV,
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

export const browserTool: Tool = {
  name: "browser",
  category: "builtin",
  description:
    "Browser automation via browser-use CLI. " +
    "Actions: open, state, click, input, screenshot, scroll, back, keys, eval, wait, cookies_export, cookies_import, close. " +
    "Workflow: open URL → state (see interactive elements with indices) → click/input by index → state again to verify.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action to perform",
        enum: [
          "open",
          "state",
          "click",
          "input",
          "screenshot",
          "scroll",
          "back",
          "keys",
          "eval",
          "wait",
          "cookies_export",
          "cookies_import",
          "close",
        ],
      },
      url: {
        type: "string",
        description: "URL to navigate to (for open action)",
      },
      index: {
        type: "number",
        description: "Element index from state output (for click/input)",
      },
      text: {
        type: "string",
        description:
          "Text to type (for input), key combo (for keys, e.g. 'Enter', 'Control+a'), JS code (for eval), text to wait for (for wait), or cookie file path (for cookies_import)",
      },
      path: {
        type: "string",
        description: "File path for screenshot or cookies export/import",
      },
      direction: {
        type: "string",
        description: "Scroll direction: up or down (default: down)",
        enum: ["up", "down"],
      },
    },
    required: ["action"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const action = input.action as string;
    const workDir =
      context?.workDir ||
      join(process.cwd(), "data", "tmp").replace(/\\/g, "/");

    try {
      switch (action) {
        case "open": {
          const url = input.url as string;
          if (!url) return { content: "Missing url parameter", isError: true };
          const { stdout } = await bu(["open", url]);
          // After open, auto-run state to give LLM the page content
          try {
            const { stdout: stateOut } = await bu(["state"], 15_000);
            return {
              content: `Navigated: ${stdout.trim()}\n\n${stateOut}`,
              isError: false,
            };
          } catch {
            return { content: `Navigated: ${stdout.trim()}`, isError: false };
          }
        }

        case "state": {
          const { stdout } = await bu(["state"], 15_000);
          return { content: stdout, isError: false };
        }

        case "click": {
          const idx = input.index as number;
          if (idx === undefined)
            return { content: "Missing index parameter", isError: true };
          const { stdout } = await bu(["click", String(idx)]);
          return {
            content: stdout.trim() || `Clicked element ${idx}`,
            isError: false,
          };
        }

        case "input": {
          const idx = input.index as number;
          const text = input.text as string;
          if (idx === undefined || !text)
            return {
              content: "Missing index or text parameter",
              isError: true,
            };
          const { stdout } = await bu(["input", String(idx), text]);
          return {
            content: stdout.trim() || `Typed "${text}" into element ${idx}`,
            isError: false,
          };
        }

        case "screenshot": {
          mkdirSync(workDir, { recursive: true });
          const filename = `screenshot_${Date.now()}.png`;
          const filePath = join(workDir, filename).replace(/\\/g, "/");
          const { stdout } = await bu(["screenshot", filePath]);
          return {
            content: stdout.trim() || `Screenshot saved: ${filePath}`,
            isError: false,
            metadata: { filePath },
          };
        }

        case "scroll": {
          const dir = (input.direction as string) || "down";
          const amount = dir === "up" ? "-3" : "3";
          const { stdout } = await bu(["scroll", amount]);
          return {
            content: stdout.trim() || `Scrolled ${dir}`,
            isError: false,
          };
        }

        case "back": {
          const { stdout } = await bu(["back"]);
          return { content: stdout.trim() || "Navigated back", isError: false };
        }

        case "keys": {
          const text = input.text as string;
          if (!text)
            return {
              content: "Missing text parameter (key combo)",
              isError: true,
            };
          const { stdout } = await bu(["keys", text]);
          return {
            content: stdout.trim() || `Pressed ${text}`,
            isError: false,
          };
        }

        case "eval": {
          const code = input.text as string;
          if (!code)
            return {
              content: "Missing text parameter (JS code)",
              isError: true,
            };
          const { stdout } = await bu(["eval", code]);
          let result = stdout.trim();
          if (result.length > 8000) {
            result =
              result.slice(0, 8000) +
              `\n... [truncated, ${result.length} chars]`;
          }
          return { content: result || "(empty result)", isError: false };
        }

        case "wait": {
          const text = input.text as string;
          if (!text)
            return { content: "Missing text parameter", isError: true };
          const { stdout } = await bu(["wait", "text", text], 15_000);
          return {
            content: stdout.trim() || `Text "${text}" appeared`,
            isError: false,
          };
        }

        case "cookies_export": {
          mkdirSync(STATES_DIR, { recursive: true });
          const name = (input.path as string) || "default";
          const filePath = join(STATES_DIR, `${name}.json`).replace(/\\/g, "/");
          const { stdout } = await bu(["cookies", "export", filePath]);
          return {
            content: stdout.trim() || `Cookies exported to ${filePath}`,
            isError: false,
          };
        }

        case "cookies_import": {
          const name = (input.path as string) || "default";
          const filePath = join(STATES_DIR, `${name}.json`).replace(/\\/g, "/");
          if (!existsSync(filePath))
            return {
              content: `Cookie file not found: ${filePath}`,
              isError: true,
            };
          const { stdout } = await bu(["cookies", "import", filePath]);
          return {
            content: stdout.trim() || `Cookies imported from ${filePath}`,
            isError: false,
          };
        }

        case "close": {
          const { stdout } = await bu(["close"]);
          return { content: stdout.trim() || "Browser closed", isError: false };
        }

        default:
          return {
            content: `Unknown action: ${action}. Valid: open, state, click, input, screenshot, scroll, back, keys, eval, wait, cookies_export, cookies_import, close`,
            isError: true,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Extract useful part from Python traceback
      const lastLine = msg.split("\n").filter(Boolean).pop() || msg;
      return { content: `Browser error: ${lastLine}`, isError: true };
    }
  },
};
