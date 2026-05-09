import { describe, expect, it } from "vitest";

const { evaluateWechatPublishRun } = await import(
  "../wechat-publish-skill-regression.mts"
);

describe("wechat-publish skill regression evaluator", () => {
  it("通过 use_skill 和统一 CLI dry-run 时判定通过", () => {
    const result = evaluateWechatPublishRun({
      toolCalls: [
        { name: "use_skill", input: { name: "wechat-publish" } },
        {
          name: "bash",
          input: {
            command:
              "cd D:/mycode/agentclaw && python skills/wechat-publish/scripts/wechat_publish.py capabilities --json",
          },
        },
        {
          name: "bash",
          input: {
            command:
              "cd D:/mycode/agentclaw && python skills/wechat-publish/scripts/wechat_publish.py inspect article.md --draft --json",
          },
        },
        {
          name: "bash",
          input: {
            command:
              "cd D:/mycode/agentclaw && python skills/wechat-publish/scripts/wechat_publish.py publish article.md --title 标题 --out-dir out --dry-run --json",
          },
        },
      ],
      toolResults: [
        {
          name: "bash",
          isError: false,
          content:
            '{"success":true,"code":"DRAFT_DRY_RUN_READY","data":{"artifacts":{"draft_json":"out/draft.json"}}}',
        },
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("未加载 skill 时判定失败", () => {
    const result = evaluateWechatPublishRun({
      toolCalls: [
        {
          name: "bash",
          input: {
            command:
              "cd D:/mycode/agentclaw && python skills/wechat-publish/scripts/wechat_publish.py publish article.md --title 标题 --out-dir out --dry-run --json",
          },
        },
      ],
      toolResults: [],
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("missing_use_skill");
  });

  it("使用旧脚本或手写微信接口时判定失败", () => {
    const result = evaluateWechatPublishRun({
      toolCalls: [
        { name: "use_skill", input: { name: "wechat-publish" } },
        {
          name: "bash",
          input: {
            command:
              "python skills/wechat-publish/scripts/publish_article.py article.md --dry-run && curl https://api.weixin.qq.com/cgi-bin/draft/add?access_token=x",
          },
        },
      ],
      toolResults: [],
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("missing_unified_cli");
    expect(result.failures).toContain("uses_banned_old_entry");
    expect(result.failures).toContain("uses_direct_wechat_api");
  });

  it("使用非 canonical 参数缩写时判定失败", () => {
    const result = evaluateWechatPublishRun({
      toolCalls: [
        { name: "use_skill", input: { name: "wechat-publish" } },
        {
          name: "bash",
          input: {
            command:
              "cd D:/mycode/agentclaw && python skills/wechat-publish/scripts/wechat_publish.py publish article.md --title 标题 --out out --dry-run --json",
          },
        },
      ],
      toolResults: [
        {
          name: "bash",
          isError: false,
          content:
            '{"success":true,"code":"DRAFT_DRY_RUN_READY","data":{"artifacts":{"draft_json":"out/draft.json"}}}',
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("uses_noncanonical_out_arg");
  });

  it("显式指定主题时无法证明默认 auto 生效", () => {
    const result = evaluateWechatPublishRun({
      toolCalls: [
        { name: "use_skill", input: { name: "wechat-publish" } },
        {
          name: "bash",
          input: {
            command:
              "cd D:/mycode/agentclaw && python skills/wechat-publish/scripts/wechat_publish.py publish article.md --theme minimal --out-dir out --dry-run --json",
          },
        },
      ],
      toolResults: [
        {
          name: "bash",
          isError: false,
          content:
            '{"success":true,"code":"DRAFT_DRY_RUN_READY","data":{"theme_selection":{"requested":"minimal","resolved":"minimal"}}}',
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("uses_explicit_theme_for_auto_case");
  });

  it("publish 子命令错误携带 --draft 时判定失败", () => {
    const result = evaluateWechatPublishRun({
      toolCalls: [
        { name: "use_skill", input: { name: "wechat-publish" } },
        {
          name: "bash",
          input: {
            command:
              "cd D:/mycode/agentclaw && python skills/wechat-publish/scripts/wechat_publish.py publish article.md --draft --out-dir out --dry-run --json",
          },
        },
      ],
      toolResults: [
        {
          name: "bash",
          isError: false,
          content:
            '{"success":true,"code":"DRAFT_DRY_RUN_READY","data":{"theme_selection":{"requested":"auto","resolved":"minimal"}}}',
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("uses_publish_draft_flag");
  });

  it("未锚定仓库根目录的统一 CLI 调用判定失败", () => {
    const result = evaluateWechatPublishRun({
      toolCalls: [
        { name: "use_skill", input: { name: "wechat-publish" } },
        {
          name: "bash",
          input: {
            command:
              "cd C:/Users/voroj && python skills/wechat-publish/scripts/wechat_publish.py publish article.md --out-dir out --dry-run --json",
          },
        },
      ],
      toolResults: [
        {
          name: "bash",
          isError: true,
          content:
            "python.exe: can't open file 'C:/Users/voroj/skills/wechat-publish/scripts/wechat_publish.py'",
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("uses_unanchored_wechat_cli");
  });

  it("统一 CLI 缺少 --json 时判定失败", () => {
    const result = evaluateWechatPublishRun({
      toolCalls: [
        { name: "use_skill", input: { name: "wechat-publish" } },
        {
          name: "bash",
          input: {
            command:
              "cd D:/mycode/agentclaw && python skills/wechat-publish/scripts/wechat_publish.py inspect article.md",
          },
        },
        {
          name: "bash",
          input: {
            command:
              "cd D:/mycode/agentclaw && python skills/wechat-publish/scripts/wechat_publish.py publish article.md --out-dir out --dry-run --json",
          },
        },
      ],
      toolResults: [
        {
          name: "bash",
          isError: false,
          content:
            '{"success":true,"code":"DRAFT_DRY_RUN_READY","data":{"theme_selection":{"requested":"auto","resolved":"minimal"}}}',
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("uses_wechat_cli_without_json");
  });

  it("发布任务停在 preview 时判定失败", () => {
    const result = evaluateWechatPublishRun({
      toolCalls: [
        { name: "use_skill", input: { name: "wechat-publish" } },
        {
          name: "bash",
          input: {
            command:
              "cd D:/mycode/agentclaw && python skills/wechat-publish/scripts/wechat_publish.py preview article.md --out-dir out --json",
          },
        },
      ],
      toolResults: [
        {
          name: "bash",
          isError: false,
          content:
            '{"success":true,"code":"PREVIEW_READY","data":{"theme_selection":{"requested":"auto","resolved":"minimal"}}}',
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("uses_preview_for_publish_task");
  });
});
