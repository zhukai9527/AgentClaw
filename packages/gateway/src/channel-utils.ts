/**
 * channel-utils.ts — IM 渠道公共逻辑
 *
 * 将 5 个渠道文件（telegram/qqbot/dingtalk/feishu/wecom）中重复的公共模式抽取到此处，
 * 减少代码重复，保持行为一致性。
 */

import * as Sentry from "@sentry/node";
import type { Message, ToolExecutionContext } from "@agentclaw/types";
import type { AppContext } from "./bootstrap.js";
import {
  extractText,
  stripFileMarkdown,
  splitMessage,
  broadcastSessionActivity,
} from "./utils.js";

// ── 1. PUBLIC_URL 构建 ──────────────────────────────────────────────

/**
 * 获取公开访问的 host URL（含协议和端口）。
 * 优先使用 PUBLIC_URL 环境变量，否则回退到 localhost + PORT。
 */
export function getPublicUrl(): string {
  const port = process.env.PORT || "3100";
  return process.env.PUBLIC_URL || `http://localhost:${port}`;
}

/**
 * 根据文件名构建对外可访问的文件 URL 路径。
 * @returns 例如 `/files/report.pdf`
 */
export function buildFileUrl(filename: string): string {
  return `/files/${encodeURIComponent(filename)}`;
}

// ── 2. promptUser 超时逻辑 ──────────────────────────────────────────

/** 5 分钟超时（毫秒） */
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 创建一个带 5 分钟超时的 promptUser 实现。
 *
 * @param chatKey 用于在 pendingPrompts Map 中定位的 key
 * @param pendingPrompts 渠道的 pending prompts Map
 * @param sendQuestion 发送问题文本给用户的函数
 * @returns 符合 ToolExecutionContext.promptUser 签名的函数
 */
export function createPromptUser(
  chatKey: string | number,
  pendingPrompts: Map<string | number, (answer: string) => void>,
  sendQuestion: (text: string) => Promise<unknown>,
): ToolExecutionContext["promptUser"] {
  return async (question: string) => {
    await sendQuestion(`❓ ${question}`);
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        pendingPrompts.delete(chatKey);
        resolve("[用户未在 5 分钟内回答]");
      }, PROMPT_TIMEOUT_MS);
      pendingPrompts.set(chatKey, (answer: string) => {
        clearTimeout(timer);
        resolve(answer);
      });
    });
  };
}

// ── 3. 链接式 sendFile ──────────────────────────────────────────────

/**
 * 创建一个通过发送下载链接的 sendFile 实现。
 * 适用于 QQ/钉钉/飞书/企微等不支持直接上传文件的渠道。
 *
 * @param sentFiles 用于跟踪已发送文件的数组（会被 push）
 * @param sendLink 发送链接文本给用户的函数
 * @returns 符合 ToolExecutionContext.sendFile 签名的函数
 */
export function createLinkSendFile(
  sentFiles: Array<{ url: string; filename: string }>,
  sendLink: (text: string) => Promise<unknown>,
): NonNullable<ToolExecutionContext["sendFile"]> {
  return async (filePath: string, caption?: string) => {
    const { basename } = await import("node:path");
    const filename = basename(filePath);
    const url = buildFileUrl(filename);
    sentFiles.push({ url, filename });
    const host = getPublicUrl();
    await sendLink(`📎 ${caption || filename}\n${host}${url}`);
  };
}

// ── 4. 简单事件流处理（非流式渠道） ─────────────────────────────────

/**
 * 简单事件流处理器的配置。
 * 适用于 QQ/钉钉/飞书等不支持实时流式推送的渠道。
 */
export interface SimpleEventLoopOptions {
  /** 渠道名称标签（用于日志），如 "qqbot"、"dingtalk" */
  channelTag: string;
  /** AgentClaw session ID */
  sessionId: string;
  /** 用于标识渠道的 chat key（用于清理 session map） */
  chatKey: string;
  /** 发送消息给用户 */
  sendReply: (text: string) => Promise<unknown>;
  /** 拆分消息的最大长度（各渠道不同） */
  maxMessageLength?: number;
  /** 事件流（来自 orchestrator.processInputStream） */
  eventStream: AsyncIterable<{ type: string; data: unknown }>;
  /** 当 session 过期时的清理回调 */
  onSessionExpired?: () => void;
}

/**
 * 处理来自 orchestrator 的事件流，积累文本并最终发送。
 * 这是 QQ/钉钉/飞书共用的简单模式：
 * - tool_call：只发送一次状态提示
 * - response_chunk：累积文本
 * - response_complete：如果没有累积文本，从 message 中提取
 * - 最终：stripFileMarkdown → splitMessage → 逐条发送
 *
 * @returns 累积的原始文本（供调用方做 TTS 等后处理）
 */
export async function processSimpleEventLoop(
  opts: SimpleEventLoopOptions,
): Promise<string> {
  const {
    channelTag,
    sessionId,
    chatKey,
    sendReply,
    maxMessageLength = 4096,
    eventStream,
    onSessionExpired,
  } = opts;

  try {
    let accumulatedText = "";
    let statusSent = false;

    for await (const event of eventStream) {
      if (event.type === "tool_call" && !statusSent) {
        const name = (event.data as { name: string }).name;
        sendReply(`⚙️ ${name}...`).catch(() => {});
        statusSent = true;
      } else if (event.type === "response_chunk") {
        accumulatedText += (event.data as { text: string }).text;
      } else if (event.type === "response_complete" && !accumulatedText) {
        accumulatedText = extractText(
          (event.data as { message: Message }).message.content,
        );
      }
    }

    accumulatedText = stripFileMarkdown(accumulatedText);
    if (!accumulatedText.trim()) {
      accumulatedText = "(empty response)";
    }

    for (const chunk of splitMessage(accumulatedText, maxMessageLength)) {
      await sendReply(chunk);
    }

    broadcastSessionActivity(sessionId, channelTag);
    return accumulatedText;
  } catch (err) {
    Sentry.captureException(err);
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[${channelTag}] Error processing message:`, errMsg);
    if (errMsg.includes("Session not found")) {
      onSessionExpired?.();
      await sendReply("⚠️ 会话已过期，请重新发送消息。");
    } else {
      await sendReply(`❌ Error: ${errMsg.slice(0, 200)}`);
    }
    return "";
  }
}

// ── 5. 恢复 chat targets ────────────────────────────────────────────

/**
 * 从数据库恢复渠道的 chat target 映射。
 *
 * @param channelTag 渠道标签（如 "telegram"、"qqbot"）
 * @param appCtx 应用上下文
 * @param chatSessionMap 渠道的 chatKey → sessionId 映射
 */
export function restoreChatTargets<K extends string | number>(
  channelTag: string,
  appCtx: AppContext,
  chatSessionMap: Map<K, string>,
  keyTransform?: (targetId: string) => K,
): void {
  try {
    const targets = appCtx.memoryStore.getChatTargets(channelTag);
    for (const t of targets) {
      const key = keyTransform
        ? keyTransform(t.targetId)
        : (t.targetId as K);
      chatSessionMap.set(key, t.sessionId ?? "");
    }
    if (targets.length > 0) {
      console.log(
        `[${channelTag}] Restored ${targets.length} chat target(s) from database`,
      );
    }
  } catch (err) {
    console.error(`[${channelTag}] Failed to restore chat targets:`, err);
  }
}
