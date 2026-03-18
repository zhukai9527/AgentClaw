import type { Tool, ToolResult } from "@agentclaw/types";

const DEFAULT_SERPER_URL = "https://google.serper.dev/search";
const DEFAULT_QUERIT_URL = "https://api.querit.ai/v1/search";
const SEARCH_TIMEOUT = 10_000;

/** Search engine config — injected at startup via setSearchEngines() */
interface SearchEngine {
  id: string;
  type: "searxng" | "serper" | "querit" | "custom";
  enabled: boolean;
  url?: string;
  apiKey?: string;
}

/** Runtime search engine list — set by gateway bootstrap */
let searchEngines: SearchEngine[] = [];

/** Called by gateway to inject search engine config */
export function setSearchEngines(engines: SearchEngine[]): void {
  searchEngines = engines;
}

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/** Format search results into numbered lines */
function formatResults(results: SearchResult[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push("");
  }
  return lines;
}

/** Search via self-hosted SearXNG instance */
async function searchSearXNG(
  baseUrl: string,
  query: string,
  maxResults: number,
): Promise<string | null> {
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT);

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    const lines: string[] = [];

    // Direct answers
    for (const answer of data.answers ?? []) {
      lines.push(`Direct answer: ${answer}`, "");
    }

    // Infoboxes
    for (const ib of data.infoboxes ?? []) {
      const content = ib.content;
      if (content) {
        lines.push(`${ib.infobox ?? ""}: ${content.slice(0, 300)}`, "");
      }
    }

    // Results
    const results: SearchResult[] = (data.results ?? [])
      .slice(0, maxResults)
      .map((r: Record<string, string>) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content,
      }));

    if (results.length === 0 && lines.length === 0) return null;

    lines.push(...formatResults(results));

    return lines.join("\n").trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Search via Google Serper API */
async function searchSerper(
  url: string,
  apiKey: string,
  query: string,
  maxResults: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        num: Math.min(maxResults, 10),
        hl: "zh-cn",
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    const lines: string[] = [];

    // Answer box
    const answerBox = data.answerBox;
    const answer = answerBox?.answer || answerBox?.snippet;
    if (answer) lines.push(`Direct answer: ${answer}`, "");

    // Knowledge graph
    const kg = data.knowledgeGraph;
    if (kg?.description) {
      lines.push(`${kg.title ?? ""}: ${kg.description}`, "");
    }

    // Organic results
    const items = data.organic ?? [];
    if (items.length === 0 && lines.length === 0) return null;

    const results: SearchResult[] = items.map(
      (item: Record<string, string>) => ({
        title: item.title ?? "",
        url: item.link ?? "",
        snippet: item.snippet,
      }),
    );
    lines.push(...formatResults(results));

    return lines.join("\n").trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Search via Querit API */
async function searchQuerit(
  url: string,
  apiKey: string,
  query: string,
  maxResults: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        count: Math.min(maxResults, 10),
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    const items = data.results?.result ?? data.results ?? data.organic ?? [];
    if (items.length === 0) return null;

    const results: SearchResult[] = items.map(
      (item: Record<string, string>) => ({
        title: item.title ?? "",
        url: item.url ?? item.link ?? "",
        snippet: item.snippet ?? item.content,
      }),
    );

    return formatResults(results).join("\n").trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Execute a single search engine */
async function executeEngine(
  engine: SearchEngine,
  query: string,
  maxResults: number,
): Promise<string | null> {
  switch (engine.type) {
    case "searxng":
      return searchSearXNG(
        engine.url || "http://localhost:8888",
        query,
        maxResults,
      );
    case "serper":
      return engine.apiKey
        ? searchSerper(
            engine.url || DEFAULT_SERPER_URL,
            engine.apiKey,
            query,
            maxResults,
          )
        : null;
    case "querit":
      return engine.apiKey
        ? searchQuerit(
            engine.url || DEFAULT_QUERIT_URL,
            engine.apiKey,
            query,
            maxResults,
          )
        : null;
    case "custom":
      // Custom engines use SearXNG-compatible JSON API (GET ?q=...&format=json)
      return engine.url ? searchSearXNG(engine.url, query, maxResults) : null;
    default:
      return null;
  }
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web via SearXNG/Serper. Returns titles, URLs and snippets.",
  category: "builtin",
  pure: true,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      max_results: { type: "number", default: 5 },
    },
    required: ["query"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = input.query as string;
    const maxResults = (input.max_results as number) ?? 5;

    if (!query.trim()) {
      return { content: "Error: empty search query", isError: true };
    }

    // Try enabled engines in order (priority = array order)
    const enabled = searchEngines.filter((e) => e.enabled);
    for (const engine of enabled) {
      const result = await executeEngine(engine, query, maxResults);
      if (result) {
        return {
          content: result,
          isError: false,
          metadata: { query, maxResults, engine: engine.id },
        };
      }
    }

    return {
      content:
        "Error: No search backend available. Configure search engines in Settings.",
      isError: true,
    };
  },
};
