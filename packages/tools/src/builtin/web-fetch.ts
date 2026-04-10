import type { Tool, ToolResult, ToolExecutionContext } from "@agentclaw/types";
import TurndownService from "turndown";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const execFileAsync = promisify(execFile);

// ── 站点配置：从 sites.json 加载，缺失时用内置默认值 ──

interface SiteConfig {
  spaDomains: string[];
  loginWallKeywords: string[];
  noisePatterns: string[];
  sites: Record<string, { selector?: string; cleanupJs?: string; $ref?: string }>;
}

function loadSiteConfig(): SiteConfig {
  const configPath = resolve(process.cwd(), "skills/web-fetch/sites.json");
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    }
  } catch (err) {
    console.warn("[web_fetch] Failed to load sites.json, using defaults:", err);
  }
  // 内置默认值（与 sites.json 同步）
  return {
    spaDomains: [
      "x.com", "twitter.com", "zhihu.com", "www.zhihu.com",
      "weibo.com", "m.weibo.com", "bilibili.com", "www.bilibili.com",
      "douyin.com", "www.douyin.com", "xiaohongshu.com", "www.xiaohongshu.com",
      "threads.net", "www.threads.net", "reddit.com", "www.reddit.com",
      "chatgpt.com", "chat.openai.com",
    ],
    loginWallKeywords: [
      "安全验证", "请登录", "登录后", "请先登录",
      "login required", "sign in to", "please log in", "access denied",
    ],
    noisePatterns: [
      "^Don't miss what's happening$",
      "^People on X are the first to know\\.?$",
      "^\\[Log in\\].*$", "^\\[Sign up\\].*$",
      "^See new posts?$", "^## Article$", "^# Conversation$",
      "^Discover more$", "^Trending now$",
      "^Terms of Service", "^Privacy Policy", "^Cookie Policy",
      "^\\[.*?\\]\\(\\/login\\)$", "^\\[.*?\\]\\(\\/i\\/flow\\/signup\\)$",
      "^Show more$", "^Show this thread$",
    ],
    sites: {},
  };
}

const siteConfig = loadSiteConfig();

/** 内部硬上限：防止极端页面撑爆内存（溢出模式会在 8K 处接管 LLM 上下文保护） */
const INTERNAL_MAX_LENGTH = 200_000;
const FETCH_TIMEOUT = 10_000;
/** Jina Reader 超时（毫秒）——比主 fetch 短，失败时快速 fallback */
const JINA_TIMEOUT = 8_000;
/** Playwright 子进程超时（毫秒） */
const PLAYWRIGHT_TIMEOUT = 30_000;
/** Playwright 子进程最大输出（字节） */
const PLAYWRIGHT_MAX_BUFFER = 2 * 1024 * 1024;

/** 已知 SPA/JS 渲染站点——命中时直接走 Playwright，不判断内容长度 */
const SPA_DOMAINS = new Set(siteConfig.spaDomains);

/** 登录墙关键词——命中任一则提示用户需要登录态 */
const LOGIN_WALL_KEYWORDS = siteConfig.loginWallKeywords;

/** Check if hostname resolves to a private/internal address (SSRF protection) */
function isPrivateHost(hostname: string): boolean {
  // Reject localhost variants
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "0.0.0.0") return true;
  // IPv4 private ranges
  const parts = hostname.split(".").map(Number);
  if (parts.length === 4 && parts.every(n => !isNaN(n))) {
    if (parts[0] === 127) return true;                    // 127.0.0.0/8
    if (parts[0] === 10) return true;                     // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16
    if (parts[0] === 0) return true;                       // 0.0.0.0/8
  }
  return false;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/** Lines commonly found in SPA page chrome (navigation, login prompts, etc.) */
const NOISE_PATTERNS = siteConfig.noisePatterns.map((p) => new RegExp(p, "i"));

/** Remove common SPA navigation noise from markdown output */
function cleanMarkdown(md: string): string {
  return md
    .split("\n")
    .filter((line) => !NOISE_PATTERNS.some((p) => p.test(line.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Convert HTML to Markdown: Readability extracts article → turndown converts, fallback to full-page */
function htmlToMarkdown(html: string, _url?: string): string {
  // Try Readability first for article extraction
  try {
    const { document } = parseHTML(html);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reader = new Readability(document as any, { charThreshold: 100 });
    const article = reader.parse();
    if (article?.content && (article.textContent?.length ?? 0) > 200) {
      const title = article.title ? `# ${article.title}\n\n` : "";
      const md = turndown.turndown(article.content);
      return cleanMarkdown(title + md);
    }
  } catch {
    // Readability failed, fall through to full-page conversion
  }

  // Fallback: full-page turndown with basic noise removal
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<nav[\s\S]*?<\/nav>/gi, "");

  const md = turndown.turndown(html);
  return cleanMarkdown(md);
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch URL content as text (HTML auto-converted). Handles JS-rendered sites (x.com, zhihu, weibo, bilibili etc.) via Playwright fallback. Use save_as to save content directly as a file (skips LLM rewriting). Combine with auto_send to deliver the file to the user in one step.",
  category: "builtin",
  pure: true,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      save_as: {
        type: "string",
        description:
          "Save fetched content to this filename (e.g. 'article.md'). The framework writes the file directly — no need to call file_write separately.",
      },
      auto_send: {
        type: "boolean",
        description:
          "When used with save_as, automatically send the saved file to the user. No need for a separate send_file call.",
      },
    },
    required: ["url"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const url = input.url as string;
    const saveAs = input.save_as as string | undefined;
    const autoSend = input.auto_send === true || String(input.auto_send).toLowerCase() === "true";

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return {
        content: `Invalid URL: ${url}`,
        isError: true,
      };
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return {
        content: `Unsupported protocol: ${parsedUrl.protocol} — only http and https are supported`,
        isError: true,
      };
    }

    if (isPrivateHost(parsedUrl.hostname)) {
      return {
        content: `Blocked: ${parsedUrl.hostname} is a private/internal address`,
        isError: true,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const response = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: controller.signal,
        redirect: "follow",
      });

      if (!response.ok) {
        return {
          content: `HTTP ${response.status} ${response.statusText} for ${url}`,
          isError: true,
          metadata: { status: response.status, url },
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();

      let content: string;
      // 标记最终采用的抓取策略
      let strategy: "native" | "jina" | "playwright" | "login_wall" = "native";

      if (contentType.includes("application/json")) {
        // Pretty-print JSON
        try {
          const parsed = JSON.parse(body);
          content = JSON.stringify(parsed, null, 2);
        } catch {
          content = body;
        }
      } else if (contentType.includes("text/html")) {
        // 优先 Jina Reader（Markdown 质量更高），失败 fallback 本地 Readability
        const jina = await tryJinaReader(url);
        content = jina ?? htmlToMarkdown(body);
        if (jina) strategy = "jina";

        // SPA 自动回退：已知 SPA 域名直接走 Playwright；其他站点内容极少时也降级
        // Jina 已成功且内容充足时跳过 Playwright
        const isSPADomain = SPA_DOMAINS.has(parsedUrl.hostname);
        if (strategy !== "jina" && (isSPADomain || (content.length < 1500 && body.length > 2000))) {
          // 直接带 --scroll 抓取，避免两次 Playwright 启动开销
          const pwContent = await tryPlaywrightFetch(url, true);
          if (pwContent !== null && pwContent.length >= 500) {
            content = pwContent;
            strategy = "playwright";
          } else if (pwContent === null || pwContent.length < 500) {
            content +=
              "\n\n[注意] 此页面需要 JS 渲染，静态抓取内容不完整。请改用 agent-browser 技能获取：use_skill('agent-browser')，然后用 agent-browser open + snapshot/get text 获取完整内容。";
          }
        }

        // 登录墙检测（对 native 和 playwright 结果都生效）
        if (
          LOGIN_WALL_KEYWORDS.some((kw) =>
            content.toLowerCase().includes(kw.toLowerCase()),
          )
        ) {
          strategy = "login_wall";
          content +=
            "\n\n[注意] 此页面需要登录态才能访问完整内容。建议使用 browser 技能（利用用户真实浏览器登录状态），或 agent-browser 技能（自动匹配已保存的登录态）。";
        }
      } else {
        // Plain text or other text formats
        content = body;
      }

      // ── save_as: write content to file directly (skip LLM rewriting) ──
      if (saveAs && strategy !== "login_wall") {
        const workDir =
          context?.workDir ??
          join(resolve(process.cwd(), "data", "tmp"), `fetch_${Date.now()}`);
        mkdirSync(workDir, { recursive: true });
        const filePath = join(workDir, basename(saveAs));
        writeFileSync(filePath, content, "utf-8");

        // auto_send: deliver file to user immediately
        if (autoSend && context?.sendFile) {
          try {
            await context.sendFile(filePath, basename(saveAs));
            return {
              content: `Fetched and sent: ${basename(saveAs)} (${content.length} chars from ${url})`,
              isError: false,
              autoComplete: true,
              metadata: { url, strategy, filePath, saved: true, sent: true },
            };
          } catch {
            // sendFile failed, fall through to saved-only response
          }
        }

        // Truncate content for LLM context (file has full content)
        const preview =
          content.length > 500
            ? `${content.slice(0, 500)}\n\n... [full content saved to file]`
            : content;
        return {
          content: `Saved to ${basename(saveAs)} (${content.length} chars).\n\nPreview:\n${preview}`,
          isError: false,
          metadata: {
            url,
            strategy,
            filePath,
            saved: true,
            originalLength: content.length,
          },
        };
      }

      // 内部硬上限：防止极端页面撑爆进程内存（溢出模式在 agent-loop 层处理 LLM 上下文）
      if (content.length > INTERNAL_MAX_LENGTH) {
        content = `${content.slice(0, INTERNAL_MAX_LENGTH)}\n\n... [truncated at internal safety limit]`;
      }

      return {
        content: content + "\n\nhint: use file_write(path, content) to save this content, or web_search(query) to find more sources",
        isError: false,
        metadata: {
          url,
          strategy,
          status: response.status,
          contentType,
          originalLength: content.length,
        },
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return {
          content: `Request timed out after ${FETCH_TIMEOUT}ms for ${url}`,
          isError: true,
          metadata: { url, timedOut: true },
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Failed to fetch ${url}: ${message}`,
        isError: true,
        metadata: { url },
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * 尝试调用 Playwright 脚本抓取页面内容。
 * 如果 python 不在 PATH、fetch.py 不存在、或执行失败，静默返回 null（不影响主流程）。
 */
async function tryPlaywrightFetch(
  url: string,
  scroll = false,
): Promise<string | null> {
  const scriptPath = resolve(
    process.cwd(),
    "skills/web-fetch/scripts/fetch.py",
  );
  if (!existsSync(scriptPath)) {
    return null;
  }

  try {
    const args = [scriptPath, "--url", url];
    if (scroll) args.push("--scroll");
    const { stdout } = await execFileAsync("python", args, {
      timeout: scroll ? PLAYWRIGHT_TIMEOUT * 2 : PLAYWRIGHT_TIMEOUT,
      maxBuffer: PLAYWRIGHT_MAX_BUFFER,
      windowsHide: true,
    });
    const result = stdout.trim();
    if (!result || result.startsWith("Error loading page:")) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * 尝试通过 Jina Reader 获取 Markdown 内容。
 * 免费无需 API key，20 RPM 限制。失败时静默返回 null。
 */
async function tryJinaReader(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JINA_TIMEOUT);
  try {
    const resp = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: "text/markdown" },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const text = (await resp.text()).trim();
    // Jina 返回空或极短内容时视为失败
    if (text.length < 100) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
