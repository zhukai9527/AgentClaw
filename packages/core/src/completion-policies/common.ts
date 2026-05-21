import type {
  ContentBlock,
  Message,
  ToolResultContent,
} from "@agentclaw/types";

export function currentLocalDateString(date = new Date()): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function extractFallbackLines(content: string): string[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const selected: string[] = [];

  for (const line of lines) {
    if (selected.length >= 8) break;
    if (
      line.startsWith("results[") ||
      line.startsWith("hint:") ||
      line.startsWith("rawPath:") ||
      line.startsWith("observation:") ||
      line.startsWith("promptChars:") ||
      line.startsWith("savedChars:") ||
      line.startsWith("rawChars:")
    ) {
      continue;
    }
    if (/^https?:\/\//.test(line)) {
      selected.push(line);
      continue;
    }
    if (
      line.includes(" — ") ||
      line.startsWith("#") ||
      line.startsWith("- ") ||
      line.startsWith("🔥") ||
      /^[A-Za-z0-9_ -]+:/.test(line)
    ) {
      selected.push(line.replace(/^[-#]\s*/, "").slice(0, 240));
    }
  }

  return selected;
}

export function collectToolResultContents(
  messages: Message[],
): Array<{ content: string; isError?: boolean }> {
  const contents: Array<{ content: string; isError?: boolean }> = [];
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content !== "string") {
      continue;
    }
    try {
      const blocks = JSON.parse(message.content) as ContentBlock[];
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const result = block as ToolResultContent;
        if (typeof result.content === "string") {
          contents.push({ content: result.content, isError: result.isError });
        }
      }
    } catch {
      contents.push({ content: message.content });
    }
  }
  return contents;
}

export function firstMatch(
  text: string,
  ...patterns: RegExp[]
): string | undefined {
  for (const pattern of patterns) {
    const matched = text.match(pattern)?.[1]?.trim();
    if (matched) return matched;
  }
  return undefined;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
