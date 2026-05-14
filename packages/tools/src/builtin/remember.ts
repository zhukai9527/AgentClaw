import type { Tool, ToolResult, ToolExecutionContext } from "@agentclaw/types";

/** Threat patterns to block from memory entries (injected into system prompt) */
const MEMORY_THREAT_PATTERNS: Array<[RegExp, string]> = [
  // Prompt injection
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
  [/you\s+are\s+now\s+/i, "role_hijack"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [
    /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
    "disregard_rules",
  ],
  // Chinese prompt injection patterns
  [/忘记.{0,10}(指令|指示|规则|提示)/i, "chinese_prompt_override"],
  [/从现在起你是/i, "chinese_role_hijack"],
  [
    /忽略.{0,10}(之前|以上|所有).{0,10}(指令|指示)/i,
    "chinese_instruction_override",
  ],
  // Exfiltration
  [
    /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    "exfil_curl",
  ],
  [
    /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    "exfil_wget",
  ],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, "read_secrets"],
];

/** Invisible unicode characters used for injection */
const INVISIBLE_CHARS = new Set([
  "\u200b",
  "\u200c",
  "\u200d",
  "\u2060",
  "\ufeff",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
]);

/**
 * Patterns indicating ephemeral/transient content that should NOT be memorized.
 * These waste system prompt tokens on every future request.
 */
const EPHEMERAL_PATTERNS: RegExp[] = [
  // News headlines / announcements — typically contain company + verb + product
  /(?:发布|推出|宣布|announces?|launches?|releases?|unveils?)\s*.{5,}/i,
  // Market / financial projections
  /(?:营收|市值|估值|revenue|valuation|stock|shares)\s*.{3,}(?:亿|万亿|billion|trillion|美元|\$)/i,
  // Versioned product releases (GPT-X.Y, Claude X, etc.)
  /(?:GPT|Claude|Gemini|Llama|Mistral|DeepSeek|Qwen)-?\s*\d+(?:\.\d+)?\s*(?:已发布|发布|released|launched)/i,
  // "X defeats/surpasses Y" competitive news
  /(?:胜率|击败|逆袭|超越|surpass|outperform|beat)\s*.{3,}(?:OpenAI|Google|Anthropic|Meta|NVIDIA)/i,
];

/**
 * Scan memory content for injection/exfiltration patterns.
 * Returns error message if blocked, null if safe.
 */
function scanMemoryContent(content: string): string | null {
  // Check invisible unicode
  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      return `Blocked: content contains invisible unicode character U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} (possible injection).`;
    }
  }
  // Check threat patterns
  for (const [pattern, id] of MEMORY_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content matches threat pattern '${id}'. Memory entries are injected into the system prompt and must not contain injection payloads.`;
    }
  }
  // Check ephemeral content (news, product launches, market data)
  for (const pattern of EPHEMERAL_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content looks like transient news/announcement. Memory is for durable personal facts, not headlines. This saves tokens on every future request.`;
    }
  }
  return null;
}

export const rememberTool: Tool = {
  name: "remember",
  description:
    "Save information to long-term memory for future recall. " +
    "Use type='identity' for user personal info (name, email, age, location, occupation). " +
    "Do NOT store news headlines, trending topics, or transient external information — " +
    "these are ephemeral and waste memory slots.",
  category: "builtin",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string" },
      type: {
        type: "string",
        enum: ["identity", "fact", "preference", "entity", "episodic"],
        description:
          "identity: user personal info (email, name, age, location); " +
          "fact: durable knowledge worth remembering long-term; " +
          "preference: user likes/dislikes; " +
          "entity: projects, tools, people the user cares about; " +
          "episodic: lessons learned from past interactions",
        default: "fact",
      },
    },
    required: ["content"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const content = input.content as string;
    const type = (input.type as string) || "fact";

    if (!context?.saveMemory) {
      return {
        content: "Memory system is not available in this context.",
        isError: true,
      };
    }

    // Scan for injection/exfiltration before saving
    const scanError = scanMemoryContent(content);
    if (scanError) {
      return { content: scanError, isError: true };
    }

    try {
      const metadata: Record<string, unknown> = {
        layer: "L1",
        source: "remember_tool",
        sceneName: "explicit_memory",
        confidence: 1,
      };
      if (context.conversationId) {
        metadata.conversationId = context.conversationId;
      }
      if (context.traceId) metadata.traceId = context.traceId;

      await context.saveMemory(
        content,
        type as "identity" | "fact" | "preference" | "entity" | "episodic",
        metadata,
      );
      return {
        content: `Remembered: ${content}`,
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Failed to save memory: ${message}`,
        isError: true,
      };
    }
  },
};
