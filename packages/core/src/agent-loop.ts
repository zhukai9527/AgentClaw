import type {
  AgentLoop,
  AgentState,
  AgentConfig,
  AgentEvent,
  AgentEventListener,
  AgentEventType,
  Message,
  ContentBlock,
  ImageContent,
  ToolUseContent,
  ToolResultContent,
  ToolResult,
  ToolExecutionContext,
  LLMProvider,
  ContextManager,
  MemoryStore,
  ConversationTurn,
  Trace,
  TraceStep,
} from "@agentclaw/types";
import type { ToolRegistryImpl } from "@agentclaw/tools";
import { generateId } from "@agentclaw/providers";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import {
  buildObfuscationMap,
  obfuscateString,
  obfuscateMessages,
  restoreString,
  type ObfuscationMap,
} from "./env-obfuscator.js";
import { join, basename } from "node:path";

/**
 * Shared iteration budget between parent and child agents.
 * When a sub-agent consumes iterations, they count against the parent's total.
 */
export class IterationBudget {
  private used = 0;

  constructor(public readonly max: number) {}

  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }

  consume(n = 1): void {
    this.used += n;
  }

  unconsume(n = 1): void {
    this.used = Math.max(0, this.used - n);
  }

  get exhausted(): boolean {
    return this.used >= this.max;
  }
}

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 15,
  systemPrompt: "",
  streaming: false,
  temperature: 0.5,
  maxTokens: 8192,
};

/** Tools that are safe to retry on failure (network-dependent tools) */
const RETRYABLE_TOOLS = new Set([
  "comfyui",
  "http_request",
  "web_search",
  "web_fetch",
]);

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY = 2000; // ms

import { sanitizeString } from "./utils.js";
/**
 * Prune system prompt to avoid mentioning tools that are not available.
 * 1. In the rules/instructions area (before memory section), remove lines that
 *    reference tool-like names (snake_case identifiers in backticks or bare)
 *    not in the agent's available tool set.
 * 2. Append an explicit tool boundary declaration so the LLM knows its limits.
 *
 * Memory entries and skill catalog are left untouched (factual, not instructional).
 *
 * @param allToolNames - full set of tool names from the unfiltered registry,
 *   used to detect whether a whitelist is active and to identify tool references.
 */
/**
 * Prune system prompt: remove rules referencing unavailable tools, append boundary.
 * @param unavailableTools - pre-computed set of tool names not available to this agent
 * @param toolBoundary - pre-computed boundary declaration string, or null if no pruning needed
 */
function pruneSystemPromptForTools(
  prompt: string,
  unavailableTools: Set<string>,
  toolBoundary: string | null,
): string {
  if (!toolBoundary) return prompt;

  // Split prompt into rules section (before memory) and rest (memory + skills)
  const memorySplit =
    prompt.indexOf("\n你的长期记忆：") !== -1
      ? prompt.indexOf("\n你的长期记忆：")
      : prompt.indexOf("\nYour long-term memory:");
  const rulesSection = memorySplit !== -1 ? prompt.slice(0, memorySplit) : prompt;
  const restSection = memorySplit !== -1 ? prompt.slice(memorySplit) : "";

  const pruned = rulesSection
    .split("\n")
    .filter((line) => {
      for (const name of unavailableTools) {
        if (line.includes(name)) return false;
      }
      return true;
    })
    .join("\n");

  return pruned + restSection + toolBoundary;
}

/**
 * Micro-compact: silently truncate old tool_result content to save context space.
 * Keeps the most recent KEEP_RECENT tool-result turns intact; older ones with
 * content exceeding COMPACT_THRESHOLD get truncated to COMPACT_PREVIEW chars
 * plus a length marker. Runs every iteration, no LLM involved.
 */
const MICRO_COMPACT_KEEP_RECENT = 3;
const MICRO_COMPACT_THRESHOLD = 800;
const MICRO_COMPACT_PREVIEW = 200;
/** Tool names whose input arguments should be truncated after execution */
const TRUNCATE_ARG_TOOLS = new Set(["file_write", "file_edit", "execute_code", "bash"]);
const TRUNCATE_ARG_KEYS = new Set(["content", "new_string", "code", "command"]);
const TRUNCATE_ARG_PREVIEW = 50;

function microCompact(messages: Message[]): void {
  // Find all tool-role messages (contain tool_result blocks)
  const toolMsgIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolMsgIndices.push(i);
  }
  // Only compact if there are enough tool messages
  if (toolMsgIndices.length <= MICRO_COMPACT_KEEP_RECENT) return;

  const toCompact = toolMsgIndices.slice(
    0,
    toolMsgIndices.length - MICRO_COMPACT_KEEP_RECENT,
  );

  let truncatedCount = 0;
  let savedChars = 0;

  /** Truncate a single tool_result content string if over threshold */
  const truncateContent = (content: string): string | null => {
    if (content.length <= MICRO_COMPACT_THRESHOLD) return null;
    const originalLength = content.length;
    truncatedCount++;
    savedChars += originalLength - MICRO_COMPACT_PREVIEW;
    return content.slice(0, MICRO_COMPACT_PREVIEW) + `\n\n[... truncated from ${originalLength} chars]`;
  };

  for (const idx of toCompact) {
    const msg = messages[idx];
    if (typeof msg.content === "string") {
      try {
        const blocks = JSON.parse(msg.content) as ContentBlock[];
        let changed = false;
        for (const block of blocks) {
          if (
            block.type === "tool_result" &&
            typeof (block as ToolResultContent).content === "string"
          ) {
            const result = truncateContent((block as ToolResultContent).content);
            if (result !== null) {
              (block as ToolResultContent).content = result;
              changed = true;
            }
          }
        }
        if (changed) msg.content = JSON.stringify(blocks);
      } catch {
        const result = truncateContent(msg.content);
        if (result !== null) {
          msg.content = result;
        }
      }
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (
          block.type === "tool_result" &&
          typeof (block as ToolResultContent).content === "string"
        ) {
          const result = truncateContent((block as ToolResultContent).content);
          if (result !== null) {
            (block as ToolResultContent).content = result;
          }
        }
      }
    }

    // ── Tool Argument Truncation ──
    // Also truncate the corresponding assistant message's tool_call input args
    // (file_write content, file_edit new_string, execute_code code are huge after execution)
    if (idx > 0 && messages[idx - 1]?.role === "assistant") {
      const assistantMsg = messages[idx - 1];
      if (Array.isArray(assistantMsg.content)) {
        for (const block of assistantMsg.content) {
          if (
            block.type === "tool_use" &&
            TRUNCATE_ARG_TOOLS.has((block as ToolUseContent).name)
          ) {
            const input = (block as ToolUseContent).input as Record<string, unknown>;
            if (input) {
              for (const key of TRUNCATE_ARG_KEYS) {
                if (typeof input[key] === "string" && (input[key] as string).length > TRUNCATE_ARG_PREVIEW) {
                  input[key] = (input[key] as string).slice(0, TRUNCATE_ARG_PREVIEW) + "...(truncated)";
                }
              }
            }
          }
        }
      }
    }
  }

  if (truncatedCount > 0) {
    console.log(`[microCompact] truncated ${truncatedCount} tool_result(s), saved ${savedChars} chars`);
  }
}

/** Stop the loop if this many consecutive iterations produce only errors */
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Overflow threshold (chars). Tool outputs exceeding this are saved to a temp
 * file so the LLM receives a concise preview + file reference instead of the
 * full content.  The LLM can then use file_read / grep to explore at will.
 */
const OVERFLOW_THRESHOLD = 8_000;
/** How many chars of the original output to keep as an inline preview */
const OVERFLOW_PREVIEW_CHARS = 1_500;

/**
 * Overflow mode: when a tool's output exceeds OVERFLOW_THRESHOLD, save the
 * full content to a temp file and replace result.content with a preview +
 * file reference.  This turns "truncation → data loss" into "deferred access".
 *
 * Returns the overflow file path if overflow was applied, null otherwise.
 */
function applyOverflow(
  result: {
    content: string;
    isError?: boolean;
    metadata?: Record<string, unknown>;
  },
  toolName: string,
  sessionTmpDir: string,
  toolInput?: Record<string, unknown>,
): string | null {
  // Don't overflow errors (usually short and important) or short outputs
  if (result.isError || result.content.length <= OVERFLOW_THRESHOLD)
    return null;

  // Never overflow use_skill — skill content is instructions that must be
  // fully visible to the LLM, truncating defeats the purpose
  if (toolName === "use_skill") return null;

  // Never overflow file_read of an overflow file — prevents infinite loop
  // where LLM reads overflow → result overflows → LLM reads new overflow → ...
  if (toolName === "file_read" && typeof toolInput?.path === "string") {
    const p = (toolInput.path as string).replace(/\\/g, "/");
    if (p.includes("/overflow_") && p.endsWith(".txt")) return null;
  }

  // Save full content to file
  const ts = Date.now();
  const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `overflow_${safeName}_${ts}.txt`;
  const filePath = join(sessionTmpDir, fileName).replace(/\\/g, "/");
  writeFileSync(filePath, result.content, "utf-8");

  const totalChars = result.content.length;
  const totalLines = result.content.split("\n").length;

  // Replace content with preview + reference
  const preview = result.content.slice(0, OVERFLOW_PREVIEW_CHARS);
  // Cut at last newline to avoid mid-line break
  const lastNL = preview.lastIndexOf("\n");
  const cleanPreview =
    lastNL > OVERFLOW_PREVIEW_CHARS * 0.5 ? preview.slice(0, lastNL) : preview;

  result.content =
    cleanPreview +
    `\n\n... [输出过长，完整内容已保存: ${filePath} (${totalLines} 行, ${totalChars} 字符)]\n` +
    `用 file_read 查看完整内容，或用 grep 搜索关键信息。`;

  // Record overflow info in metadata
  if (!result.metadata) result.metadata = {};
  result.metadata.overflow = true;
  result.metadata.overflowPath = filePath;
  result.metadata.originalLength = totalChars;
  result.metadata.originalLines = totalLines;

  return filePath;
}

/**
 * Sentinel string for max-iterations fallback.
 * Frontend i18n detects this exact string and replaces it with the localized version.
 */
const MAX_ITERATIONS_MESSAGE =
  "I've reached the maximum number of iterations. Please try breaking your request into smaller steps.";

/** Build a dedup key for per-tool failure tracking */
function buildFailKey(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  // Include distinguishing parameter so a corrected call isn't blocked
  if (toolName === "bash" && typeof toolInput?.command === "string") {
    return `bash:${toolInput.command.slice(0, 200)}`;
  }

  // file_read on overflow files: normalize to just "overflow_read" so
  // repeated reads of different overflow files are treated as duplicates
  if (toolName === "file_read" && typeof toolInput?.path === "string") {
    const p = (toolInput.path as string).replace(/\\/g, "/");
    if (p.includes("/overflow_") && p.endsWith(".txt")) {
      return "file_read:overflow";
    }
  }

  // For file tools, different paths or content types are different calls
  const sig = toolInput ? JSON.stringify(toolInput).slice(0, 120) : "";
  return `${toolName}:${sig}`;
}

export class SimpleAgentLoop implements AgentLoop {
  private _state: AgentState = "idle";
  private _config: AgentConfig;
  private provider: LLMProvider;
  private toolRegistry: ToolRegistryImpl;
  private contextManager: ContextManager;
  private memoryStore: MemoryStore;
  private listeners: Set<AgentEventListener> = new Set();
  private aborted = false;
  private abortController: AbortController | null = null;
  private iterationBudget?: IterationBudget;
  /** Full set of tool names from unfiltered registry (for system prompt pruning) */
  private allToolNames: Set<string>;
  /**
   * Optional callback for LLM stream errors — allows SmartRouter to classify
   * errors and apply model cooldowns without tight coupling.
   * Signature: (providerName, modelId, error) => { retryable: boolean }
   */
  private onLLMError?: (
    providerName: string,
    modelId: string,
    error: unknown,
  ) => { retryable: boolean };

  get state(): AgentState {
    return this._state;
  }

  get config(): AgentConfig {
    return this._config;
  }

  constructor(options: {
    provider: LLMProvider;
    toolRegistry: ToolRegistryImpl;
    contextManager: ContextManager;
    memoryStore: MemoryStore;
    config?: Partial<AgentConfig>;
    iterationBudget?: IterationBudget;
    allToolNames?: Set<string>;
    /** Report LLM errors to router for classification & cooldown */
    onLLMError?: (
      providerName: string,
      modelId: string,
      error: unknown,
    ) => { retryable: boolean };
  }) {
    this.provider = options.provider;
    this.toolRegistry = options.toolRegistry;
    this.contextManager = options.contextManager;
    this.memoryStore = options.memoryStore;
    this._config = { ...DEFAULT_CONFIG, ...options.config };
    this.iterationBudget = options.iterationBudget;
    this.allToolNames = options.allToolNames ?? new Set(options.toolRegistry.list().map((t) => t.name));
    this.onLLMError = options.onLLMError;
  }

  async run(
    input: string | ContentBlock[],
    conversationId?: string,
    context?: ToolExecutionContext,
  ): Promise<Message> {
    let lastMessage: Message | undefined;
    for await (const event of this.runStream(input, conversationId, context)) {
      if (event.type === "response_complete") {
        lastMessage = (event.data as { message: Message }).message;
      }
    }
    return (
      lastMessage ?? {
        id: generateId(),
        role: "assistant",
        content: "No response generated.",
        createdAt: new Date(),
      }
    );
  }

  async *runStream(
    input: string | ContentBlock[],
    conversationId?: string,
    context?: ToolExecutionContext,
  ): AsyncIterable<AgentEvent> {
    this.aborted = false;
    this.abortController = new AbortController();
    if (context) {
      context.abortSignal = this.abortController.signal;
    }
    const convId = conversationId ?? generateId();
    const startTime = Date.now();

    // Build env obfuscation map once per run (reused across iterations)
    const envMap = buildObfuscationMap();

    // Accumulators across all LLM iterations
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;
    let totalToolCalls = 0;
    let prevTokensIn = 0;
    let prevTokensOut = 0;
    let usedModel: string | undefined;
    // Accumulate files sent by tools (for persistence)
    const allSentFiles: Array<{ url: string; filename: string }> = [];

    // Trace for debugging
    const trace: Trace = {
      id: generateId(),
      conversationId: convId,
      userInput: typeof input === "string" ? input : JSON.stringify(input),
      steps: [],
      channel: context?.channel,
      agentId: context?.agentId,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      createdAt: new Date(),
    };

    // Per-session temp directory: data/tmp/{conversationId}/
    // Lazy-created: directory only exists when a tool actually needs to write a file.
    // Pure text API calls never touch the filesystem.
    const sessionTmpDir = join(process.cwd(), "data", "tmp", convId).replace(
      /\\/g,
      "/",
    );
    let sessionTmpDirCreated = false;
    const ensureSessionTmpDir = () => {
      if (!sessionTmpDirCreated) {
        mkdirSync(sessionTmpDir, { recursive: true });
        sessionTmpDirCreated = true;
      }
      return sessionTmpDir;
    };

    // Expose working directory to tools (use_skill replaces {WORKDIR})
    // Tools that need to write files should call ensureSessionTmpDir() or
    // mkdirSync(context.workDir) before writing — most already do.
    if (context) context.workDir = sessionTmpDir;

    // ── Collect all user files into session dir ──
    // 1. Images: save base64 to session dir, record path for DB storage
    const savedImagePaths: string[] = [];
    const imagePathMap = new Map<ImageContent, string>(); // block → saved file path
    // 2. Attachments (video, docs, etc.): copy from data/tmp/ root to session dir
    const relocatedFiles = new Map<string, string>(); // original path → per-session path

    if (Array.isArray(input)) {
      for (const block of input) {
        if (block.type === "image" && (block as ImageContent).data) {
          const img = block as ImageContent;
          // 优先使用上传时的原始文件名，fallback 到通用名
          const ext = img.mediaType?.includes("png") ? "png" : "jpg";
          let filename = img.filename || `user_image_${Date.now()}.${ext}`;
          ensureSessionTmpDir();
          let filePath = join(sessionTmpDir, filename).replace(/\\/g, "/");
          // Deduplicate: if file already exists from a previous turn, add timestamp suffix
          if (existsSync(filePath)) {
            const dotIdx = filename.lastIndexOf(".");
            filename =
              dotIdx > 0
                ? `${filename.slice(0, dotIdx)}_${Date.now()}${filename.slice(dotIdx)}`
                : `${filename}_${Date.now()}`;
            filePath = join(sessionTmpDir, filename).replace(/\\/g, "/");
          }
          try {
            writeFileSync(filePath, Buffer.from(img.data, "base64"));
            savedImagePaths.push(filePath);
            imagePathMap.set(img, filePath);
          } catch {
            // save failed, keep original base64
          }
        }
        // Relocate non-image attachments referenced in text blocks
        // ws.ts format: "用户上传了附件，已保存到：/abs/path\n注意：..."
        if (block.type === "text") {
          const re = /已保存到：([^\n]+)/g;
          let m;
          while ((m = re.exec(block.text)) !== null) {
            const origPath = m[1].trim();
            if (existsSync(origPath)) {
              const newPath = join(sessionTmpDir, basename(origPath)).replace(
                /\\/g,
                "/",
              );
              try {
                ensureSessionTmpDir();
                copyFileSync(origPath, newPath);
                try {
                  unlinkSync(origPath);
                } catch {
                  /* ignore */
                }
                relocatedFiles.set(origPath, newPath);
              } catch {
                /* move failed — keep original path */
              }
            }
          }
        }
      }
    }

    // Build runtime hints — injected into messages after buildContext
    // 图片路径已在 ws.ts 的 fileHints 中（格式同附件），relocate 逻辑会自动重写到 session 目录
    const runtimeHints: string[] = [
      `[工作目录：${sessionTmpDir}]（所有文件都在此目录下，输出也保存到这里）`,
    ];
    // runtimeHints.join("\n") is computed dynamically each iteration (runtimeHints grows via push)

    // DB 存储：多模态输入存 ContentBlock[] JSON（image.data 替换为 file:// 路径，避免 DB 膨胀）
    // turnToMessage 读取时从磁盘加载 base64 还原
    let userContentForStorage: string;
    if (typeof input === "string") {
      userContentForStorage = context?.originalUserText ?? input;
    } else {
      // 替换 image block 的 base64 data 为 file:// 引用
      const storable = input.map((block) => {
        if (block.type === "image") {
          const img = block as ImageContent;
          const savedPath = imagePathMap.get(img);
          if (savedPath) {
            return {
              type: "image",
              mediaType: img.mediaType,
              filePath: savedPath,
              filename: img.filename,
            };
          }
        }
        return block;
      });
      userContentForStorage = JSON.stringify(storable);
    }

    // 存储用户消息到 DB
    const userTurn: ConversationTurn = {
      id: generateId(),
      conversationId: convId,
      role: "user",
      content: userContentForStorage,
      createdAt: new Date(),
    };
    await this.memoryStore.addTurn(convId, userTurn);

    // Track per-tool failure counts across iterations to prevent retry avalanche
    const toolFailCounts = new Map<string, number>();
    const MAX_TOOL_FAILURES = 2;

    // Track per-tool call counts to detect repetitive calling (success or fail)
    const toolCallCounts = new Map<string, number>();
    const MAX_DUPLICATE_CALLS = 2; // same tool+params called >2 times → short-circuit

    // Global per-tool-name call counter — caps total calls regardless of params
    const toolNameCounts = new Map<string, number>();
    const TOOL_TOTAL_LIMITS: Record<string, number> = {
      web_search: 8, // 8 searches per session is plenty
      web_fetch: 8,
    };

    // Global tool call counter — absolute safety net against any loop pattern
    let globalCallCount = 0;
    const MAX_TOTAL_TOOL_CALLS = 40; // no single user message needs 40+ tool calls

    const MAX_CONSECUTIVE_ROLLBACKS = 3;
    let consecutiveRollbacks = 0;

    // Skill injection is handled entirely by use_skill tool — no auto-injection.
    // This keeps the system prompt lean; LLM decides which skill to load.
    const effectiveSkillName = context?.preSelectedSkillName;

    // Agent loop: think → act → observe → repeat
    let iterations = 0;
    let useSkillRollbacks = 0;
    let consecutiveErrors = 0;
    let lastFullText = ""; // Keep last LLM text for fallback response
    let todoItems: Array<{ text: string; done: boolean }> = [];
    let todoAutoIndex = 0; // Next item to auto-check
    let firstUseSkillCounted = false;

    // Three-strike escalation: detect when LLM is stuck producing similar outputs.
    // If 3 consecutive iterations have similar output fingerprints, inject a hint
    // to change strategy. Inspired by ClawRouter session escalation.
    const recentFingerprints: string[] = [];
    let escalated = false;
    const STRIKE_THRESHOLD = 3;

    // execute_code nudge: when agent uses 3+ web_search/web_fetch calls without
    // using execute_code, inject a hint reminding it to batch via execute_code.
    let executeCodeNudged = false;
    let usedExecuteCode = false;
    const FETCH_SEARCH_NUDGE_THRESHOLD = 3;

    // Pre-compute tool pruning data (fixed for the entire loop)
    const loopToolDefs = this.toolRegistry.definitions();
    const loopAvailableTools = new Set(loopToolDefs.map((t) => t.name));
    const loopUnavailableTools = new Set<string>();
    for (const name of this.allToolNames) {
      if (!loopAvailableTools.has(name)) loopUnavailableTools.add(name);
    }
    const loopToolBoundary =
      loopAvailableTools.size < this.allToolNames.size - 2
        ? `\n[可用工具：${Array.from(loopAvailableTools).sort().join(", ")}]\n你只能使用上述工具，不要调用任何不在列表中的工具。`
        : null;

    // Wrap the entire loop in try-finally to guarantee trace persistence.
    // Without this, if the consumer (orchestrator/WS) stops pulling from the
    // generator (user abort, disconnect), the trace is never saved.
    let tracePersistedInLoop = false;
    try {

    while (iterations < this._config.maxIterations && !this.aborted) {
      // Check shared budget (parent + children share the same IterationBudget)
      if (this.iterationBudget?.exhausted) {
        yield this.createEvent("thinking", {
          text: "Iteration budget exhausted.",
        });
        break;
      }
      iterations++;
      this.iterationBudget?.consume();

      // ── Drain background task results ──
      // Completed background tasks are injected as runtime hints so the LLM
      // sees them naturally at the start of the next iteration.
      if (context?.backgroundQueue && context.backgroundQueue.length > 0) {
        const completed = context.backgroundQueue.splice(0);
        for (const bg of completed) {
          const status = bg.isError ? "FAILED" : "OK";
          // Truncate long output — overflow mode will catch it if stored as tool result,
          // but here we inline into hints so keep it short
          const output =
            bg.content.length > 2000
              ? bg.content.slice(0, 2000) +
                `\n... [truncated, ${bg.content.length} chars]`
              : bg.content;
          runtimeHints.push(
            `[Background task ${bg.id} completed (${status})]\n$ ${bg.command}\n${output}`,
          );
        }
      }

      // Build context (iteration 2+ reuses cached dynamic prefix for KV-cache stability)
      this.setState("thinking");
      const { systemPrompt, messages, skillMatch } =
        await this.contextManager.buildContext(convId, input, {
          preSelectedSkillName: effectiveSkillName,
          reuseContext: iterations > 1,
          memoryNamespace: context?.memoryNamespace,
          disabledSkills: context?.disabledSkills,
        });

      // Inject runtime hints + rewrite relocated file paths in the last user message.
      // DB stores original paths (UI stays clean), LLM sees per-session paths every iteration.
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === "user") {
          // Rewrite attachment paths from data/tmp/ root → per-session dir
          const rewrite = (text: string): string => {
            let result = text;
            for (const [orig, relocated] of relocatedFiles) {
              result = result.replaceAll(orig, relocated);
            }
            return result;
          };
          if (typeof lastMsg.content === "string") {
            lastMsg.content = `${rewrite(lastMsg.content)}\n${runtimeHints.join("\n")}`;
          } else if (Array.isArray(lastMsg.content)) {
            for (const block of lastMsg.content as ContentBlock[]) {
              if (block.type === "text") {
                block.text = rewrite(block.text);
              }
            }
            (lastMsg.content as ContentBlock[]).push({
              type: "text",
              text: runtimeHints.join("\n"),
            });
          }
        }
      }

      // ── Micro-compact: silently shrink old tool_result content ──
      // Keep only the 3 most recent tool result turns intact; older ones get
      // their content replaced with a short placeholder. Saves tokens every
      // turn without LLM involvement.
      microCompact(messages);

      // ── Identity re-injection after compression ──
      // When context was compressed (messages start with summary), the agent
      // may lose its persona. Re-inject identity if context looks compressed.
      if (
        context?.agentId &&
        context.agentId !== "default" &&
        messages.length >= 2 &&
        messages[0]?.id === "summary"
      ) {
        const agents = context.agents || [];
        const self = agents.find((a) => a.id === context!.agentId) || {
          name: context.agentId,
        };
        const identityBlock = `<identity>You are ${(self as { name: string }).name}. Stay in character.</identity>`;
        // Inject after the summary-ack message
        if (
          messages[1]?.role === "assistant" &&
          typeof messages[1].content === "string"
        ) {
          messages[1].content += `\n${identityBlock}`;
        }
      }

      // Notify thinking
      yield this.createEvent("thinking", { iteration: iterations });

      // Stream LLM response
      let fullText = "";
      const pendingToolCalls: Map<
        number,
        { id: string; name: string; args: string }
      > = new Map();
      let toolIndex = 0;

      // Inject _intent field into each tool schema for Intent Tracing.
      // LLM must state its intent before calling a tool → improves explainability.
      const tools = this.toolRegistry.definitions().map((t) => ({
        ...t,
        parameters: {
          ...t.parameters,
          properties: {
            _intent: {
              type: "string" as const,
              description: "Why you are calling this tool (1 sentence)",
            },
            ...t.parameters.properties,
          },
          required: ["_intent", ...(t.parameters.required ?? [])],
        },
      }));

      // Obfuscate sensitive env values before sending to LLM provider
      const safeMessages = obfuscateMessages(messages, envMap);
      let safeSystemPrompt = obfuscateString(systemPrompt, envMap);

      // Agent-specific system prompt pruning (uses pre-computed sets)
      safeSystemPrompt = pruneSystemPromptForTools(
        safeSystemPrompt,
        loopUnavailableTools,
        loopToolBoundary,
      );

      // Record trace metadata on first iteration (after pruning so trace reflects actual prompt)
      if (iterations === 1) {
        trace.systemPrompt = safeSystemPrompt;
        if (skillMatch) {
          trace.skillMatch = JSON.stringify(skillMatch);
        }
      }

      const stream = this.provider.stream({
        messages: safeMessages,
        systemPrompt: safeSystemPrompt,
        tools,
        model: this._config.model,
        temperature: this._config.temperature,
        maxTokens: this._config.maxTokens,
      });

      // 流异常捕获：网络断开/API 错误时仍需保留 token 统计和 trace
      let streamError: Error | undefined;
      try {
        for await (const chunk of stream) {
          if (this.aborted) break;

          switch (chunk.type) {
            case "text":
              if (chunk.text) {
                fullText += chunk.text;
                yield this.createEvent("response_chunk", { text: chunk.text });
              }
              break;
            case "tool_use_start":
              if (chunk.toolUse) {
                pendingToolCalls.set(toolIndex, {
                  id: chunk.toolUse.id,
                  name: chunk.toolUse.name,
                  args: chunk.toolUse.input ?? "",
                });
                toolIndex++;
              }
              break;
            case "tool_use_delta":
              if (chunk.toolUse) {
                // Find the most recent pending tool call to append to
                const lastIdx = toolIndex - 1;
                const pending = pendingToolCalls.get(lastIdx);
                if (pending) {
                  pending.args += chunk.toolUse.input ?? "";
                }
              }
              break;
            case "done":
              // Accumulate usage from this LLM call
              if (chunk.usage) {
                totalTokensIn += chunk.usage.tokensIn;
                totalTokensOut += chunk.usage.tokensOut;
                totalCacheCreationTokens +=
                  chunk.usage.cacheCreationTokens ?? 0;
                totalCacheReadTokens += chunk.usage.cacheReadTokens ?? 0;
              }
              if (chunk.model) {
                usedModel = chunk.model;
              }
              if (chunk.stopReason === "max_tokens") {
                console.warn(
                  `[agent-loop] LLM output truncated (max_tokens reached at ${this._config.maxTokens} tokens)`,
                );
              }
              break;
          }
        }
      } catch (err) {
        // 流中断时记录错误，但不阻断后续 token 统计和 trace 保存
        streamError = err instanceof Error ? err : new Error(String(err));
        console.error(`[agent-loop] LLM stream error: ${streamError.message}`);
        yield this.createEvent("error", { error: streamError.message });

        // Report to router for error classification & model cooldown
        if (this.onLLMError) {
          const modelId = usedModel || this._config.model || "";
          this.onLLMError(this.provider.name, modelId, streamError);
        }
      } finally {
        // 确保 LLM stream 资源释放，防止 abort/break 后 HTTP 连接悬挂
        const s = stream as AsyncIterable<unknown> & {
          abort?: () => void;
          return?: () => Promise<unknown>;
        };
        if (typeof s.abort === "function") {
          s.abort();
        } else if (typeof s.return === "function") {
          await s.return();
        }
      }

      // Compute per-iteration delta
      const iterTokensIn = totalTokensIn - prevTokensIn;
      const iterTokensOut = totalTokensOut - prevTokensOut;
      prevTokensIn = totalTokensIn;
      prevTokensOut = totalTokensOut;

      if (fullText) lastFullText = fullText;

      // Record LLM call in trace (include text if any)
      const llmStep: Record<string, unknown> = {
        type: "llm_call",
        iteration: iterations,
        tokensIn: iterTokensIn,
        tokensOut: iterTokensOut,
      };
      if (fullText) llmStep.text = fullText;
      if (streamError) llmStep.error = streamError.message;
      trace.steps.push(llmStep as TraceStep);

      // 流异常时跳过工具调用，直接结束本轮循环
      if (streamError) break;

      // Restore any obfuscated env placeholders in LLM text output
      fullText = restoreString(fullText, envMap);

      // Build tool calls from accumulated chunks
      // Extract _intent from each tool call (Intent Tracing) — strip before execution
      const toolCalls: (ToolUseContent & {
        intent?: string;
        _formatError?: boolean;
      })[] = [];
      for (const [, tc] of pendingToolCalls) {
        let parsedInput: Record<string, unknown> = {};
        let formatError = false;
        if (tc.args) {
          try {
            parsedInput = JSON.parse(tc.args);
          } catch {
            parsedInput = { _raw: tc.args };
            formatError = true;
          }
        }
        // Extract and strip _intent
        const intent =
          typeof parsedInput._intent === "string"
            ? (parsedInput._intent as string)
            : undefined;
        delete parsedInput._intent;

        // Restore obfuscated env placeholders in tool args so tools get real values
        const restoredInput = JSON.parse(
          restoreString(JSON.stringify(parsedInput), envMap),
        ) as Record<string, unknown>;

        const call: ToolUseContent & {
          intent?: string;
          _formatError?: boolean;
        } = {
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: restoredInput,
        };
        if (intent) call.intent = intent;
        if (formatError) call._formatError = true;
        toolCalls.push(call);
      }

      totalToolCalls += toolCalls.length;

      // Build content blocks for the assistant message
      const contentBlocks: ContentBlock[] = [];
      if (fullText) {
        contentBlocks.push({ type: "text", text: fullText });
      }
      contentBlocks.push(...toolCalls);

      // When this is the final response (no tool calls), append file markdown
      // so that sent files persist in the conversation history.
      // Skip files whose filename already appears in the LLM's response text.
      let storedText = fullText;
      if (toolCalls.length === 0 && allSentFiles.length > 0) {
        const newFiles = allSentFiles.filter(
          (f) => !fullText.includes(f.filename),
        );
        if (newFiles.length > 0) {
          const filesMd = newFiles
            .map((f) => {
              const isImage = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(
                f.filename,
              );
              return isImage
                ? `![${f.filename}](${f.url})`
                : `[${f.filename}](${f.url})`;
            })
            .join("\n");
          storedText = storedText ? `${storedText}\n${filesMd}` : filesMd;
        }
      }

      // BeforeReturn hooks (replaces hardcoded incomplete-todo guard)
      if (toolCalls.length === 0 && iterations < this._config.maxIterations) {
        const hookResult = await context?.toolHooks?.beforeReturn?.({
          response: fullText,
          runtimeHints,
          todoItems,
        });
        if (hookResult?.action === "continue") {
          runtimeHints.push(hookResult.hint);
          todoAutoIndex = todoItems.length; // prevent infinite reminders
          continue;
        }
      }

      // ── Auto-send unsent files mentioned in response ──
      // If the LLM mentions a data/tmp/ file path but didn't call send_file,
      // automatically send it. Prevents "here's your file at D:/..." on IM channels.
      if (toolCalls.length === 0 && context?.sendFile && fullText) {
        const filePathPattern =
          /[A-Za-z]:\/[^\s"'<>|]*data\/tmp\/[^\s"'<>|]+\.[a-z]{1,5}/gi;
        const mentionedPaths = fullText.match(filePathPattern) || [];
        const sentUrls = new Set(allSentFiles.map((f) => f.url));
        for (const filePath of mentionedPaths) {
          const normalized = filePath.replace(/\\/g, "/");
          const filename = normalized.split("/").pop() || "";
          // Skip if already sent or if it's an overflow file
          if (
            sentUrls.has(`/files/${filename}`) ||
            filename.startsWith("overflow_")
          ) {
            continue;
          }
          try {
            const { existsSync } = await import("node:fs");
            if (existsSync(normalized)) {
              await context.sendFile(normalized, filename);
              console.log(
                `[agent-loop] Auto-sent unsent file: ${filename}`,
              );
            }
          } catch {
            // Best-effort, don't block response
          }
        }
      }

      // If no tool calls, this is the final turn — store cumulative totals
      if (toolCalls.length === 0) {
        const durationMs = Date.now() - startTime;

        const assistantTurn: ConversationTurn = {
          id: generateId(),
          conversationId: convId,
          role: "assistant",
          content: storedText,
          model: usedModel,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          cacheCreationTokens: totalCacheCreationTokens || undefined,
          cacheReadTokens: totalCacheReadTokens || undefined,
          durationMs,
          toolCallCount: totalToolCalls,
          traceId: trace.id,
          createdAt: new Date(),
        };
        await this.memoryStore.addTurn(convId, assistantTurn);

        // Finalize and persist trace
        trace.response = storedText;
        trace.model = usedModel;
        trace.tokensIn = totalTokensIn;
        trace.tokensOut = totalTokensOut;
        trace.cacheCreationTokens = totalCacheCreationTokens || undefined;
        trace.cacheReadTokens = totalCacheReadTokens || undefined;
        trace.durationMs = durationMs;
        try {
          await this.memoryStore.addTrace(trace);
        } catch (e) {
          console.error("[agent-loop] Failed to persist trace:", e);
        }

        const message: Message = {
          id: generateId(),
          role: "assistant",
          content: contentBlocks.length > 0 ? contentBlocks : storedText,
          createdAt: new Date(),
          model: usedModel,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          cacheCreationTokens: totalCacheCreationTokens || undefined,
          cacheReadTokens: totalCacheReadTokens || undefined,
          durationMs,
          toolCallCount: totalToolCalls,
        };
        this.setState("idle");
        yield this.createEvent("response_complete", {
          message,
          agentId: context?.agentId,
        });
        return;
      }

      // Intermediate turn — store per-iteration tokens
      const assistantTurnCreatedAt = new Date();
      const assistantTurn: ConversationTurn = {
        id: generateId(),
        conversationId: convId,
        role: "assistant",
        content: storedText,
        toolCalls: JSON.stringify(toolCalls),
        model: usedModel,
        tokensIn: iterTokensIn,
        tokensOut: iterTokensOut,
        traceId: trace.id,
        createdAt: assistantTurnCreatedAt,
      };
      await this.memoryStore.addTurn(convId, assistantTurn);

      // Execute tool calls — pure tools run in parallel, impure tools act as barriers
      this.setState("tool_calling");
      let iterationErrorCount = 0;
      let hasAutoComplete = false;

      // Helper: execute a single tool call (no yielding — pure computation)
      type ToolExecResult = {
        toolCall: (typeof toolCalls)[0];
        effectiveToolName: string;
        effectiveToolInput: Record<string, unknown>;
        result: ToolResult;
        toolDurationMs: number;
        blockedByPolicy: boolean;
        isFormatError: boolean;
        rateLimited: boolean; // blocked by our dedup/limit guards
      };

      const executeOne = async (
        tc: (typeof toolCalls)[0],
      ): Promise<ToolExecResult> => {
        let effectiveToolName = tc.name;
        let effectiveToolInput = tc.input;
        let result!: ToolResult;
        let blockedByPolicy = false;

        // Check tool access policy
        if (context?.toolPolicy) {
          const { allow, deny } = context.toolPolicy;
          const denied = deny?.includes(effectiveToolName);
          const notAllowed = allow && !allow.includes(effectiveToolName);
          if (denied || notAllowed) {
            result = {
              content: `Tool "${effectiveToolName}" is blocked by policy`,
              isError: true,
            };
            blockedByPolicy = true;
          }
        }

        // Run before hooks (skip if already blocked by policy)
        if (!blockedByPolicy && context?.toolHooks?.before) {
          const modified = await context.toolHooks.before({
            name: effectiveToolName,
            input: effectiveToolInput,
          });
          if (modified === null) {
            result = {
              content: `Tool "${effectiveToolName}" was blocked by a before hook`,
              isError: true,
            };
            blockedByPolicy = true;
          } else {
            effectiveToolName = modified.name;
            effectiveToolInput = modified.input;
          }
        }

        const toolStart = Date.now();

        if (!blockedByPolicy) {
          globalCallCount++;

          // Absolute safety net: cap total tool calls per user message
          if (globalCallCount > MAX_TOTAL_TOOL_CALLS) {
            console.log(
              `[agent-loop] Global tool call limit reached: ${globalCallCount}/${MAX_TOTAL_TOOL_CALLS}`,
            );
            result = {
              content: `Global tool call limit reached (${MAX_TOTAL_TOOL_CALLS}). You MUST stop using tools and respond to the user immediately with whatever information you have gathered so far.`,
              isError: true,
            };
          }

          const dupKey = buildFailKey(effectiveToolName, effectiveToolInput);
          const priorCalls = toolCallCounts.get(dupKey) ?? 0;
          toolCallCounts.set(dupKey, priorCalls + 1);

          // Track total calls per tool name (regardless of params)
          const nameCount = (toolNameCounts.get(effectiveToolName) ?? 0) + 1;
          toolNameCounts.set(effectiveToolName, nameCount);
          const totalLimit = TOOL_TOTAL_LIMITS[effectiveToolName];

          // Detect repetitive calls — same tool+params called too many times
          if (result) {
            // Already blocked by global limit above
          } else if (totalLimit && nameCount > totalLimit) {
            console.log(
              `[agent-loop] Total call limit reached: ${effectiveToolName} (${nameCount}/${totalLimit})`,
            );
            result = {
              content: `You have called ${effectiveToolName} ${nameCount} times in this session (limit: ${totalLimit}). You have enough information — stop searching and synthesize your answer NOW from the results you already have.`,
              isError: true,
            };
          } else if (priorCalls >= MAX_DUPLICATE_CALLS) {
            console.log(
              `[agent-loop] Duplicate call blocked: ${effectiveToolName} (${priorCalls + 1}x)`,
            );
            result = {
              content: `You have already called ${effectiveToolName} with the same parameters ${priorCalls} times. Use the results you already have. Do NOT search again — synthesize your answer from existing information.`,
              isError: true,
            };
          } else if (toolFailCounts.get(dupKey) ?? 0 >= MAX_TOOL_FAILURES) {
            result = {
              content: `This tool has failed ${toolFailCounts.get(dupKey)} times in this conversation. Stop retrying and tell the user what went wrong.`,
              isError: true,
            };
          } else {
            result = await this.toolRegistry.execute(
              effectiveToolName,
              effectiveToolInput,
              context,
            );

            // Retry retryable tools on failure
            if (result.isError && RETRYABLE_TOOLS.has(effectiveToolName)) {
              for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                if (this.aborted) break;
                const delay = RETRY_BASE_DELAY * 2 ** (attempt - 1);
                console.log(
                  `[agent-loop] Retrying ${effectiveToolName} (attempt ${attempt}/${MAX_RETRIES}) after ${delay}ms...`,
                );
                await new Promise((r) => setTimeout(r, delay));
                if (this.aborted) break;
                result = await this.toolRegistry.execute(
                  effectiveToolName,
                  effectiveToolInput,
                  context,
                );
                if (!result.isError) break;
              }
            }
          }

          // Run after hooks
          if (context?.toolHooks?.after) {
            result = await context.toolHooks.after(
              { name: effectiveToolName, input: effectiveToolInput },
              result!,
            );
          }

          // Overflow mode: large outputs → save to file, give LLM a preview
          applyOverflow(
            result!,
            effectiveToolName,
            ensureSessionTmpDir(),
            effectiveToolInput,
          );
        }

        const toolDurationMs = Date.now() - toolStart;
        // Detect LLM format errors: JSON parse failure or tool not found
        const isFormatError: boolean =
          !!(tc as { _formatError?: boolean })._formatError ||
          !!(
            result?.isError &&
            typeof result.content === "string" &&
            result.content.includes("not found")
          );
        // Detect rate-limit blocks from our dedup/limit guards
        const rateLimited: boolean = !!(
          result?.isError &&
          typeof result.content === "string" &&
          (result.content.includes("limit") ||
            result.content.includes("already called") ||
            result.content.includes("Global tool call"))
        );
        return {
          toolCall: tc,
          effectiveToolName,
          effectiveToolInput,
          result,
          toolDurationMs,
          blockedByPolicy,
          isFormatError,
          rateLimited,
        };
      };

      // Split tool calls into batches: consecutive pure tools → parallel, impure → barrier
      type ToolBatch = { parallel: boolean; calls: typeof toolCalls };
      const batches: ToolBatch[] = [];
      let pureBatch: typeof toolCalls = [];

      for (const tc of toolCalls) {
        const toolDef = this.toolRegistry.get(tc.name);
        if (toolDef?.pure) {
          pureBatch.push(tc);
        } else {
          if (pureBatch.length > 0) {
            batches.push({ parallel: true, calls: pureBatch });
            pureBatch = [];
          }
          batches.push({ parallel: false, calls: [tc] });
        }
      }
      if (pureBatch.length > 0) {
        batches.push({ parallel: true, calls: pureBatch });
      }

      // Execute batches
      let earlyReturn = false;
      const allExecResults: ToolExecResult[] = [];
      for (const batch of batches) {
        if (this.aborted || earlyReturn) break;

        // Emit tool_call events for all tools in this batch
        for (const tc of batch.calls) {
          const eventData: Record<string, unknown> = {
            name: tc.name,
            input: tc.input,
          };
          if ((tc as { intent?: string }).intent) {
            eventData.intent = (tc as { intent?: string }).intent;
          }
          yield this.createEvent("tool_call", eventData);
          trace.steps.push({
            type: "tool_call",
            name: tc.name,
            input: tc.input,
            ...((tc as { intent?: string }).intent
              ? { intent: (tc as { intent?: string }).intent }
              : {}),
          } as TraceStep);
        }

        // Execute: parallel for pure batches (>1), sequential otherwise
        let execResults: ToolExecResult[];
        if (batch.parallel && batch.calls.length > 1) {
          console.log(
            `[agent-loop] Executing ${batch.calls.length} pure tools in parallel: ${batch.calls.map((t) => t.name).join(", ")}`,
          );
          execResults = await Promise.all(
            batch.calls.map((tc) => executeOne(tc)),
          );
        } else {
          execResults = [await executeOne(batch.calls[0])];
        }

        allExecResults.push(...execResults);

        // Process results sequentially (yield events, store turns, handle handoff)
        for (const r of execResults) {
          // Update per-tool failure tracking
          if (!r.blockedByPolicy) {
            const failKey = buildFailKey(
              r.effectiveToolName,
              r.effectiveToolInput,
            );
            if (r.result.isError) {
              toolFailCounts.set(
                failKey,
                (toolFailCounts.get(failKey) ?? 0) + 1,
              );
            } else {
              toolFailCounts.delete(failKey);
            }
          }

          if (r.result.autoComplete) hasAutoComplete = true;
          if (r.effectiveToolName === "update_todo") {
            // Capture todo items for auto-progress
            const todoMatch = r.result.content.matchAll(
              /^[-*]\s*\[([ xX])\]\s*(.+)/gm,
            );
            const parsed = [...todoMatch].map((m) => ({
              text: m[2].trim(),
              done: m[1] !== " ",
            }));
            if (parsed.length > 0) {
              todoItems = parsed;
              todoAutoIndex = parsed.filter((i) => i.done).length;
            }
          }

          // Handoff: signal orchestrator to switch agent
          if (r.result.handoffTo) {
            yield this.createEvent("tool_result", {
              name: r.toolCall.name,
              result: r.result,
              durationMs: r.toolDurationMs,
            });
            trace.steps.push({
              type: "tool_result",
              name: r.toolCall.name,
              content: envMap ? obfuscateString(r.result.content, envMap) : r.result.content,
              durationMs: r.toolDurationMs,
            } as TraceStep);
            const handoffToolResult: ToolResultContent = {
              type: "tool_result",
              toolUseId: r.toolCall.id,
              content: r.result.content,
              isError: false,
            };
            await this.memoryStore.addTurn(convId, {
              id: generateId(),
              conversationId: convId,
              role: "tool",
              content: JSON.stringify([handoffToolResult]),
              toolResults: JSON.stringify([
                {
                  toolUseId: r.toolCall.id,
                  ...r.result,
                  durationMs: r.toolDurationMs,
                },
              ]),
              createdAt: new Date(),
            });
            const hDuration = Date.now() - startTime;
            trace.model = usedModel;
            trace.tokensIn = totalTokensIn;
            trace.tokensOut = totalTokensOut;
            trace.durationMs = hDuration;
            try {
              await this.memoryStore.addTrace(trace);
            } catch (e) {
              console.error("[agent-loop] Failed to persist trace:", e);
            }
            yield this.createEvent("handoff", {
              targetAgentId: r.result.handoffTo,
              reason: r.result.content,
              tokensIn: totalTokensIn,
              tokensOut: totalTokensOut,
              toolCallCount: totalToolCalls,
              durationMs: hDuration,
              model: usedModel,
            });
            this.setState("idle");
            return;
          }

          yield this.createEvent("tool_result", {
            name: r.toolCall.name,
            result: r.result,
            durationMs: r.toolDurationMs,
          });

          trace.steps.push({
            type: "tool_result",
            name: r.toolCall.name,
            content: envMap ? obfuscateString(r.result.content, envMap) : r.result.content,
            isError: r.result.isError,
            durationMs: r.toolDurationMs,
          } as TraceStep);

          // Sanitize tool output to remove lone surrogates that break JSON/API calls
          r.result.content = sanitizeString(r.result.content);

          const toolResultContent: ToolResultContent = {
            type: "tool_result",
            toolUseId: r.toolCall.id,
            content: r.result.content,
            isError: r.result.isError,
          };

          const toolTurn: ConversationTurn = {
            id: generateId(),
            conversationId: convId,
            role: "tool",
            content: JSON.stringify([toolResultContent]),
            toolResults: JSON.stringify([
              {
                toolUseId: r.toolCall.id,
                ...r.result,
                durationMs: r.toolDurationMs,
              },
            ]),
            createdAt: new Date(),
          };
          await this.memoryStore.addTurn(convId, toolTurn);

          if (r.result.isError) iterationErrorCount++;
        }
      }

      // Rollback: if ALL errors this iteration are format errors (JSON parse / tool not found),
      // delete the assistant + tool result turns and retry without wasting an iteration.
      if (
        iterationErrorCount > 0 &&
        iterationErrorCount === toolCalls.length &&
        !earlyReturn &&
        !this.aborted
      ) {
        const allFormatErrors =
          allExecResults.length > 0 &&
          allExecResults.every((r) => r.isFormatError);

        if (
          allFormatErrors &&
          consecutiveRollbacks < MAX_CONSECUTIVE_ROLLBACKS
        ) {
          console.log(
            `[agent-loop] Format error rollback (${consecutiveRollbacks + 1}/${MAX_CONSECUTIVE_ROLLBACKS}): deleting assistant + tool turns, retrying`,
          );
          // Delete assistant turn and all subsequent tool result turns from DB
          if (this.memoryStore.deleteTurnsFrom) {
            await this.memoryStore.deleteTurnsFrom(
              convId,
              assistantTurnCreatedAt.toISOString(),
            );
          }
          // Don't count this iteration
          iterations--;
          this.iterationBudget?.unconsume();
          consecutiveRollbacks++;
          continue;
        }
      }

      // Reset rollback counter on successful iteration (at least one non-error)
      if (iterationErrorCount < toolCalls.length) {
        consecutiveRollbacks = 0;
      }

      // ── Three-strike escalation: detect stuck LLM ──
      // Fingerprint: first 300 chars of LLM output + tool names called (normalized)
      if (fullText && !escalated) {
        const toolNames = toolCalls
          .map((tc) => tc.name)
          .sort()
          .join(",");
        const fp =
          fullText.replace(/\s+/g, " ").slice(0, 300) + "|" + toolNames;
        recentFingerprints.push(fp);
        // Keep only last STRIKE_THRESHOLD entries
        if (recentFingerprints.length > STRIKE_THRESHOLD) {
          recentFingerprints.shift();
        }
        // Check if all recent fingerprints are similar (>80% char overlap)
        if (recentFingerprints.length === STRIKE_THRESHOLD) {
          const base = recentFingerprints[0];
          const allSimilar = recentFingerprints.every((f) => {
            const minLen = Math.min(f.length, base.length);
            if (minLen === 0) return true;
            let matches = 0;
            for (let ci = 0; ci < minLen; ci++) {
              if (f[ci] === base[ci]) matches++;
            }
            return matches / minLen > 0.8;
          });
          if (allSimilar) {
            escalated = true;
            runtimeHints.push(
              "<escalation>You appear to be stuck in a loop — your last 3 responses were very similar. " +
                "STOP repeating the same approach. Try a completely different strategy: " +
                "use different tools, change parameters, or explain to the user what's blocking you.</escalation>",
            );
            console.warn(
              `[agent-loop] Three-strike escalation triggered at iteration ${iterations}`,
            );
          }
        }
      }

      // ── execute_code nudge: detect sequential web_search/web_fetch abuse ──
      // System prompt says "≥3 tool calls chain → use execute_code", but weak
      // models ignore this. After 3+ fetch/search calls, inject a one-time hint.
      if (!executeCodeNudged && loopAvailableTools.has("execute_code")) {
        if (toolNameCounts.has("execute_code")) usedExecuteCode = true;
        if (!usedExecuteCode) {
          const fetchSearchTotal =
            (toolNameCounts.get("web_search") ?? 0) +
            (toolNameCounts.get("web_fetch") ?? 0);
          if (fetchSearchTotal >= FETCH_SEARCH_NUDGE_THRESHOLD) {
            executeCodeNudged = true;
            runtimeHints.push(
              "<execute_code_hint>你已经逐个调用了 " +
                fetchSearchTotal +
                " 次 web_search/web_fetch。系统规则要求：多步链式操作（搜索→读取→汇总，≥3 次工具调用）必须用 execute_code 写 JS 脚本一次完成。" +
                "请立即改用 execute_code，用 fetch() 并行抓取多个 URL，在脚本内完成数据提取和汇总，然后直接输出最终结果。</execute_code_hint>",
            );
            console.warn(
              `[agent-loop] execute_code nudge triggered: ${fetchSearchTotal} fetch/search calls without execute_code`,
            );
          }
        }
      }

      // Drain sentFiles from context into accumulator (dedup by URL)
      if (context?.sentFiles && context.sentFiles.length > 0) {
        for (const f of context.sentFiles) {
          if (!allSentFiles.some((e) => e.url === f.url)) {
            allSentFiles.push(f);
          }
        }
        context.sentFiles.length = 0;
      }

      // Auto-progress: advance todo by one item per iteration (not per tool call).
      // One iteration ≈ one logical step, regardless of how many tools were called.
      if (
        todoItems.length > 0 &&
        todoAutoIndex < todoItems.length &&
        allExecResults.some((r) => {
          if (r.result.isError || r.effectiveToolName === "update_todo") return false;
          if (r.effectiveToolName === "use_skill") {
            if (firstUseSkillCounted) return false; // Only the first use_skill counts
            firstUseSkillCounted = true;
          }
          return true;
        })
      ) {
        todoItems[todoAutoIndex].done = true;
        todoAutoIndex++;
        if (context?.todoNotify) {
          context.todoNotify([...todoItems]);
        }
      }

      // Auto-complete: skip further LLM calls only when ALL tools in this
      // iteration are auto-send type. If any other tool ran (web_search, bash
      // without auto_send, etc.), the LLM likely has more work to do.
      const allToolsAreAutoSend =
        hasAutoComplete &&
        allExecResults.every(
          (r) =>
            r.result.autoComplete ||
            r.effectiveToolName === "send_file" ||
            r.effectiveToolName === "update_todo",
        );
      const todoComplete = todoItems.length === 0 || todoAutoIndex >= todoItems.length;
      if (allToolsAreAutoSend && iterationErrorCount === 0 && todoComplete) {
        const durationMs = Date.now() - startTime;

        // Build response from sent files
        const filesMd = allSentFiles
          .map((f) => {
            const isImage = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(f.filename);
            return isImage
              ? `![${f.filename}](${f.url})`
              : `[${f.filename}](${f.url})`;
          })
          .join("\n");
        const responseText = filesMd || "Done.";

        // Store assistant turn
        const autoTurn: ConversationTurn = {
          id: generateId(),
          conversationId: convId,
          role: "assistant",
          content: responseText,
          model: usedModel,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          cacheCreationTokens: totalCacheCreationTokens || undefined,
          cacheReadTokens: totalCacheReadTokens || undefined,
          durationMs,
          toolCallCount: totalToolCalls,
          traceId: trace.id,
          createdAt: new Date(),
        };
        await this.memoryStore.addTurn(convId, autoTurn);

        // Persist trace
        trace.response = responseText;
        trace.model = usedModel;
        trace.tokensIn = totalTokensIn;
        trace.tokensOut = totalTokensOut;
        trace.cacheCreationTokens = totalCacheCreationTokens || undefined;
        trace.cacheReadTokens = totalCacheReadTokens || undefined;
        trace.durationMs = durationMs;
        try {
          await this.memoryStore.addTrace(trace);
        } catch (e) {
          console.error("[agent-loop] Failed to persist trace:", e);
        }

        this.setState("idle");
        const message: Message = {
          id: generateId(),
          role: "assistant",
          content: responseText,
          createdAt: new Date(),
          model: usedModel,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          cacheCreationTokens: totalCacheCreationTokens || undefined,
          cacheReadTokens: totalCacheReadTokens || undefined,
          durationMs,
          toolCallCount: totalToolCalls,
        };
        yield this.createEvent("response_complete", { message });
        return;
      }

      // Track consecutive all-error iterations to avoid endless thrashing
      if (iterationErrorCount === toolCalls.length) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.log(
            `[agent-loop] ${consecutiveErrors} consecutive all-error iterations, stopping early.`,
          );
          break;
        }
      } else {
        consecutiveErrors = 0;
      }

      // Rate-limit pressure: when most tool calls in this iteration were blocked
      // by our guards, inject a hint forcing the model to output instead of
      // wasting another ~90s LLM call trying more tools.
      const rateLimitedCount = allExecResults.filter(
        (r) => r.rateLimited,
      ).length;
      if (rateLimitedCount > 0 && rateLimitedCount >= toolCalls.length / 2) {
        runtimeHints.push(
          "[SYSTEM] Most of your tool calls were blocked because you have exceeded usage limits. " +
            "You MUST respond to the user NOW using the information you have already gathered. " +
            "Do NOT call any more tools. Synthesize your answer immediately.",
        );
      }

      // use_skill is just loading instructions — don't count against iteration budget
      if (
        toolCalls.every((tc) => tc.name === "use_skill") &&
        useSkillRollbacks < 3
      ) {
        iterations--;
        this.iterationBudget?.unconsume();
        useSkillRollbacks++;
      }

      // Loop back for next LLM call with tool results
    }

    // Loop exited — either max iterations, budget exhausted, or user abort
    const durationMs = Date.now() - startTime;
    const wasAborted = this.aborted;

    // Persist trace
    trace.model = usedModel;
    trace.tokensIn = totalTokensIn;
    trace.tokensOut = totalTokensOut;
    trace.durationMs = durationMs;
    trace.error = wasAborted ? "user_aborted" : "max_iterations_reached";
    try {
      await this.memoryStore.addTrace(trace);
      tracePersistedInLoop = true;
    } catch (e) {
      console.error("[agent-loop] Failed to persist trace:", e);
    }

    // Store a final assistant turn with cumulative usage stats.
    // For abort: empty content. For max iterations: generate failure summary via LLM.
    let fallbackContent = "";
    if (!wasAborted) {
      // Try to generate a structured failure summary
      try {
        const toolSummary = trace.steps
          .filter(
            (s) =>
              s.type === "tool_call" ||
              (s.type === "tool_result" &&
                (s as Record<string, unknown>).isError),
          )
          .slice(-10) // Last 10 entries for context
          .map((s) => {
            if (s.type === "tool_call")
              return `→ ${(s as Record<string, unknown>).name}`;
            return `  ✗ error`;
          })
          .join("\n");
        let summaryText = "";
        for await (const chunk of this.provider.stream({
          messages: [
            {
              id: generateId(),
              role: "user",
              content: `The agent ran for ${iterations} iterations and reached the limit. Last activity:\n${toolSummary}\n\nLast response:\n${(lastFullText || "").slice(0, 500)}\n\nWrite a 2-3 sentence summary: what was accomplished, what remains, and suggest next steps. Be concise. Reply in the same language as the last response.`,
              createdAt: new Date(),
            },
          ],
          model: usedModel,
          maxTokens: 256,
          temperature: 0,
        })) {
          if (chunk.type === "text") summaryText += chunk.text;
        }
        fallbackContent = summaryText || MAX_ITERATIONS_MESSAGE;
      } catch (e) {
        console.error("[agent-loop] Failure summary generation failed:", e);
        fallbackContent = lastFullText || MAX_ITERATIONS_MESSAGE;
      }
    }
    const fallbackTurn: ConversationTurn = {
      id: generateId(),
      conversationId: convId,
      role: "assistant",
      content: fallbackContent,
      model: usedModel,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      cacheCreationTokens: totalCacheCreationTokens || undefined,
      cacheReadTokens: totalCacheReadTokens || undefined,
      durationMs,
      toolCallCount: totalToolCalls,
      traceId: trace.id,
      createdAt: new Date(),
    };
    await this.memoryStore.addTurn(convId, fallbackTurn);

    this.setState("idle");
    const message: Message = {
      id: generateId(),
      role: "assistant",
      content: fallbackContent,
      createdAt: new Date(),
      model: usedModel,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      cacheCreationTokens: totalCacheCreationTokens || undefined,
      cacheReadTokens: totalCacheReadTokens || undefined,
      durationMs,
      toolCallCount: totalToolCalls,
    };
    yield this.createEvent("response_complete", { message });

    } finally {
      // Guarantee trace is saved even if the generator is aborted mid-flight
      // (e.g., user clicks stop, WebSocket disconnects, consumer stops pulling).
      // Without this, generator return() skips all code after the yield point.
      if (!tracePersistedInLoop) {
        trace.model = usedModel;
        trace.tokensIn = totalTokensIn;
        trace.tokensOut = totalTokensOut;
        trace.durationMs = Date.now() - startTime;
        trace.error = "generator_aborted";
        try {
          await this.memoryStore.addTrace(trace);
          console.log(
            `[agent-loop] Trace ${trace.id} saved on generator abort (${trace.steps.length} steps)`,
          );
        } catch (e) {
          console.error("[agent-loop] Failed to persist trace on abort:", e);
        }
        this.setState("idle");
      }
    }
  }

  stop(): void {
    this.aborted = true;
    this.abortController?.abort();
    this.setState("idle");
  }

  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: AgentState): void {
    this._state = state;
    this.emit("state_change", { state });
  }

  private emit(type: AgentEventType, data: unknown): void {
    const event = this.createEvent(type, data);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private createEvent(type: AgentEventType, data: unknown): AgentEvent {
    return { type, data, timestamp: new Date() };
  }
}
