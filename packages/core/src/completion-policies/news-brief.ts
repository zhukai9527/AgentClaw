import { currentLocalDateString, extractFallbackLines } from "./common.js";
import type {
  CompletionPolicy,
  CompletionPolicyDecision,
  CompletionPolicyInput,
} from "./types.js";

export const newsBriefCompletionPolicy: CompletionPolicy = {
  name: "news_brief_ready",
  evaluate(input: CompletionPolicyInput): CompletionPolicyDecision | null {
    if (
      input.taskKind !== "news_brief" ||
      input.successfulWebSearchCalls < 3 ||
      (input.successfulWebFetchCalls < 2 &&
        extractNewsCandidates([
          ...input.fallbackSnippets,
          ...input.currentResultContents.flatMap(extractFallbackLines),
        ], input.now).length === 0)
    ) {
      return null;
    }

    const text = buildNewsBriefCompletionResponse(
      input.fallbackSnippets,
      input.currentResultContents,
      "新闻简报已获取足够搜索和网页证据",
      input.now,
    );
    return text
      ? {
          policyName: this.name,
          text,
          artifacts: [],
        }
      : null;
  },
};

function buildNewsBriefCompletionResponse(
  fallbackSnippets: string[],
  currentResultContents: string[],
  reason: string,
  now?: Date,
): string | null {
  const lines = [
    ...fallbackSnippets,
    ...currentResultContents.flatMap(extractFallbackLines),
  ];
  const unique = [...new Set(lines)];
  const candidates = extractNewsCandidates(unique, now);
  const sources = candidates.map((item) => item.url);

  if (candidates.length === 0 && sources.length === 0) return null;

  const briefItems =
    candidates.length > 0
      ? candidates
          .slice(0, 5)
          .map((item) => {
            const detail = item.summary ? `：${item.summary}` : "";
            return `- ${item.title}${detail}\n  来源：${item.url}`;
          })
          .join("\n")
      : "- 已获取到来源链接，但可抽取标题不足；建议后续改用更高质量新闻源。";
  const sourceList =
    sources.length > 0
      ? sources.slice(0, 6).map((url) => `- ${url}`).join("\n")
      : "- 已获取的工具结果中未提取到明确 URL。";
  const confidenceNote =
    candidates.length < 3
      ? "已过滤过期、低质或预测类来源；本轮只保留可确认的高置信候选。"
      : "已过滤过期、低质或预测类来源。";

  return [
    `今日 AI 简报（${currentLocalDateString(now)}）`,
    "",
    briefItems,
    "",
    `今日洞察：${confidenceNote}继续抓取的边际收益低于空转风险；本次优先基于已获取事实给出简报。`,
    "",
    "来源链接：",
    sourceList,
    "",
    `说明：${reason}；系统已停止继续调用工具以避免空转。`,
  ].join("\n");
}

type NewsCandidate = {
  title: string;
  summary: string;
  url: string;
};

const LOW_QUALITY_SOURCE_RE =
  /\/\/(?:www\.)?(?:youtube\.com|youtu\.be|reddit\.com|x\.com|twitter\.com|blog\.mean\.ceo|fazm\.ai|medium\.com|substack\.com|marketingprofs\.com|linkedin\.com|buildfastwithai\.com|launchpadagency\.com)\b/i;

const LOW_QUALITY_TITLE_RE =
  /\b(?:YouTube|Reddit|Substack)\b|what can we expect from AI in 2026|AI Will Hit a Wall|trends to watch in 2026|what's next in AI/i;

const BOILERPLATE_RE =
  /^(?:results\[|hint:|\[content compacted\]|Title:|URL Source:|Published Time:|Markdown Content:|Check out other fresh news|When your AI startup)/i;

function extractNewsCandidates(lines: string[], now?: Date): NewsCandidate[] {
  const candidates: NewsCandidate[] = [];
  const seen = new Set<string>();
  const cleanLines = lines
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);

  for (let i = 0; i < cleanLines.length; i++) {
    const line = cleanLines[i];
    if (BOILERPLATE_RE.test(line)) continue;
    const urlInLine = line.match(/https?:\/\/[^\s)>\]]+/)?.[0];
    const url =
      urlInLine ??
      cleanLines
        .slice(i + 1, i + 3)
        .find((candidate) => /^https?:\/\//i.test(candidate));
    if (!url || LOW_QUALITY_SOURCE_RE.test(url)) continue;
    if (!isTrustedNewsSource(url)) continue;

    const withoutUrl = line.replace(url, "").trim();
    const parsed = splitTitleAndSummary(withoutUrl);
    if (!parsed.title) continue;
    if (LOW_QUALITY_TITLE_RE.test(parsed.title)) continue;
    if (!isRecentEnoughForNews(line, now)) continue;

    const normalizedUrl = url.replace(/[.,;:]+$/g, "");
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    candidates.push({
      title: parsed.title,
      summary: parsed.summary,
      url: normalizedUrl,
    });
  }

  return candidates.slice(0, 6);
}

function splitTitleAndSummary(line: string): { title: string; summary: string } {
  const cleaned = line.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim();
  const [rawTitle, ...rest] = cleaned.split(/\s+—\s+/);
  const title = rawTitle.trim().slice(0, 120);
  const summary = rest.join(" — ").trim().slice(0, 180);
  return { title, summary };
}

function isTrustedNewsSource(url: string): boolean {
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }

  if (hostname.endsWith(".gov") || hostname.endsWith(".edu")) return true;
  if (hostname.endsWith(".europa.eu")) return true;
  if (hostname.startsWith("investors.")) return true;

  return TRUSTED_NEWS_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

const TRUSTED_NEWS_DOMAINS = [
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "nytimes.com",
  "theverge.com",
  "techcrunch.com",
  "technologyreview.com",
  "wired.com",
  "openai.com",
  "anthropic.com",
  "googleblog.com",
  "blog.google",
  "deepmind.google",
  "microsoft.com",
  "meta.com",
  "about.fb.com",
  "nvidia.com",
  "stanford.edu",
  "mit.edu",
  "futureoflife.org",
];

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

function isRecentEnoughForNews(line: string, now = new Date()): boolean {
  const parsed = parseNewsDate(line, now);
  if (!parsed) return true;
  const nowDate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const ageDays = Math.floor(
    (nowDate.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000),
  );
  return ageDays >= 0 && ageDays <= 7;
}

function parseNewsDate(line: string, now: Date): Date | null {
  const numeric = line.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (numeric) {
    return new Date(Number(numeric[3]), Number(numeric[1]) - 1, Number(numeric[2]));
  }

  const named = line.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b/i,
  );
  if (named) {
    return new Date(
      Number(named[3]),
      MONTH_INDEX[named[1].toLowerCase()],
      Number(named[2]),
    );
  }

  const monthOnly = line.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i,
  );
  if (monthOnly) {
    const month = MONTH_INDEX[monthOnly[1].toLowerCase()];
    const year = Number(monthOnly[2]);
    if (year === now.getFullYear() && month === now.getMonth()) return null;
    return new Date(year, month, 1);
  }

  return null;
}
