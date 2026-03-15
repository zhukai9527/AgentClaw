import { useState, useEffect, useCallback } from "react";
import { useParams, NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/PageHeader";
import { useTheme } from "../components/ThemeProvider";
import {
  getConfig,
  getStats,
  listTools,
  updateAppConfig,
  validateApiKey,
  type AppConfigInfo,
  type UsageStatsInfo,
  type ToolInfo,
} from "../api/client";
import {
  IconSettings,
  IconChannels,
  IconSubAgents,
  IconAgents,
  IconMemory,
  IconTraces,
  IconSkills,
  IconApi,
} from "../components/Icons";
import { formatNumber } from "../utils/format";
import { setLanguage, getLanguage } from "../i18n";
import { ChannelsPage } from "./ChannelsPage";
import { SubagentsPage } from "./SubagentsPage";
import { AgentsPage } from "./AgentsPage";
import { MemoryPage } from "./MemoryPage";
import { TracesPage } from "./TracesPage";
import { SkillsPage } from "./SkillsPage";
import { ApiPage } from "./ApiPage";
import "./SettingsPage.css";

/* ── Icon for Model (chip/processor) ── */
function IconModel({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  );
}

/* ── Icon for Tools (simple wrench) ── */
function IconTools({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

const TABS = [
  { id: "general", icon: IconSettings },
  { id: "model", icon: IconModel },
  { id: "channels", icon: IconChannels },
  { id: "agents", icon: IconAgents },
  { id: "subagents", icon: IconSubAgents },
  { id: "memory", icon: IconMemory },
  { id: "tools", icon: IconTools },
  { id: "skills", icon: IconSkills },
  { id: "traces", icon: IconTraces },
  { id: "api", icon: IconApi },
] as const;

/** 判断脱敏值是否已被修改（非 "****xxxx" 格式或空） */
function isMaskedValue(value: string | undefined): boolean {
  if (!value) return false;
  return value.startsWith("****");
}

/* ── Provider 定义 ── */
const PROVIDER_DEFS = [
  {
    id: "openai",
    label: "OpenAI Compatible",
    keyField: "openaiApiKey" as const,
    modelField: "openaiModel" as const,
    hasBaseUrl: true,
    hint: "settings.configBaseUrlHint",
    placeholder: "sk-...",
    baseUrlPlaceholder: "https://api.openai.com/v1",
    modelPlaceholder: "gpt-4o",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    keyField: "anthropicApiKey" as const,
    modelField: "anthropicModel" as const,
    hasBaseUrl: false,
    placeholder: "sk-ant-...",
    modelPlaceholder: "claude-sonnet-4-20250514",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    keyField: "geminiApiKey" as const,
    modelField: "geminiModel" as const,
    hasBaseUrl: false,
    placeholder: "AIza...",
    modelPlaceholder: "gemini-2.0-flash",
  },
] as const;

/* ── Model tab — left-right split: provider list + config form + usage stats ── */
function SettingsModel() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<AppConfigInfo | null>(null);
  const [stats, setStats] = useState<UsageStatsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>("openai");
  const [togglingProvider, setTogglingProvider] = useState<string | null>(null);

  const toBackendName = (id: string) => (id === "anthropic" ? "claude" : id);
  const toFrontendId = (name: string) =>
    name === "claude" ? "anthropic" : name;

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      const [configData, statsData] = await Promise.all([
        getConfig(),
        getStats(),
      ]);
      setConfig(configData);
      setStats(statsData);
      setError(null);
      // Auto-select active provider
      const active =
        configData.activeProvider || configData.provider || "openai";
      setSelectedProvider(active === "claude" ? "anthropic" : active);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  /** Toggle provider on/off — saves activeProvider immediately */
  const handleToggle = async (providerId: string) => {
    if (!config || togglingProvider) return;
    const currentActive = toFrontendId(
      config.activeProvider || config.provider || "openai",
    );
    // 已经是 active 的不能关（至少要有一个）
    if (currentActive === providerId) return;
    setTogglingProvider(providerId);
    try {
      await updateAppConfig({
        activeProvider: toBackendName(providerId),
      } as Partial<AppConfigInfo>);
      await fetchAll();
    } catch {
      // ignore
    } finally {
      setTogglingProvider(null);
    }
  };

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="settings-loading">{t("settings.loadingSettings")}</div>
    );
  }

  /** 该 provider 是否已配置 */
  const isConfigured = (def: (typeof PROVIDER_DEFS)[number]) =>
    !!config?.[def.keyField] &&
    config[def.keyField] !== t("settings.configNotSet");

  /** 排序：已配置排前面 */
  const sortedProviders = [...PROVIDER_DEFS].sort((a, b) => {
    const aConf = isConfigured(a) ? 0 : 1;
    const bConf = isConfigured(b) ? 0 : 1;
    return aConf - bConf;
  });

  const selectedDef =
    PROVIDER_DEFS.find((d) => d.id === selectedProvider) || PROVIDER_DEFS[0];

  return (
    <>
      {error && <div className="settings-error">{error}</div>}

      {/* Provider split layout */}
      <div className="model-split">
        {/* Left: provider list */}
        <div className="model-list">
          {sortedProviders.map((def) => {
            const selected = selectedProvider === def.id;
            const currentActive = toFrontendId(
              config?.activeProvider || config?.provider || "openai",
            );
            const isOn = currentActive === def.id;
            const toggling = togglingProvider === def.id;
            return (
              <div
                key={def.id}
                className={`model-list-item${selected ? " active" : ""}`}
                onClick={() => setSelectedProvider(def.id)}
              >
                <span className="model-list-name">{def.label}</span>
                <div
                  className={`channels-toggle${isOn ? " on" : ""}${toggling ? " loading" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggle(def.id);
                  }}
                >
                  <div className="channels-toggle-knob" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Right: config form for selected provider */}
        <div className="model-detail">
          {config && (
            <ProviderConfigForm
              config={config}
              def={selectedDef}
              onSaved={fetchAll}
            />
          )}
        </div>
      </div>

      {/* Usage Statistics */}
      {stats && (
        <section className="card settings-section" style={{ marginTop: 20 }}>
          <h2 className="settings-section-title">{t("settings.usageStats")}</h2>
          <div className="stats-overview">
            <div className="stat-item">
              <span className="stat-value">
                {formatNumber(stats.totalCalls)}
              </span>
              <span className="stat-label">{t("settings.totalCalls")}</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">
                {formatNumber(stats.totalInputTokens)}
              </span>
              <span className="stat-label">{t("settings.inputTokens")}</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">
                {formatNumber(stats.totalOutputTokens)}
              </span>
              <span className="stat-label">{t("settings.outputTokens")}</span>
            </div>
          </div>

          {stats.byModel.length > 0 && (
            <div className="stats-table-wrapper">
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>{t("settings.modelCol")}</th>
                    <th>{t("settings.callsCol")}</th>
                    <th>{t("settings.inputTokens")}</th>
                    <th>{t("settings.outputTokens")}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byModel.map((row, i) => (
                    <tr key={i}>
                      <td>
                        <code className="model-name">{row.model}</code>
                      </td>
                      <td>{formatNumber(row.callCount)}</td>
                      <td>{formatNumber(row.totalInputTokens)}</td>
                      <td>{formatNumber(row.totalOutputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

/* ── Single provider config form (right panel of Model tab) ── */
function ProviderConfigForm({
  config,
  def,
  onSaved,
}: {
  config: AppConfigInfo;
  def: (typeof PROVIDER_DEFS)[number];
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(config[def.modelField] || "");
  const [baseUrl, setBaseUrl] = useState(
    def.id === "openai" ? config.openaiBaseUrl || "" : "",
  );
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [validateMsg, setValidateMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  // Reset form when provider changes
  useEffect(() => {
    setApiKey("");
    setModel(config[def.modelField] || "");
    setBaseUrl(def.id === "openai" ? config.openaiBaseUrl || "" : "");
    setSaveMsg(null);
    setValidateMsg(null);
  }, [def.id, config]);

  const configured =
    !!config[def.keyField] &&
    config[def.keyField] !== t("settings.configNotSet");

  const toBackendName = (id: string) => (id === "anthropic" ? "claude" : id);

  const hasChanges = (() => {
    if (apiKey && !isMaskedValue(apiKey)) return true;
    if (model !== (config[def.modelField] || "")) return true;
    if (def.id === "openai" && baseUrl !== (config.openaiBaseUrl || ""))
      return true;
    return false;
  })();

  const handleValidate = async () => {
    if (!apiKey) {
      setValidateMsg({ ok: false, text: t("settings.configEnterKey") });
      return;
    }
    setValidating(true);
    setValidateMsg(null);
    try {
      const params: {
        provider: string;
        apiKey: string;
        baseUrl?: string;
        model?: string;
      } = { provider: toBackendName(def.id), apiKey };
      if (def.id === "openai" && baseUrl) params.baseUrl = baseUrl;
      if (model) params.model = model;
      const result = await validateApiKey(params);
      setValidateMsg({
        ok: result.valid,
        text: result.valid
          ? t("settings.configKeyValid")
          : t("settings.configKeyInvalid") +
            (result.error ? `: ${result.error}` : ""),
      });
    } catch (err) {
      setValidateMsg({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const updates: Record<string, unknown> = {};
      if (apiKey && !isMaskedValue(apiKey)) updates[def.keyField] = apiKey;
      if (model !== (config[def.modelField] || ""))
        updates[def.modelField] = model || undefined;
      if (def.id === "openai" && baseUrl !== (config.openaiBaseUrl || ""))
        updates.openaiBaseUrl = baseUrl || undefined;

      if (Object.keys(updates).length === 0) {
        setSaveMsg(t("settings.configNoChanges"));
        setSaving(false);
        return;
      }
      await updateAppConfig(updates as Partial<AppConfigInfo>);
      setSaveMsg(t("settings.configSaved"));
      setApiKey("");
      onSaved();
    } catch (err) {
      setSaveMsg(
        err instanceof Error ? err.message : t("settings.configSaveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="model-detail-header">
        <h3 className="model-detail-title">{def.label}</h3>
        <span
          className={`channels-status-badge${configured ? " configured" : ""}`}
        >
          {configured
            ? t("settings.providerConnected")
            : t("settings.providerNotSet")}
        </span>
      </div>

      <div className="channels-detail-form">
        {/* API Key */}
        <div className="channels-detail-field">
          <label className="channels-detail-label">API Key</label>
          <input
            type="password"
            className="config-input"
            placeholder={config[def.keyField] || def.placeholder}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {(apiKey || validateMsg) && (
            <div className="provider-card-aux" style={{ paddingLeft: 0 }}>
              {apiKey && (
                <span
                  className={`config-validate-link${validating ? " disabled" : ""}`}
                  onClick={() => !validating && handleValidate()}
                >
                  {validating
                    ? t("settings.configValidating")
                    : t("settings.configValidate")}
                </span>
              )}
              {validateMsg && (
                <span
                  className={`config-validate-msg ${validateMsg.ok ? "success" : "error"}`}
                >
                  {validateMsg.text}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Base URL (OpenAI only) */}
        {def.hasBaseUrl && (
          <div className="channels-detail-field">
            <label className="channels-detail-label">Base URL</label>
            <input
              type="text"
              className="config-input"
              placeholder={def.baseUrlPlaceholder}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            {def.hint && <span className="config-hint">{t(def.hint)}</span>}
          </div>
        )}

        {/* Model */}
        <div className="channels-detail-field">
          <label className="channels-detail-label">{t("settings.model")}</label>
          <input
            type="text"
            className="config-input"
            placeholder={def.modelPlaceholder}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>

        {/* Save */}
        <div className="channels-detail-actions">
          <button
            className="btn btn-primary"
            disabled={!hasChanges || saving}
            onClick={handleSave}
          >
            {saving ? t("settings.configSaving") : t("settings.configSave")}
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
    </>
  );
}

/* ── General tab — appearance + system info only ── */
function SettingsGeneral() {
  const { t } = useTranslation();
  const { theme, toggle } = useTheme();
  const [config, setConfig] = useState<AppConfigInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [lang, setLang] = useState(getLanguage());

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="settings-loading">{t("settings.loadingSettings")}</div>
    );
  }

  return (
    <>
      {/* Appearance */}
      <section className="card settings-section">
        <h2 className="settings-section-title">{t("settings.appearance")}</h2>
        <div className="settings-appearance-grid">
          <div className="settings-appearance-item">
            <span className="stats-sys-label">{t("settings.language")}</span>
            <select
              className="memory-type-select"
              value={lang}
              onChange={(e) => {
                setLang(e.target.value);
                setLanguage(e.target.value);
              }}
            >
              <option value="en">English</option>
              <option value="zh">中文</option>
            </select>
          </div>
          <div className="settings-appearance-item">
            <span className="stats-sys-label">{t("settings.theme")}</span>
            <select
              className="memory-type-select"
              value={theme}
              onChange={(e) => {
                if (e.target.value !== theme) toggle();
              }}
            >
              <option value="dark">{t("settings.themeDark")}</option>
              <option value="light">{t("settings.themeLight")}</option>
            </select>
          </div>
        </div>
      </section>

      {/* System Info */}
      {config && (
        <section className="card settings-section">
          <h2 className="settings-section-title">
            {t("settings.configTitle")}
          </h2>
          <div
            className="stats-system-info"
            style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}
          >
            <span className="stats-sys-item">
              <span className="stats-sys-label">{t("settings.provider")}</span>
              <code>{config.provider}</code>
            </span>
            {config.model && (
              <span className="stats-sys-item">
                <span className="stats-sys-label">{t("settings.model")}</span>
                <code className="model-name">{config.model}</code>
              </span>
            )}
            <span className="stats-sys-item">
              <span className="stats-sys-label">{t("settings.db")}</span>
              <code>{config.databasePath}</code>
            </span>
            <span className="stats-sys-item">
              <span className="stats-sys-label">
                {t("settings.skillsLabel")}
              </span>
              <code>{config.skillsDir}</code>
            </span>
          </div>
        </section>
      )}
    </>
  );
}

/* ── Tools tab ── */
function SettingsTools() {
  const { t } = useTranslation();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listTools()
      .then(setTools)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="settings-loading">{t("settings.loadingSettings")}</div>
    );
  }

  return (
    <section className="card settings-section">
      <h2 className="settings-section-title">
        {t("settings.tools")}
        <span className="settings-count">{tools.length}</span>
      </h2>
      <div className="tools-list">
        {tools.map((tool) => (
          <div key={tool.name} className="tool-item">
            <div className="tool-header">
              <span className="tool-name">{tool.name}</span>
              <span className="badge badge-info">{tool.category}</span>
            </div>
            <div className="tool-description">{tool.description}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Settings Shell ── */
export function SettingsPage() {
  const { t } = useTranslation();
  const { tab } = useParams<{ tab?: string }>();
  const activeTab = tab || "general";

  const renderContent = () => {
    switch (activeTab) {
      case "general":
        return <SettingsGeneral />;
      case "model":
        return <SettingsModel />;
      case "channels":
        return (
          <div className="settings-embed">
            <ChannelsPage />
          </div>
        );
      case "agents":
        return (
          <div className="settings-embed">
            <AgentsPage />
          </div>
        );
      case "subagents":
        return (
          <div className="settings-embed">
            <SubagentsPage />
          </div>
        );
      case "tools":
        return <SettingsTools />;
      case "memory":
        return (
          <div className="settings-embed">
            <MemoryPage />
          </div>
        );
      case "traces":
        return (
          <div className="settings-embed">
            <TracesPage />
          </div>
        );
      case "skills":
        return (
          <div className="settings-embed">
            <SkillsPage />
          </div>
        );
      case "api":
        return (
          <div className="settings-embed">
            <ApiPage />
          </div>
        );
      default:
        return <SettingsGeneral />;
    }
  };

  return (
    <>
      <PageHeader>{t("settings.title")}</PageHeader>
      <div className="settings-layout">
        <nav className="settings-menu">
          {TABS.map((item) => (
            <NavLink
              key={item.id}
              to={item.id === "general" ? "/settings" : `/settings/${item.id}`}
              end={item.id === "general"}
              className={({ isActive }) =>
                `settings-menu-item${isActive ? " active" : ""}`
              }
            >
              <item.icon size={16} />
              <span>{t(`settings.tabs.${item.id}`)}</span>
            </NavLink>
          ))}
        </nav>
        <div className="settings-content">{renderContent()}</div>
      </div>
    </>
  );
}
