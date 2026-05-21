import type {
  ContentBlock,
  Message,
  ToolResultContent,
} from "@agentclaw/types";
import { extractFallbackLines } from "./common.js";
import { buildEvidenceTableFallbackResponse } from "./evidence-table.js";
import type { SentFile } from "./types.js";

export function buildSynthesisFallbackResponse(
  inputText: string,
  messages: Message[],
  sentFiles: SentFile[],
  fallbackSnippets: string[],
  reason: string,
): string {
  const evidenceTable = buildEvidenceTableFallbackResponse(
    inputText,
    messages,
    sentFiles,
    fallbackSnippets,
    reason,
  );
  if (evidenceTable) return evidenceTable;

  const snippets: string[] = [...fallbackSnippets];

  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content !== "string") {
      continue;
    }
    try {
      const blocks = JSON.parse(message.content) as ContentBlock[];
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const result = block as ToolResultContent;
        if (result.isError || typeof result.content !== "string") continue;
        snippets.push(...extractFallbackLines(result.content));
      }
    } catch {
      snippets.push(...extractFallbackLines(message.content));
    }
  }

  const unique = [...new Set(snippets)].slice(0, 12);
  const files = sentFiles
    .map((file) => `- [${file.filename}](${file.url})`)
    .join("\n");
  const heading = inputText.includes("Reddit")
    ? "已根据已抓取的 Reddit/RSS 结果生成阶段性总结。"
    : "已根据已获取的搜索和网页结果生成阶段性总结。";
  const body =
    unique.length > 0
      ? unique.map((line) => `- ${line}`).join("\n")
      : /预算|budget|limit/i.test(reason)
        ? "- 已达到工具预算，但没有足够可用事实形成可靠摘要。"
        : "- 当前上下文没有足够可用事实形成可靠摘要。";

  return [
    heading,
    "",
    body,
    files ? `\n已发送/生成的文件：\n${files}` : "",
    "",
    `说明：${reason}，系统已停止继续调用工具以避免空转。`,
  ]
    .filter(Boolean)
    .join("\n");
}
