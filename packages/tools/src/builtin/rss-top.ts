import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "@agentclaw/types";

const FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_TOP_N = 5;
const MAX_FEEDS = 20;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 100;

type RssCacheEntry = {
  content: string;
  metadata: Record<string, unknown>;
  expiresAt: number;
};

const rssCache = new Map<string, RssCacheEntry>();

export const rssTopTool: Tool = {
  name: "rss_top",
  description:
    "Fetch multiple RSS/Atom feeds in one call and return compact top entries. " +
    "Use this for Reddit/RSS daily reports instead of many web_fetch calls.",
  category: "builtin",
  pure: false,
  parameters: {
    type: "object",
    properties: {
      feeds: {
        type: "array",
        items: { type: "string" },
        description:
          "Feed URLs or subreddit names. Examples: https://www.reddit.com/r/technology/.rss, r/LocalLLaMA, LocalLLaMA.",
      },
      topN: {
        type: "number",
        description: "Entries per feed, default 5.",
      },
      save_as: {
        type: "string",
        description: "Optional Markdown filename to save the compact report.",
      },
      auto_send: {
        type: "boolean",
        description: "When save_as is set, send the saved file to the user.",
      },
    },
    required: ["feeds"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const feeds = readFeeds(input.feeds);
    if (!feeds.ok) return fail(feeds.message);

    const topN = readTopN(input.topN);
    if (!topN.ok) return fail(topN.message);

    const saveAs =
      typeof input.save_as === "string" && input.save_as.trim()
        ? input.save_as.trim()
        : undefined;
    const autoSend =
      input.auto_send === true ||
      String(input.auto_send).toLowerCase() === "true";
    const cacheKey = buildCacheKey(feeds.value, topN.value);

    if (!saveAs) {
      const cached = readCache(cacheKey);
      if (cached) {
        return {
          content: cached.content,
          metadata: { ...cached.metadata, cacheHit: true },
        };
      }
    }

    const sections = await Promise.all(
      feeds.value.slice(0, MAX_FEEDS).map((feed) => fetchFeed(feed, topN.value)),
    );
    const content = sections.map(formatSection).join("\n\n").trim();
    const metadata = {
      feeds: sections.length,
      entries: sections.reduce((sum, section) => sum + section.entries.length, 0),
    };

    if (saveAs) {
      const workDir =
        context?.workDir ??
        join(resolve(process.cwd(), "data", "tmp"), `rss_${Date.now()}`);
      mkdirSync(workDir, { recursive: true });
      const filePath = join(workDir, basename(saveAs));
      writeFileSync(filePath, content, "utf-8");
      if (autoSend && context?.sendFile) {
        await context.sendFile(filePath, basename(saveAs));
        return {
          content: `RSS report saved and sent: ${basename(saveAs)} (${sections.length} feeds)`,
          metadata: { filePath, feeds: sections.length, saved: true, sent: true },
          autoComplete: true,
        };
      }
      return {
        content: `${content}\n\nSaved to: ${filePath}`,
        metadata: { filePath, feeds: sections.length, saved: true },
      };
    }

    writeCache(cacheKey, content, metadata);
    return {
      content,
      metadata,
    };
  },
};

type FeedSection = {
  label: string;
  url: string;
  entries: Array<{ title: string; url: string; published?: string }>;
  error?: string;
};

async function fetchFeed(feed: string, topN: number): Promise<FeedSection> {
  const url = normalizeFeed(feed);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml",
        "User-Agent": "AgentClaw/1.0 RSS reader",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        label: labelForFeed(feed),
        url,
        entries: [],
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }
    const xml = await response.text();
    return {
      label: labelForFeed(feed),
      url,
      entries: parseEntries(xml).slice(0, topN),
    };
  } catch (err) {
    return {
      label: labelForFeed(feed),
      url,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseEntries(xml: string): Array<{ title: string; url: string; published?: string }> {
  const atomEntries = matchBlocks(xml, "entry").map((block) => ({
    title: decodeXml(readTag(block, "title")),
    url: decodeXml(readLink(block) || readTag(block, "id")),
    published: decodeXml(readTag(block, "updated") || readTag(block, "published")),
  }));
  if (atomEntries.length > 0) {
    return atomEntries.filter((entry) => entry.title && entry.url);
  }

  return matchBlocks(xml, "item")
    .map((block) => ({
      title: decodeXml(readTag(block, "title")),
      url: decodeXml(readTag(block, "link")),
      published: decodeXml(readTag(block, "pubDate")),
    }))
    .filter((entry) => entry.title && entry.url);
}

function matchBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"))].map(
    (match) => match[0],
  );
}

function readTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() ?? "";
}

function readLink(block: string): string {
  const href = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1];
  return href ?? "";
}

function formatSection(section: FeedSection): string {
  if (section.error) {
    return `## ${section.label}\n- 抓取失败：${section.error}\n- ${section.url}`;
  }
  if (section.entries.length === 0) {
    return `## ${section.label}\n- 未获取到条目\n- ${section.url}`;
  }
  return [
    `## ${section.label}`,
    ...section.entries.map((entry, index) => {
      const date = entry.published ? ` (${entry.published.slice(0, 10)})` : "";
      return `${index + 1}. ${entry.title}${date}\n   ${entry.url}`;
    }),
  ].join("\n");
}

function normalizeFeed(feed: string): string {
  const trimmed = feed.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const subreddit = trimmed.replace(/^r\//i, "").replace(/^\/?r\//i, "");
  return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/.rss`;
}

function buildCacheKey(feeds: string[], topN: number): string {
  return JSON.stringify({
    feeds: feeds.map((feed) => normalizeFeed(feed)),
    topN,
  });
}

function readCache(key: string): RssCacheEntry | null {
  const cached = rssCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    rssCache.delete(key);
    return null;
  }
  return cached;
}

function writeCache(
  key: string,
  content: string,
  metadata: Record<string, unknown>,
): void {
  if (rssCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = rssCache.keys().next().value;
    if (oldest) rssCache.delete(oldest);
  }
  rssCache.set(key, {
    content,
    metadata,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function labelForFeed(feed: string): string {
  const match = feed.match(/reddit\.com\/r\/([^/]+)/i);
  if (match?.[1]) return `r/${decodeURIComponent(match[1])}`;
  const trimmed = feed.trim().replace(/^\/?r\//i, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `r/${trimmed}`;
}

function readFeeds(value: unknown): { ok: true; value: string[] } | { ok: false; message: string } {
  if (!Array.isArray(value)) return { ok: false, message: "feeds must be an array." };
  const feeds = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  if (feeds.length === 0) return { ok: false, message: "feeds must include at least one URL or subreddit." };
  if (feeds.length > MAX_FEEDS) return { ok: false, message: `feeds supports at most ${MAX_FEEDS} items.` };
  return { ok: true, value: feeds };
}

function readTopN(value: unknown): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: DEFAULT_TOP_N };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20) {
    return { ok: false, message: "topN must be an integer between 1 and 20." };
  }
  return { ok: true, value };
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .trim();
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}
