import type React from "react";
import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/PageHeader";
import {
  listChannels,
  startChannel,
  stopChannel,
  getConfig,
  updateAppConfig,
  type ChannelInfo,
  type AppConfigInfo,
} from "../api/client";
import "./ChannelsPage.css";

/** Shared SVG props for all channel icons */
const svgProps = {
  viewBox: "0 0 24 24",
  width: 24,
  height: 24,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function TelegramIcon() {
  return (
    <svg {...svgProps}>
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22L11 13L2 9L22 2Z" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg {...svgProps}>
      <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
      <path d="M9.5 10.5a1 1 0 001 1h3a1 1 0 001-1v-1a1 1 0 00-1-1h-3a1 1 0 00-1 1v1z" />
    </svg>
  );
}

function DingTalkIcon() {
  return (
    <svg {...svgProps}>
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

function FeishuIcon() {
  return (
    <svg {...svgProps}>
      <path d="M20.24 12.24a6 6 0 00-8.49-8.49L5 10.5V19h8.5l6.74-6.76z" />
      <line x1="16" y1="8" x2="2" y2="22" />
      <line x1="17.5" y1="15" x2="9" y2="15" />
    </svg>
  );
}

function QQBotIcon() {
  return (
    <svg {...svgProps}>
      <circle cx="12" cy="10" r="7" />
      <path d="M8.5 9.5a1 1 0 011-1h1a1 1 0 010 2h-1a1 1 0 01-1-1z" />
      <path d="M13.5 9.5a1 1 0 011-1h1a1 1 0 010 2h-1a1 1 0 01-1-1z" />
      <path d="M9 13c1 1 4 1 5 0" />
      <path d="M7 17c1 2 3 3 5 3s4-1 5-3" />
    </svg>
  );
}

function WeComIcon() {
  return (
    <svg {...svgProps}>
      <path d="M17 3H7a4 4 0 00-4 4v6a4 4 0 004 4h1l3 4 3-4h3a4 4 0 004-4V7a4 4 0 00-4-4z" />
      <path d="M9 9h0" />
      <path d="M15 9h0" />
      <path d="M9 13c1 1 4 1 5 0" />
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg {...svgProps}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M22 7l-10 7L2 7" />
    </svg>
  );
}

function WebSocketIcon() {
  return (
    <svg {...svgProps}>
      <path d="M12 2v6" />
      <path d="M8 4h8" />
      <rect x="7" y="8" width="10" height="8" rx="2" />
      <path d="M9 16v2" />
      <path d="M15 16v2" />
      <path d="M6 20h12" />
    </svg>
  );
}

const CHANNEL_ICONS: Record<string, () => React.ReactElement> = {
  telegram: TelegramIcon,
  whatsapp: WhatsAppIcon,
  dingtalk: DingTalkIcon,
  feishu: FeishuIcon,
  qqbot: QQBotIcon,
  wecom: WeComIcon,
  email: EmailIcon,
  websocket: WebSocketIcon,
};

function getChannelIcon(id: string) {
  const Icon = CHANNEL_ICONS[id];
  return Icon ? <Icon /> : <WebSocketIcon />;
}

/** 渠道配置字段定义 */
interface ChannelFieldDef {
  id: string;
  name: string;
  configKey: string; // AppConfigInfo 中的 key
  fields: { key: string; label: string; type: "text" | "password" }[];
  /** "bot" = IM 渠道（有启停），"credential" = 服务凭证（只有配置状态） */
  kind: "bot" | "credential";
}

const CHANNEL_DEFS: ChannelFieldDef[] = [
  {
    id: "telegram",
    name: "Telegram",
    configKey: "telegram",
    kind: "bot",
    fields: [{ key: "botToken", label: "Bot Token", type: "password" }],
  },
  {
    id: "dingtalk",
    name: "DingTalk",
    configKey: "dingtalk",
    kind: "bot",
    fields: [
      { key: "appKey", label: "App Key", type: "text" },
      { key: "appSecret", label: "App Secret", type: "password" },
    ],
  },
  {
    id: "feishu",
    name: "Feishu",
    configKey: "feishu",
    kind: "bot",
    fields: [
      { key: "appId", label: "App ID", type: "text" },
      { key: "appSecret", label: "App Secret", type: "password" },
    ],
  },
  {
    id: "qqbot",
    name: "QQ Bot",
    configKey: "qqBot",
    kind: "bot",
    fields: [
      { key: "appId", label: "App ID", type: "text" },
      { key: "appSecret", label: "App Secret", type: "password" },
    ],
  },
  {
    id: "wecom",
    name: "WeCom",
    configKey: "wecom",
    kind: "bot",
    fields: [
      { key: "botId", label: "Bot ID", type: "text" },
      { key: "botSecret", label: "Bot Secret", type: "password" },
    ],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    configKey: "whatsapp",
    kind: "bot",
    fields: [], // 仅 enabled 开关
  },
  {
    id: "email",
    name: "Email",
    configKey: "email",
    kind: "credential",
    fields: [
      { key: "imapHost", label: "IMAP Host", type: "text" },
      { key: "smtpHost", label: "SMTP Host", type: "text" },
      { key: "user", label: "Email Address", type: "text" },
      { key: "password", label: "Password", type: "password" },
    ],
  },
];

const BOT_CHANNELS = CHANNEL_DEFS.filter((d) => d.kind === "bot");
const CREDENTIAL_CHANNELS = CHANNEL_DEFS.filter((d) => d.kind === "credential");

/** 判断脱敏值 */
function isMaskedValue(value: string | undefined): boolean {
  return !!value && value.startsWith("****");
}

/** Relative time display */
function relativeTime(
  iso: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return t("time.secsAgo", { count: diffSec });
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t("time.minsAgo", { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("time.hoursAgo", { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  return t("time.daysAgo", { count: diffDay });
}

export function ChannelsPage() {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [config, setConfig] = useState<AppConfigInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>("telegram");
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [channelsData, configData] = await Promise.all([
        listChannels(),
        getConfig(),
      ]);
      setChannels(channelsData);
      setConfig(configData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    intervalRef.current = setInterval(async () => {
      try {
        const data = await listChannels();
        setChannels(data);
      } catch {}
    }, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchAll]);

  // 切换选中渠道时重置表单
  useEffect(() => {
    setFormValues({});
    setSaveMsg(null);
  }, [selectedId]);

  const getChannelStatus = (id: string) => channels.find((c) => c.id === id);

  const handleToggle = async (ch: ChannelInfo) => {
    if (ch.status === "not_configured") return;
    if (ch.id === "websocket") return;

    const action = ch.status === "connected" ? stopChannel : startChannel;
    setTogglingIds((prev) => new Set(prev).add(ch.id));

    try {
      const updated = await action(ch.id);
      setChannels((prev) => prev.map((c) => (c.id === ch.id ? updated : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle channel");
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(ch.id);
        return next;
      });
    }
  };

  const handleSave = async () => {
    const def = CHANNEL_DEFS.find((d) => d.id === selectedId);
    if (!def) return;

    setSaving(true);
    setSaveMsg(null);

    try {
      // 构建渠道配置对象
      const channelConfig: Record<string, unknown> = {};
      let hasRealChange = false;

      for (const field of def.fields) {
        const val = formValues[field.key];
        if (val && !isMaskedValue(val)) {
          channelConfig[field.key] = val;
          hasRealChange = true;
        }
      }

      if (!hasRealChange) {
        setSaveMsg(t("settings.configNoChanges"));
        setSaving(false);
        return;
      }

      // 发送到后端
      await updateAppConfig({
        [def.configKey]: channelConfig,
      } as Partial<AppConfigInfo>);

      setSaveMsg(t("settings.configSaved"));
      setFormValues({});

      // 刷新数据
      await fetchAll();
    } catch (err) {
      setSaveMsg(
        err instanceof Error ? err.message : t("settings.configSaveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader>{t("channels.title")}</PageHeader>
        <div className="page-body">
          <div className="channels-loading">
            {t("channels.loadingChannels")}
          </div>
        </div>
      </>
    );
  }

  const selectedDef = CHANNEL_DEFS.find((d) => d.id === selectedId);
  const selectedStatus = getChannelStatus(selectedId);

  return (
    <>
      <PageHeader>{t("channels.title")}</PageHeader>
      <div className="page-body">
        {error && (
          <div className="channels-error">
            {error}
            <button onClick={() => setError(null)}>
              {t("common.dismiss")}
            </button>
          </div>
        )}

        <div className="channels-split">
          {/* 左侧：分组渠道列表 */}
          <div className="channels-list">
            {/* IM 渠道组 */}
            <div className="channels-group-label">
              {t("channels.imChannels")}
            </div>
            {BOT_CHANNELS.map((def) => {
              const status = getChannelStatus(def.id);
              const isActive = def.id === selectedId;
              const isConnected = status?.status === "connected";
              const isConfigured = status?.status !== "not_configured";

              return (
                <div
                  key={def.id}
                  className={`channels-list-item${isActive ? " active" : ""}`}
                  onClick={() => setSelectedId(def.id)}
                >
                  <span className="channels-list-icon">
                    {getChannelIcon(def.id)}
                  </span>
                  <span className="channels-list-name">{def.name}</span>
                  <span
                    className={[
                      "channels-toggle",
                      isConnected && "on",
                      (!isConfigured || togglingIds.has(def.id)) && "disabled",
                      togglingIds.has(def.id) && "loading",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (status && !togglingIds.has(def.id)) {
                        handleToggle(status);
                      }
                    }}
                    role="switch"
                    aria-checked={isConnected}
                  >
                    <span className="channels-toggle-knob" />
                  </span>
                </div>
              );
            })}

            {/* 服务凭证组 */}
            <div className="channels-group-label">
              {t("channels.credentials")}
            </div>
            {CREDENTIAL_CHANNELS.map((def) => {
              const status = getChannelStatus(def.id);
              const isActive = def.id === selectedId;
              const isConfigured = status?.status !== "not_configured";

              return (
                <div
                  key={def.id}
                  className={`channels-list-item${isActive ? " active" : ""}`}
                  onClick={() => setSelectedId(def.id)}
                >
                  <span className="channels-list-icon">
                    {getChannelIcon(def.id)}
                  </span>
                  <span className="channels-list-name">{def.name}</span>
                  <span
                    className={`channels-status-badge ${isConfigured ? "configured" : ""}`}
                  >
                    {isConfigured
                      ? t("channels.configured")
                      : t("channels.notConfigured")}
                  </span>
                </div>
              );
            })}

            {/* WebSocket（始终启用，不可点击） */}
            <div className="channels-list-item disabled">
              <span className="channels-list-icon">
                {getChannelIcon("websocket")}
              </span>
              <span className="channels-list-name">WebSocket</span>
              <span className="channels-status-badge configured">
                {t("channels.alwaysOn")}
              </span>
            </div>
          </div>

          {/* 右侧：配置表单 */}
          <div className="channels-detail">
            {selectedDef && (
              <>
                <div className="channels-detail-header">
                  <span className="channels-detail-icon">
                    {getChannelIcon(selectedId)}
                  </span>
                  <h3 className="channels-detail-title">{selectedDef.name}</h3>
                  {selectedStatus && (
                    <span
                      className={`channels-detail-status ${selectedStatus.status}`}
                    >
                      {selectedStatus.status === "connected"
                        ? t("settings.providerConnected")
                        : selectedStatus.status === "error"
                          ? "Error"
                          : selectedStatus.status === "not_configured"
                            ? t("channels.notConfigured")
                            : "Disconnected"}
                    </span>
                  )}
                </div>

                {selectedStatus?.status === "connected" &&
                  selectedStatus.connectedAt && (
                    <div className="channels-detail-connected">
                      {t("channels.connectedSince")}{" "}
                      {relativeTime(selectedStatus.connectedAt, t)}
                    </div>
                  )}

                {selectedStatus?.status === "error" &&
                  selectedStatus.statusMessage && (
                    <div className="channels-detail-error">
                      {selectedStatus.statusMessage}
                    </div>
                  )}

                {selectedDef.fields.length > 0 ? (
                  <div className="channels-detail-form">
                    {selectedDef.fields.map((field) => {
                      // 从 config 中获取当前值作为 placeholder
                      const configObj = config?.[
                        selectedDef.configKey as keyof AppConfigInfo
                      ] as Record<string, string> | undefined;
                      const currentValue = configObj?.[field.key];

                      return (
                        <div key={field.key} className="channels-detail-field">
                          <label className="channels-detail-label">
                            {field.label}
                          </label>
                          <input
                            type={field.type}
                            className="config-input"
                            placeholder={currentValue || `Enter ${field.label}`}
                            value={formValues[field.key] || ""}
                            onChange={(e) =>
                              setFormValues((prev) => ({
                                ...prev,
                                [field.key]: e.target.value,
                              }))
                            }
                          />
                        </div>
                      );
                    })}

                    <div className="channels-detail-actions">
                      <button
                        className="btn btn-primary"
                        disabled={
                          saving ||
                          !Object.values(formValues).some(
                            (v) => v && !isMaskedValue(v),
                          )
                        }
                        onClick={handleSave}
                      >
                        {saving
                          ? t("settings.configSaving")
                          : t("settings.configSave")}
                      </button>
                      {saveMsg && (
                        <span
                          className={`config-save-msg ${saveMsg === t("settings.configSaved") ? "success" : ""}`}
                        >
                          {saveMsg}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="channels-detail-empty">
                    {selectedDef.id === "whatsapp"
                      ? t("channels.whatsappHint")
                      : t("channels.noFieldsNeeded")}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
