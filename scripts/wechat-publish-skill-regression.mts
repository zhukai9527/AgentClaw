import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootstrap } from "../packages/gateway/src/bootstrap.ts";
import type { AgentEvent, Message } from "@agentclaw/types";

export type ToolCallRecord = {
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultRecord = {
  name: string;
  isError: boolean;
  content: string;
};

export type WechatPublishRun = {
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
};

export type WechatPublishEvaluation = {
  passed: boolean;
  failures: string[];
  metrics: {
    useSkillCalls: number;
    unifiedCliCalls: number;
    publishCalls: number;
    toolErrors: number;
  };
};

const bannedOldEntryPatterns = [
  /publish_article\.py/,
  /publish_draft\.py/,
  /md2wx\.py/,
  /cover\.py/,
  /(^|[\/\s])upload\.py/,
  /(^|[\/\s])publish\.py/,
];

const directWechatMarkers = [
  "api.weixin.qq.com",
  "/cgi-bin/draft/add",
  "/cgi-bin/material/add_material",
  "access_token",
  "curl ",
];

function inputText(input: Record<string, unknown>): string {
  return JSON.stringify(input).replace(/\\\\/g, "/");
}

function hasSkillName(call: ToolCallRecord): boolean {
  const raw = String(call.input.name ?? call.input.skillId ?? "").trim();
  return raw === "wechat-publish";
}

function isUnifiedCliCall(call: ToolCallRecord): boolean {
  return inputText(call.input).includes("wechat_publish.py");
}

function isPublishCall(call: ToolCallRecord): boolean {
  const text = inputText(call.input);
  return (
    text.includes("wechat_publish.py") &&
    /\bpublish\b/.test(text) &&
    text.includes("--dry-run") &&
    text.includes("--json")
  );
}

export function evaluateWechatPublishRun(
  run: WechatPublishRun,
): WechatPublishEvaluation {
  const failures: string[] = [];
  const useSkillCalls = run.toolCalls.filter(
    (call) => call.name === "use_skill" && hasSkillName(call),
  ).length;
  const unifiedCliCalls = run.toolCalls.filter(isUnifiedCliCall).length;
  const publishCalls = run.toolCalls.filter(isPublishCall).length;
  const toolErrors = run.toolResults.filter((result) => result.isError).length;
  const allToolText = run.toolCalls.map((call) => inputText(call.input)).join("\n");
  const allResultText = run.toolResults.map((result) => result.content).join("\n");

  if (useSkillCalls === 0) failures.push("missing_use_skill");
  if (unifiedCliCalls === 0) failures.push("missing_unified_cli");
  if (publishCalls === 0) failures.push("missing_publish_dry_run_json");
  if (publishCalls > 1) failures.push("duplicate_publish_call");
  if (toolErrors > 0) failures.push("tool_error");

  if (bannedOldEntryPatterns.some((pattern) => pattern.test(allToolText))) {
    failures.push("uses_banned_old_entry");
  }
  if (directWechatMarkers.some((marker) => allToolText.includes(marker))) {
    failures.push("uses_direct_wechat_api");
  }
  if (/(^|\s)--out(\s|=)/.test(allToolText)) {
    failures.push("uses_noncanonical_out_arg");
  }
  if (
    !allResultText.includes("DRAFT_DRY_RUN_READY") &&
    !allResultText.includes("DRAFT_CREATED")
  ) {
    failures.push("missing_draft_success_code");
  }

  return {
    passed: failures.length === 0,
    failures,
    metrics: {
      useSkillCalls,
      unifiedCliCalls,
      publishCalls,
      toolErrors,
    },
  };
}

function extractText(content: Message["content"] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function slashPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function collectToolCalls(events: AgentEvent[]): ToolCallRecord[] {
  return events
    .filter((event) => event.type === "tool_call")
    .map((event) => {
      const data = event.data as {
        name?: string;
        input?: Record<string, unknown>;
      };
      return { name: data.name ?? "unknown", input: data.input ?? {} };
    });
}

function collectToolResults(events: AgentEvent[]): ToolResultRecord[] {
  return events
    .filter((event) => event.type === "tool_result")
    .map((event) => {
      const data = event.data as {
        name?: string;
        result?: { isError?: boolean; content?: string };
      };
      return {
        name: data.name ?? "unknown",
        isError: data.result?.isError ?? false,
        content: data.result?.content ?? "",
      };
    });
}

async function main(): Promise<void> {
  const ctx = await bootstrap();
  const root = mkdtempSync(path.join(tmpdir(), "agentclaw-wechat-publish-"));
  const article = path.join(root, "article.md");
  const outDir = path.join(root, "out");
  writeFileSync(
    article,
    [
      "# 微信发布回归验收",
      "",
      "这是一篇用于 AgentClaw wechat-publish skill 真实入口回归的短文。",
      "",
      "- 必须先加载 skill",
      "- 必须走统一 CLI",
      "- 必须使用 dry-run",
    ].join("\n"),
    "utf-8",
  );

  const prompt = [
    "请使用 wechat-publish skill 对下面的 Markdown 做微信公众号草稿 dry-run 验收。",
    "要求：必须先调用 use_skill 加载 wechat-publish；必须使用统一入口 wechat_publish.py；必须加 --dry-run --json；输出目录参数必须写完整 --out-dir，不能写 --out；不要创建真实草稿；不要手写 token/curl；不要调用旧脚本。",
    `Markdown 文件：${slashPath(article)}`,
    `输出目录：${slashPath(outDir)}`,
    "完成后用一句中文说明 dry-run 是否成功。",
  ].join("\n");

  const session = await ctx.orchestrator.createSession({
    agentId: "default",
    channel: "wechat-publish-regression",
  });
  const events: AgentEvent[] = [];
  for await (const event of ctx.orchestrator.processInputStream(
    session.id,
    prompt,
    {
      agentId: "default",
      channel: "wechat-publish-regression",
    },
  )) {
    events.push(event);
  }

  const complete = events.find((event) => event.type === "response_complete");
  const message = (complete?.data as { message?: Message } | undefined)?.message;
  const traces = await ctx.memoryStore.getTraces(
    1,
    0,
    undefined,
    session.conversationId,
  );
  const run = {
    toolCalls: collectToolCalls(events),
    toolResults: collectToolResults(events),
  };
  const evaluation = evaluateWechatPublishRun(run);
  const draftPath = path.join(outDir, "draft.json");
  const articleJsonPath = path.join(outDir, "article.json");
  const artifactFailures: string[] = [];
  if (!existsSync(draftPath)) artifactFailures.push("missing_draft_json");
  if (!existsSync(articleJsonPath)) artifactFailures.push("missing_article_json");
  if (existsSync(draftPath)) {
    const draft = JSON.parse(readFileSync(draftPath, "utf-8")) as {
      articles?: Array<{ title?: string }>;
    };
    if (draft.articles?.[0]?.title !== "微信发布回归验收") {
      artifactFailures.push("draft_title_mismatch");
    }
  }

  const failures = [...evaluation.failures, ...artifactFailures];
  const summary = {
    passed: failures.length === 0,
    failures,
    traceId: traces.items[0]?.id,
    responsePreview: extractText(message?.content).slice(0, 500),
    root,
    article: slashPath(article),
    outDir: slashPath(outDir),
    evaluation,
    toolCalls: run.toolCalls,
  };
  ctx.scheduler.stopAll();
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.passed ? 0 : 2);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
