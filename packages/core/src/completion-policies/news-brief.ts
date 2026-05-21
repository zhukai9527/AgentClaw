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
      input.successfulWebFetchCalls < 2
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
  const items = unique
    .filter((line) => !/^https?:\/\//i.test(line))
    .filter((line) => !/^\[content compacted\]/i.test(line))
    .slice(0, 6);
  const sources = unique
    .filter((line) => /^https?:\/\//i.test(line))
    .slice(0, 6);

  if (items.length === 0 && sources.length === 0) return null;

  const briefItems =
    items.length > 0
      ? items.map((line) => `- ${line}`).join("\n")
      : "- 已获取到来源链接，但可抽取标题不足；建议后续改用更高质量新闻源。";
  const sourceList =
    sources.length > 0
      ? sources.map((url) => `- ${url}`).join("\n")
      : "- 已获取的工具结果中未提取到明确 URL。";

  return [
    `今日 AI 简报（${currentLocalDateString(now)}）`,
    "",
    briefItems,
    "",
    "今日洞察：AI 新闻任务已达到可用来源数量，继续抓取的边际收益低于空转风险；本次优先基于已获取事实给出简报。",
    "",
    "来源链接：",
    sourceList,
    "",
    `说明：${reason}；系统已停止继续调用工具以避免空转。`,
  ].join("\n");
}
