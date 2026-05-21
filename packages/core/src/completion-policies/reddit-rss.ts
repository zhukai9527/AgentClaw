import { currentLocalDateString } from "./common.js";
import type {
  CompletionArtifact,
  CompletionPolicy,
  CompletionPolicyDecision,
  CompletionPolicyInput,
} from "./types.js";

const SEND_EFFECT_SOURCE = "auto_send_reddit_rss_report";
const WRITE_EFFECT_SOURCE = "auto_write_reddit_rss_report";

export const redditRssCompletionPolicy: CompletionPolicy = {
  name: "reddit_rss_terminal_result",
  evaluate(input: CompletionPolicyInput): CompletionPolicyDecision | null {
    if (
      input.taskKind !== "reddit_rss" ||
      !input.toolResults.some(
        (result) => result.effectiveToolName === "rss_top",
      ) ||
      !shouldCompleteRedditRssDeterministically(input.currentResultContents)
    ) {
      return null;
    }

    const text = buildRedditRssCompletionResponse(
      input.fallbackSnippets,
      input.currentResultContents,
      "Reddit/RSS 工具已返回可交付结果",
      input.now,
    );
    if (!text) return null;

    const savedPath = input.currentResultContents
      .map(extractSavedPathFromText)
      .find((path): path is string => Boolean(path));
    const artifacts: CompletionArtifact[] = [];

    if (savedPath) {
      artifacts.push({
        kind: "send_existing_file",
        path: savedPath,
        sendEffectSource: SEND_EFFECT_SOURCE,
      });
    } else if (input.wantsFileDelivery) {
      artifacts.push({
        kind: "write_and_send_markdown",
        filename: `reddit-tech-ai-daily-${currentLocalDateString(input.now)}.md`,
        content: text,
        writeEffectSource: WRITE_EFFECT_SOURCE,
        sendEffectSource: SEND_EFFECT_SOURCE,
      });
    }

    return {
      policyName: this.name,
      text,
      artifacts,
    };
  },
};

function buildRedditRssCompletionResponse(
  fallbackSnippets: string[],
  currentResultContents: string[],
  reason: string,
  now?: Date,
): string | null {
  const combined = [...currentResultContents, ...fallbackSnippets].join("\n");
  if (!/reddit|rss|subreddit|r\//i.test(combined)) return null;

  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Saved to:/i.test(line))
    .slice(0, 80);
  if (lines.length === 0) return null;

  const body = lines
    .map((line) => {
      if (/^##\s+/.test(line)) return line;
      if (/^[-*]\s+/.test(line)) return line;
      if (/^https?:\/\//i.test(line)) return `- ${line}`;
      return `- ${line}`;
    })
    .join("\n");

  return [
    `# 📡 Reddit 科技AI日报 - ${currentLocalDateString(now)}`,
    "",
    body,
    "",
    "## 今日洞察",
    "Reddit RSS 抓取结果已返回，系统已按现有结果完成日报；如出现 403/抓取失败，说明 Reddit 当前限制了该订阅源访问，不应继续改用未授权的重复抓取路径空转。",
    "",
    `说明：${reason}；系统已停止继续调用工具以避免空转。`,
  ].join("\n");
}

function shouldCompleteRedditRssDeterministically(
  currentResultContents: string[],
): boolean {
  const combined = currentResultContents.join("\n");
  return /Saved to:|抓取失败|HTTP 403|fetch failed|rss_top .*limit/i.test(
    combined,
  );
}

function extractSavedPathFromText(text: string): string | undefined {
  return text
    .match(/Saved to:\s*([^\r\n]+)/i)?.[1]
    ?.trim()
    .replace(/\\/g, "/");
}
