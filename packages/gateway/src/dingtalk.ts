import { DWClient, TOPIC_ROBOT, EventAck } from "dingtalk-stream-sdk-nodejs";
import type { DWClientDownStream } from "dingtalk-stream-sdk-nodejs";
import type { AppContext } from "./bootstrap.js";
import type { ToolExecutionContext } from "@agentclaw/types";
import { PLATFORM_HINTS } from "./platform-hints.js";
import {
  createPromptUser,
  createLinkSendFile,
  processSimpleEventLoop,
  restoreChatTargets,
} from "./channel-utils.js";

/** Map DingTalk conversationId → AgentClaw session ID */
const chatSessionMap = new Map<string, string>();

/** Extra info needed for broadcast via OpenAPI */
interface ChatInfo {
  conversationType: string; // '1' = 单聊, '2' = 群聊
  senderStaffId: string;
  robotCode: string;
}
const chatInfoMap = new Map<string, ChatInfo>();

/** Pending ask_user prompts: conversationId → resolve */
const pendingPrompts = new Map<string, (answer: string) => void>();

/** Reply to a DingTalk message via sessionWebhook */
async function replyText(sessionWebhook: string, text: string): Promise<void> {
  await fetch(sessionWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "text",
      text: { content: text },
    }),
  });
}

/** DingTalk OpenAPI base URL */
const DINGTALK_API = "https://api.dingtalk.com/v1.0";

export interface DingTalkConfig {
  clientId: string;
  clientSecret: string;
  /** Comma-separated staffId whitelist. If empty, ALL users are blocked. */
  allowedUsers?: string;
}

/**
 * Start a DingTalk bot using Stream mode (no public IP required).
 * Returns stop/broadcast handles for integration with the gateway lifecycle.
 */
export async function startDingTalkBot(
  config: DingTalkConfig,
  appCtx: AppContext,
): Promise<{ stop: () => void; broadcast: (text: string) => Promise<void> }> {
  // User whitelist — if not configured, block everyone (safe by default)
  const allowedUsers = new Set(
    (config.allowedUsers ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (allowedUsers.size === 0) {
    console.warn(
      "[dingtalk] WARNING: DINGTALK_ALLOWED_USERS is empty — all messages will be rejected. Set it to a comma-separated list of staffId values.",
    );
  } else {
    console.log(
      `[dingtalk] User whitelist: ${allowedUsers.size} user(s) allowed`,
    );
  }

  const client = new DWClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });

  // Restore chat targets from database
  restoreChatTargets("dingtalk", appCtx, chatSessionMap);

  // Register robot message callback
  client.registerCallbackListener(
    TOPIC_ROBOT,
    async (res: DWClientDownStream) => {
      const msg = JSON.parse(res.data) as {
        conversationId: string;
        conversationType: string;
        senderStaffId: string;
        senderNick: string;
        sessionWebhook: string;
        robotCode: string;
        msgtype: string;
        text?: { content: string };
        msgId: string;
      };

      const {
        conversationId,
        conversationType,
        senderStaffId,
        sessionWebhook,
        robotCode,
        msgtype,
        text,
      } = msg;

      // Whitelist check — reject unauthorized users
      if (!senderStaffId || !allowedUsers.has(senderStaffId)) {
        console.log(
          `[dingtalk] Blocked message from unauthorized user: ${senderStaffId} (${msg.senderNick})`,
        );
        await replyText(
          sessionWebhook,
          "Access denied. This bot is restricted to authorized users only.",
        );
        client.send(res.headers.messageId, { status: EventAck.SUCCESS });
        return;
      }

      // Store chat info for broadcast
      chatInfoMap.set(conversationId, {
        conversationType,
        senderStaffId,
        robotCode,
      });

      // Extract user text
      let userText: string;
      if (msgtype === "text" && text) {
        userText = text.content.trim();
      } else {
        userText = `[收到非文本消息，类型: ${msgtype}]`;
      }

      // Check for pending ask_user prompt
      const pendingResolve = pendingPrompts.get(conversationId);
      if (pendingResolve) {
        pendingPrompts.delete(conversationId);
        pendingResolve(userText);
        client.send(res.headers.messageId, { status: EventAck.SUCCESS });
        return;
      }

      // Get or create session
      let sessionId = chatSessionMap.get(conversationId);
      if (!sessionId) {
        try {
          const session = await appCtx.orchestrator.createSession({
            platformHint: PLATFORM_HINTS.dingtalk,
            channel: "dingtalk",
          });
          sessionId = session.id;
          chatSessionMap.set(conversationId, sessionId);
          appCtx.memoryStore.saveChatTarget(
            "dingtalk",
            conversationId,
            sessionId,
          );
        } catch (err) {
          console.error("[dingtalk] Failed to create session:", err);
          await replyText(sessionWebhook, "Failed to start session.");
          client.send(res.headers.messageId, { status: EventAck.SUCCESS });
          return;
        }
      }

      // Process message through orchestrator
      const sentFiles: Array<{ url: string; filename: string }> = [];
      const replyFn = (text: string) => replyText(sessionWebhook, text);
      const toolContext: ToolExecutionContext = {
        sentFiles,
        promptUser: createPromptUser(conversationId, pendingPrompts, replyFn),
        notifyUser: async (message: string) => {
          await replyText(sessionWebhook, message);
        },
        sendFile: createLinkSendFile(sentFiles, replyFn),
      };

      const eventStream = appCtx.orchestrator.processInputStream(
        sessionId,
        userText,
        toolContext,
      );

      await processSimpleEventLoop({
        channelTag: "dingtalk",
        sessionId,
        chatKey: conversationId,
        sendReply: replyFn,
        maxMessageLength: 5000,
        eventStream,
        onSessionExpired: () => chatSessionMap.delete(conversationId),
      });

      // Acknowledge message receipt
      client.send(res.headers.messageId, { status: EventAck.SUCCESS });
    },
  );

  await client.connect();
  console.log("[dingtalk] Bot connected via Stream mode");

  return {
    stop: () => {
      try {
        client.disconnect();
      } catch {}
    },
    broadcast: async (text: string) => {
      const accessToken = (
        client as unknown as { config: { access_token?: string } }
      ).config.access_token;
      if (!accessToken) {
        console.warn("[dingtalk] No access token for broadcast");
        return;
      }

      for (const [convId, info] of chatInfoMap) {
        try {
          if (info.conversationType === "2") {
            // Group message
            await fetch(`${DINGTALK_API}/robot/groupMessages/send`, {
              method: "POST",
              headers: {
                "x-acs-dingtalk-access-token": accessToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                robotCode: info.robotCode,
                openConversationId: convId,
                msgKey: "sampleText",
                msgParam: JSON.stringify({ content: text }),
              }),
            });
          } else {
            // 1:1 message
            await fetch(`${DINGTALK_API}/robot/oToMessages/batchSend`, {
              method: "POST",
              headers: {
                "x-acs-dingtalk-access-token": accessToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                robotCode: info.robotCode,
                userIds: [info.senderStaffId],
                msgKey: "sampleText",
                msgParam: JSON.stringify({ content: text }),
              }),
            });
          }
        } catch (err) {
          console.error(`[dingtalk] Failed to broadcast to ${convId}:`, err);
        }
      }
    },
  };
}
