import { describe, expect, it } from "vitest";
import { evaluateCompletionPolicies } from "../completion-policies/index.js";

const now = new Date("2026-05-21T08:00:00+08:00");

function baseInput() {
  return {
    taskKind: "default" as const,
    inputText: "",
    messages: [],
    sentFiles: [],
    fallbackSnippets: [],
    currentResultContents: [],
    toolResults: [],
    successfulWebSearchCalls: 0,
    successfulWebFetchCalls: 0,
    wantsFileDelivery: false,
    now,
  };
}

describe("completion policies", () => {
  it("AI 新闻证据足够时由新闻策略直接生成带来源简报", () => {
    const decision = evaluateCompletionPolicies({
      ...baseInput(),
      taskKind: "news_brief",
      inputText: "在外网搜索今日AI界新闻生成简报",
      successfulWebSearchCalls: 3,
      successfulWebFetchCalls: 2,
      fallbackSnippets: [
        "OpenAI releases a new agent feature — source summary",
        "https://openai.com/news/example",
      ],
      currentResultContents: [
        "Title: AI News Source\nURL Source: https://example.com/ai\nAnthropic announces AI safety update.",
      ],
    });

    expect(decision?.policyName).toBe("news_brief_ready");
    expect(decision?.text).toContain("今日 AI 简报（2026-05-21）");
    expect(decision?.text).toContain("来源链接");
    expect(decision?.artifacts).toEqual([]);
  });

  it("Reddit RSS 失败且没有 save_as 时返回写入并发送 Markdown 的交付意图", () => {
    const rssContent =
      "## r/technology\n- 抓取失败：HTTP 403 Blocked\n- https://www.reddit.com/r/technology/.rss";
    const decision = evaluateCompletionPolicies({
      ...baseInput(),
      taskKind: "reddit_rss",
      inputText: "Reddit RSS 日报，最后用 send_file 发送",
      currentResultContents: [rssContent],
      toolResults: [
        {
          effectiveToolName: "rss_top",
          result: { content: rssContent },
        },
      ],
      wantsFileDelivery: true,
    });

    expect(decision?.policyName).toBe("reddit_rss_terminal_result");
    expect(decision?.text).toContain("Reddit 科技AI日报");
    expect(decision?.artifacts).toEqual([
      expect.objectContaining({
        kind: "write_and_send_markdown",
        filename: "reddit-tech-ai-daily-2026-05-21.md",
        content: decision?.text,
        writeEffectSource: "auto_write_reddit_rss_report",
        sendEffectSource: "auto_send_reddit_rss_report",
      }),
    ]);
  });

  it("Reddit RSS 已保存报告时只返回发送已有文件的交付意图", () => {
    const savedPath =
      "D:/mycode/agentclaw/data/tmp/conv-rss/reddit_tech_ai_daily.md";
    const rssContent = [
      "## r/artificial",
      "- 抓取失败：HTTP 403 Blocked",
      "- https://www.reddit.com/r/artificial/.rss",
      `Saved to: ${savedPath}`,
    ].join("\n");
    const decision = evaluateCompletionPolicies({
      ...baseInput(),
      taskKind: "reddit_rss",
      inputText: "Reddit RSS 日报，最后用 send_file 发送",
      currentResultContents: [rssContent],
      toolResults: [
        {
          effectiveToolName: "rss_top",
          result: { content: rssContent },
        },
      ],
      wantsFileDelivery: true,
    });

    expect(decision?.artifacts).toEqual([
      {
        kind: "send_existing_file",
        path: savedPath,
        sendEffectSource: "auto_send_reddit_rss_report",
      },
    ]);
  });

  it("表格化检查证据足够时由证据表策略生成 Markdown 表格", () => {
    const decision = evaluateCompletionPolicies({
      ...baseInput(),
      taskKind: "evidence_table_analysis",
      inputText: "用表格检查 https://www.ehafo.com 的 SEO 和安全问题",
      successfulWebSearchCalls: 1,
      successfulWebFetchCalls: 2,
      currentResultContents: [
        'Title: 易哈佛\nURL Source: https://www.ehafo.com\n# 首页\n<meta name="description" content="教育">',
        "HTTP Code: 404\nURL Source: https://www.ehafo.com/.well-known/security.txt",
      ],
    });

    expect(decision?.policyName).toBe("evidence_table_ready");
    expect(decision?.text).toContain(
      "| 检查项 | 当前发现 | 判断 | 建议 | 证据 |",
    );
    expect(decision?.artifacts).toEqual([]);
  });

  it("默认任务不触发任何特化完成策略", () => {
    expect(evaluateCompletionPolicies(baseInput())).toBeNull();
  });
});
