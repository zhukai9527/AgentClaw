import type { AppContext } from "./bootstrap.js";
import { loadConfig, type AppConfig } from "./config.js";
import { startTelegramBot } from "./telegram.js";
import { startWhatsAppBot } from "./whatsapp.js";
import { startDingTalkBot } from "./dingtalk.js";
import { startFeishuBot } from "./feishu.js";
import { startQQBot } from "./qqbot.js";
import { startWeComBot } from "./wecom.js";

export interface ChannelInfo {
  id: string;
  name: string;
  status: "connected" | "disconnected" | "error" | "not_configured";
  statusMessage?: string;
  connectedAt?: string;
  botIdentity?: string;
}

interface BotHandle {
  stop: () => void;
  broadcast: (text: string) => Promise<void>;
}

interface ChannelState {
  id: string;
  name: string;
  configured: boolean;
  handle?: BotHandle;
  connectedAt?: Date;
  statusMessage?: string;
  error?: string;
}

/** 从 config 判断渠道是否已配置（config.json 优先，env 兜底） */
function isChannelConfigured(cfg: AppConfig, id: string): boolean {
  switch (id) {
    case "telegram":
      return !!(cfg.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN);
    case "whatsapp":
      return !!(
        cfg.whatsapp?.enabled || process.env.WHATSAPP_ENABLED === "true"
      );
    case "dingtalk":
      return !!(
        (cfg.dingtalk?.appKey && cfg.dingtalk?.appSecret) ||
        (process.env.DINGTALK_APP_KEY && process.env.DINGTALK_APP_SECRET)
      );
    case "feishu":
      return !!(
        (cfg.feishu?.appId && cfg.feishu?.appSecret) ||
        (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET)
      );
    case "qqbot":
      return !!(
        (cfg.qqBot?.appId && cfg.qqBot?.appSecret) ||
        (process.env.QQ_BOT_APP_ID && process.env.QQ_BOT_APP_SECRET)
      );
    case "wecom":
      return !!(
        (cfg.wecom?.botId && cfg.wecom?.botSecret) ||
        (process.env.WECOM_BOT_ID && process.env.WECOM_BOT_SECRET)
      );
    case "email":
      return !!(
        (cfg.email?.user && cfg.email?.password) ||
        (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD)
      );
    default:
      return false;
  }
}

export class ChannelManager {
  private channels = new Map<string, ChannelState>();
  private ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    const cfg = loadConfig();

    // 注册所有已知渠道
    this.channels.set("telegram", {
      id: "telegram",
      name: "Telegram",
      configured: isChannelConfigured(cfg, "telegram"),
    });
    this.channels.set("whatsapp", {
      id: "whatsapp",
      name: "WhatsApp",
      configured: isChannelConfigured(cfg, "whatsapp"),
    });
    this.channels.set("dingtalk", {
      id: "dingtalk",
      name: "DingTalk",
      configured: isChannelConfigured(cfg, "dingtalk"),
    });
    this.channels.set("feishu", {
      id: "feishu",
      name: "Feishu",
      configured: isChannelConfigured(cfg, "feishu"),
    });
    this.channels.set("qqbot", {
      id: "qqbot",
      name: "QQ Bot",
      configured: isChannelConfigured(cfg, "qqbot"),
    });
    this.channels.set("wecom", {
      id: "wecom",
      name: "WeCom",
      configured: isChannelConfigured(cfg, "wecom"),
    });
    this.channels.set("email", {
      id: "email",
      name: "Email",
      configured: isChannelConfigured(cfg, "email"),
    });
    this.channels.set("websocket", {
      id: "websocket",
      name: "WebSocket",
      configured: true,
      connectedAt: new Date(),
    });
  }

  list(): ChannelInfo[] {
    return Array.from(this.channels.values(), (ch) => this.toInfo(ch));
  }

  getInfo(id: string): ChannelInfo | undefined {
    const ch = this.channels.get(id);
    return ch ? this.toInfo(ch) : undefined;
  }

  async start(id: string): Promise<void> {
    const ch = this.channels.get(id);
    if (!ch) throw new Error(`Unknown channel: ${id}`);
    if (!ch.configured) throw new Error(`Channel ${id} is not configured`);
    if (ch.handle) throw new Error(`Channel ${id} is already running`);

    if (id === "websocket" || id === "email") {
      // WebSocket 始终由 Fastify 管理；Email 是被动凭证，不需要启动进程
      ch.connectedAt = new Date();
      return;
    }

    try {
      ch.handle = await this.startBot(id);
      ch.connectedAt = new Date();
      ch.error = undefined;
      console.log(`[channel-manager] Started ${ch.name}`);
    } catch (err) {
      ch.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async stop(id: string): Promise<void> {
    const ch = this.channels.get(id);
    if (!ch) throw new Error(`Unknown channel: ${id}`);
    if (id === "websocket" || id === "email")
      throw new Error(`Cannot stop ${id} channel`);
    if (!ch.handle) return;

    try {
      ch.handle.stop();
    } catch {}
    ch.handle = undefined;
    ch.connectedAt = undefined;
    console.log(`[channel-manager] Stopped ${ch.name}`);
  }

  /** Start all configured channels */
  async startAll(): Promise<void> {
    for (const [id, ch] of this.channels) {
      if (ch.configured && id !== "websocket" && !ch.handle) {
        try {
          await this.start(id);
        } catch (err) {
          console.error(`[channel-manager] Failed to start ${ch.name}:`, err);
        }
      }
    }
  }

  /** Stop all channels */
  stopAll(): void {
    for (const [id, ch] of this.channels) {
      if (ch.handle && id !== "websocket") {
        try {
          ch.handle.stop();
        } catch {}
        ch.handle = undefined;
        ch.connectedAt = undefined;
      }
    }
  }

  /** Broadcast to all connected channels */
  async broadcast(text: string): Promise<void> {
    for (const ch of this.channels.values()) {
      if (ch.handle) {
        await ch.handle
          .broadcast(text)
          .catch((err) => console.error(`[broadcast] ${ch.name} failed:`, err));
      }
    }
  }

  /** 重新加载配置并重启变更的渠道 */
  async refreshConfig(): Promise<void> {
    const cfg = loadConfig();
    for (const [id, ch] of this.channels) {
      if (id === "websocket") continue;
      const nowConfigured = isChannelConfigured(cfg, id);
      const wasConfigured = ch.configured;
      ch.configured = nowConfigured;

      // 配置变更：先停后启
      if (ch.handle) {
        try {
          ch.handle.stop();
        } catch {}
        ch.handle = undefined;
        ch.connectedAt = undefined;
        console.log(`[channel-manager] Stopped ${ch.name} for config refresh`);
      }

      if (nowConfigured) {
        try {
          ch.handle = await this.startBot(id);
          ch.connectedAt = new Date();
          ch.error = undefined;
          console.log(`[channel-manager] Started ${ch.name}`);
        } catch (err) {
          ch.error = err instanceof Error ? err.message : String(err);
          console.error(`[channel-manager] Failed to start ${ch.name}:`, err);
        }
      }
    }
  }

  /** Set handle for a channel directly (used during migration from index.ts) */
  setHandle(id: string, handle: BotHandle): void {
    const ch = this.channels.get(id);
    if (ch) {
      ch.handle = handle;
      ch.connectedAt = new Date();
    }
  }

  private toInfo(ch: ChannelState): ChannelInfo {
    if (!ch.configured) {
      return {
        id: ch.id,
        name: ch.name,
        status: "not_configured",
        statusMessage: "Environment variables not set",
      };
    }
    if (ch.error) {
      return {
        id: ch.id,
        name: ch.name,
        status: "error",
        statusMessage: ch.error,
      };
    }
    if (ch.handle || ch.id === "websocket" || ch.id === "email") {
      return {
        id: ch.id,
        name: ch.name,
        status: "connected",
        connectedAt: ch.connectedAt?.toISOString(),
      };
    }
    return {
      id: ch.id,
      name: ch.name,
      status: "disconnected",
    };
  }

  private async startBot(id: string): Promise<BotHandle> {
    const cfg = loadConfig();
    switch (id) {
      case "telegram": {
        const token = cfg.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN!;
        return startTelegramBot(token, this.ctx);
      }
      case "whatsapp":
        return startWhatsAppBot(this.ctx);
      case "dingtalk":
        return startDingTalkBot(
          {
            clientId: cfg.dingtalk?.appKey || process.env.DINGTALK_APP_KEY!,
            clientSecret:
              cfg.dingtalk?.appSecret || process.env.DINGTALK_APP_SECRET!,
            allowedUsers: process.env.DINGTALK_ALLOWED_USERS,
          },
          this.ctx,
        );
      case "feishu":
        return startFeishuBot(
          {
            appId: cfg.feishu?.appId || process.env.FEISHU_APP_ID!,
            appSecret: cfg.feishu?.appSecret || process.env.FEISHU_APP_SECRET!,
            allowedUsers: process.env.FEISHU_ALLOWED_USERS,
          },
          this.ctx,
        );
      case "qqbot":
        return startQQBot(
          {
            appId: cfg.qqBot?.appId || process.env.QQ_BOT_APP_ID!,
            appSecret: cfg.qqBot?.appSecret || process.env.QQ_BOT_APP_SECRET!,
            sandbox: process.env.QQ_BOT_SANDBOX === "true",
          },
          this.ctx,
        );
      case "wecom":
        return startWeComBot(
          {
            botId: cfg.wecom?.botId || process.env.WECOM_BOT_ID!,
            secret: cfg.wecom?.botSecret || process.env.WECOM_BOT_SECRET!,
          },
          this.ctx,
        );
      default:
        throw new Error(`Unknown channel: ${id}`);
    }
  }
}
