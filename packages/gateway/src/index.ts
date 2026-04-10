// Tauri sidecar: process.cwd() defaults to system32 — override with DATA_DIR
if (process.env.DATA_DIR) {
  process.chdir(process.env.DATA_DIR);
}

import * as Sentry from "@sentry/node";

// Sentry 错误监控：仅在配置了 DSN 时初始化，否则零开销
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "production",
    tracesSampleRate: 0.2,
  });
}

import "dotenv/config";
import { Cron } from "croner";
import { bootstrap } from "./bootstrap.js";
import { createServer } from "./server.js";
import { HeartbeatManager } from "./heartbeat.js";
import { getWsClients } from "./ws.js";
import { ChannelManager } from "./channel-manager.js";
import { copyFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { collectResponse, errorMessage } from "./utils.js";
import { TaskManager } from "@agentclaw/core";

export { bootstrap } from "./bootstrap.js";
export type { AppContext, AppRuntimeConfig } from "./bootstrap.js";
export { loadConfig, saveConfig, maskConfig, maskApiKey, getConfigPath } from "./config.js";
export type { AppConfig } from "./config.js";
export { createServer } from "./server.js";
export type { ServerOptions } from "./server.js";
export { TaskScheduler } from "./scheduler.js";
export type { ScheduledTask } from "./scheduler.js";
export { startTelegramBot } from "./telegram.js";
export { startWhatsAppBot } from "./whatsapp.js";
export { startDingTalkBot } from "./dingtalk.js";
export type { DingTalkConfig } from "./dingtalk.js";
export { startFeishuBot } from "./feishu.js";
export type { FeishuConfig } from "./feishu.js";
export { startQQBot } from "./qqbot.js";
export type { QQBotConfig } from "./qqbot.js";
export { startWeComBot } from "./wecom.js";
export type { WeComConfig } from "./wecom.js";
export { registerAgentApiRoutes } from "./routes/agent-api.js";
export { HeartbeatManager } from "./heartbeat.js";
export type { HeartbeatConfig, HeartbeatDeps } from "./heartbeat.js";
export { runHealthChecks, formatHealthResults } from "./health-check.js";
export type { HealthCheckResult } from "./health-check.js";
export { PLATFORM_HINTS, getPlatformHint } from "./platform-hints.js";
export { ChannelManager } from "./channel-manager.js";
export type { ChannelInfo } from "./channel-manager.js";
export {
  getPublicUrl,
  buildFileUrl,
  createPromptUser,
  createLinkSendFile,
  processSimpleEventLoop,
  restoreChatTargets,
} from "./channel-utils.js";
export type { SimpleEventLoopOptions } from "./channel-utils.js";

async function main(): Promise<void> {
  const port = parseInt(process.env.PORT || "3100", 10);
  const host = process.env.HOST || "0.0.0.0";

  console.log("[gateway] Bootstrapping...");
  const ctx = await bootstrap();

  // Channel Manager: unified lifecycle for all bot channels
  const channelManager = new ChannelManager(ctx);

  console.log("[gateway] Creating server...");
  const app = await createServer({ ctx, scheduler: ctx.scheduler, channelManager });

  // Start listening
  try {
    await app.listen({ port, host });
    console.log(`[gateway] Server listening on http://${host}:${port}`);
  } catch (err) {
    Sentry.captureException(err);
    console.error("[gateway] Failed to start server:", err);
    process.exit(1);
  }

  // Start all configured channels
  await channelManager.startAll();

  // Unified broadcast: send text to all active channels + WebSocket clients
  const broadcastAll = async (text: string) => {
    await channelManager.broadcast(text);
    // Broadcast to all WebSocket clients
    for (const ws of getWsClients()) {
      try {
        ws.send(JSON.stringify({ type: "broadcast", text }));
      } catch {
        // client may have disconnected
      }
    }
  };

  // Scheduler: one-shot reminders broadcast directly; recurring tasks run through orchestrator
  ctx.scheduler.setOnTaskFire(async (task) => {
    if (task.oneShot) {
      console.log(`[scheduler] Reminder fired: "${task.action}"`);
      await broadcastAll(`⏰ 提醒：${task.action}`);
      return;
    }

    console.log(
      `[scheduler] Running task "${task.name}" through orchestrator...`,
    );
    try {
      const text = await collectResponse(ctx.orchestrator, task.action, {
        sendFile: async (filePath: string, caption?: string) => {
          const { basename, extname } = await import("node:path");
          const { readFileSync } = await import("node:fs");
          const ext = extname(filePath).toLowerCase();
          // Text files: broadcast content directly (IM channels can't open localhost links)
          if ([".md", ".txt", ".csv", ".json", ".html"].includes(ext)) {
            try {
              const content = readFileSync(filePath, "utf-8");
              await broadcastAll(content.slice(0, 4000));
              return;
            } catch { /* fall through to link */ }
          }
          // Binary files: broadcast download link
          const { buildFileUrl, getPublicUrl } = await import("./channel-utils.js");
          const url = buildFileUrl(filePath);
          await broadcastAll(`📎 ${caption || basename(filePath)}\n${getPublicUrl()}${url}`);
        },
      });
      await broadcastAll(text.trim() || `✅ 定时任务「${task.name}」已执行完成。`);
    } catch (err) {
      Sentry.captureException(err);
      const msg = `❌ 定时任务「${task.name}」执行失败: ${errorMessage(err)}`;
      console.error("[scheduler]", msg);
      await broadcastAll(msg);
    }
  });

  // Heartbeat: periodic self-check for pending tasks/reminders
  const heartbeat = new HeartbeatManager(
    {
      enabled: process.env.HEARTBEAT_ENABLED === "true",
      intervalMinutes: parseInt(process.env.HEARTBEAT_INTERVAL || "5", 10),
    },
    {
      orchestrator: ctx.orchestrator,
      scheduler: ctx.scheduler,
      memoryStore: ctx.memoryStore,
      broadcast: broadcastAll,
    },
  );
  heartbeat.start();

  // 每小时健康检查：检测服务状态变化并通知用户
  const healthJob = new Cron("0 * * * *", async () => {
    try {
      const changed = await ctx.refreshHealth();
      if (changed.length > 0) {
        const lines = changed.map(
          (r) => `${r.ok ? "✅" : "❌"} ${r.name}：${r.message}`,
        );
        const text = `[服务状态变化]\n${lines.join("\n")}`;
        console.log(`[health-check] ${text}`);
        await broadcastAll(text);
      } else {
        console.log("[health-check] 定时检查完成，无状态变化");
      }
    } catch (err) {
      console.error("[health-check] 定时检查失败:", errorMessage(err));
    }
  });

  // 每天凌晨 3 点整合记忆：衰减 → 去重 → 清理
  const memoryConsolidationJob = new Cron("0 3 * * *", async () => {
    try {
      const store = ctx.memoryStore as { consolidate?: (ns?: string) => Promise<unknown> };
      if (store.consolidate) {
        const result = await store.consolidate();
        console.log("[memory-consolidation] Daily run:", result);
      }
    } catch (err) {
      console.error("[memory-consolidation] Failed:", errorMessage(err));
    }
  });

  // 每天凌晨 2 点备份 SQLite 数据库（保留最近 7 份）
  const dbBackupJob = new Cron("0 2 * * *", () => {
    try {
      const dbPath = ctx.config.databasePath;
      const backupDir = join(dirname(dbPath), "backups");
      mkdirSync(backupDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const backupPath = join(backupDir, `agentclaw-${date}.db`);
      copyFileSync(dbPath, backupPath);
      console.log(`[db-backup] Backed up to ${backupPath}`);
      // Prune: keep only the latest 7 backups
      const files = readdirSync(backupDir)
        .filter((f) => f.startsWith("agentclaw-") && f.endsWith(".db"))
        .sort();
      while (files.length > 7) {
        const old = files.shift()!;
        unlinkSync(join(backupDir, old));
        console.log(`[db-backup] Pruned old backup: ${old}`);
      }
    } catch (err) {
      console.error("[db-backup] Failed:", errorMessage(err));
    }
  });

  // TaskManager: 捕获、分诊、执行、决策的统一任务管理
  const taskManager = new TaskManager(
    ctx.memoryStore,
    ctx.orchestrator,
    broadcastAll,
    { scanIntervalMs: 60_000, maxConcurrent: 1 },
  );
  // 挂载到 ctx 供 API 路由使用
  (ctx as unknown as Record<string, unknown>).taskManager = taskManager;
  taskManager.startScanner();

  // 每日简报定时推送（默认 09:00，可通过 API 或页面设置修改）
  let dailyBriefJob: Cron | null = null;

  function startDailyBriefJob() {
    if (dailyBriefJob) dailyBriefJob.stop();
    const store = ctx.memoryStore as any;
    const enabled = store.getSetting?.("daily_brief_enabled") !== "false"; // 默认启用
    const time = store.getSetting?.("daily_brief_time") || "09:00";
    const [hour, minute] = time.split(":").map(Number);
    const hh = isNaN(hour) ? 9 : hour;
    const mm = isNaN(minute) ? 0 : minute;
    const cronExpr = `${mm} ${hh} * * *`;

    if (!enabled) {
      dailyBriefJob = null;
      console.log(`[daily-brief] Disabled`);
      return;
    }

    dailyBriefJob = new Cron(cronExpr, async () => {
      try {
        const stats = ctx.memoryStore.getTaskStats();
        const totalPending = stats.total_pending ?? 0;

        // 没有待处理任务则不发送
        if (totalPending === 0) {
          console.log("[daily-brief] No pending tasks, skipping");
          return;
        }

        const brief = await taskManager.generateDailyBrief();
        console.log("[daily-brief] Broadcasting daily brief");
        await broadcastAll(brief);
      } catch (err) {
        console.error("[daily-brief] Failed:", errorMessage(err));
      }
    });
    console.log(`[daily-brief] Scheduled at ${time} (cron: ${cronExpr})`);
  }

  startDailyBriefJob();
  // 暴露刷新函数供 API 路由在时间变更后调用
  (ctx as unknown as Record<string, unknown>).restartDailyBrief =
    startDailyBriefJob;

  // 优雅关停
  const shutdown = async (signal: string) => {
    console.log(`[shutdown] Received ${signal}, closing gracefully...`);

    // 超时保护：30 秒后强制退出（LLM 调用通常需要 30-60 秒）
    const forceExit = setTimeout(() => {
      console.error("[shutdown] Force exit after timeout");
      process.exit(1);
    }, 30_000);
    forceExit.unref(); // 不阻止进程自然退出

    // Stop accepting new work
    heartbeat.stop();
    healthJob.stop();
    memoryConsolidationJob.stop();
    dbBackupJob.stop();
    if (dailyBriefJob) dailyBriefJob.stop();
    taskManager.stopScanner();
    channelManager.stopAll();
    ctx.scheduler.stopAll();

    // Wait for active conversations to finish (poll every 1s, max 15s)
    const orch = ctx.orchestrator as { activeLoops?: Map<string, unknown> };
    if (orch.activeLoops && orch.activeLoops.size > 0) {
      console.log(
        `[shutdown] Waiting for ${orch.activeLoops.size} active conversation(s) to finish...`,
      );
      const waitStart = Date.now();
      while (orch.activeLoops.size > 0 && Date.now() - waitStart < 15_000) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (orch.activeLoops.size > 0) {
        console.warn(
          `[shutdown] ${orch.activeLoops.size} conversation(s) still active, proceeding with close`,
        );
      }
    }

    try {
      await app.close();
      console.log("[shutdown] Server closed");
    } catch (err) {
      console.error("[shutdown] Error during close:", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  Sentry.captureException(err);
  console.error("[gateway] Fatal error:", err);
  process.exit(1);
});
