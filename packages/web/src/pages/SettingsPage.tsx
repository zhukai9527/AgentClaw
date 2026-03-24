import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, NavLink, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/PageHeader";
import { useTheme } from "../components/ThemeProvider";
import {
  getConfig,
  getStats,
  listTools,
  setToolDisabled,
  updateAppConfig,
  validateApiKey,
  testSearchEngine,
  type AppConfigInfo,
  type UsageStatsInfo,
  type ToolInfo,
  type ProviderInstance,
  type SearchEngineConfig,
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
  IconInfo,
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

/* ── Icon for Search (magnifying glass) ── */
function IconSearch({ size = 16 }: { size?: number }) {
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
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

const TABS = [
  { id: "general", icon: IconSettings },
  { id: "model", icon: IconModel },
  { id: "search", icon: IconSearch },
  { id: "channels", icon: IconChannels },
  { id: "agents", icon: IconAgents },
  { id: "tools", icon: IconTools },
  { id: "skills", icon: IconSkills },
  { id: "divider" },
  { id: "subagents", icon: IconSubAgents },
  { id: "memory", icon: IconMemory },
  { id: "traces", icon: IconTraces },
  { id: "api", icon: IconApi },
  { id: "about", icon: IconInfo },
] as const;

/** 判断脱敏值是否已被修改（非 "****xxxx" 格式或空） */
function isMaskedValue(value: string | undefined): boolean {
  if (!value) return false;
  return value.startsWith("****");
}

/* ── Provider 预设模板（用于 "添加" 流程） ── */
interface ProviderPreset {
  id: string;
  type: "openai" | "claude" | "gemini";
  name: string;
  baseUrl?: string;
  modelPlaceholder: string;
  keyPlaceholder: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    type: "openai",
    name: "OpenAI",
    modelPlaceholder: "gpt-4o",
    keyPlaceholder: "sk-...",
  },
  {
    id: "anthropic",
    type: "claude",
    name: "Anthropic",
    modelPlaceholder: "claude-sonnet-4-20250514",
    keyPlaceholder: "sk-ant-...",
  },
  {
    id: "gemini",
    type: "gemini",
    name: "Google Gemini",
    modelPlaceholder: "gemini-2.0-flash",
    keyPlaceholder: "AIza...",
  },
  {
    id: "deepseek",
    type: "openai",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    modelPlaceholder: "deepseek-chat",
    keyPlaceholder: "sk-...",
  },
  {
    id: "qwen",
    type: "openai",
    name: "Qwen (通义千问)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelPlaceholder: "qwen-plus",
    keyPlaceholder: "sk-...",
  },
  {
    id: "kimi",
    type: "openai",
    name: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/v1",
    modelPlaceholder: "moonshot-v1-8k",
    keyPlaceholder: "sk-...",
  },
  {
    id: "zhipu",
    type: "openai",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelPlaceholder: "glm-4-flash",
    keyPlaceholder: "...",
  },
  {
    id: "volcengine",
    type: "openai",
    name: "火山引擎 (豆包)",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    modelPlaceholder: "doubao-1.5-pro-32k",
    keyPlaceholder: "...",
  },
  {
    id: "ollama",
    type: "openai",
    name: "Ollama (Local)",
    baseUrl: "http://localhost:11434/v1",
    modelPlaceholder: "llama3",
    keyPlaceholder: "ollama",
  },
  {
    id: "custom",
    type: "openai",
    name: "Custom OpenAI Compatible",
    modelPlaceholder: "model-name",
    keyPlaceholder: "sk-...",
  },
];

/* ── Model tab — left-right split: provider list + config form + usage stats ── */
function SettingsModel() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isSetup = searchParams.get("setup") === "1";
  const [config, setConfig] = useState<AppConfigInfo | null>(null);
  const [stats, setStats] = useState<UsageStatsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const savedProviders = config?.providers || [];

  /**
   * 合并视图：预设 provider 全部列出 + config 中的自定义 provider。
   * 预设按 PROVIDER_PRESETS 顺序，自定义的追加在后面。
   * "custom" 预设不在列表中显示（它只作为"添加自定义"的模板）。
   */
  const displayPresets = PROVIDER_PRESETS.filter((pr) => pr.id !== "custom");
  const mergedProviders: { inst: ProviderInstance; preset: ProviderPreset }[] =
    displayPresets.map((pr) => {
      const existing = savedProviders.find((p) => p.id === pr.id);
      return {
        inst: existing || {
          id: pr.id,
          type: pr.type,
          name: pr.name,
          baseUrl: pr.baseUrl,
          enabled: false,
        },
        preset: pr,
      };
    });
  // Append custom providers (not matching any preset id)
  const presetIds = new Set(displayPresets.map((pr) => pr.id));
  const customProviders = savedProviders.filter((p) => !presetIds.has(p.id));
  const customPreset = PROVIDER_PRESETS.find((pr) => pr.id === "custom")!;
  for (const cp of customProviders) {
    mergedProviders.push({ inst: cp, preset: customPreset });
  }

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
      // Auto-select active provider or first preset
      const currentSelectedId = selectedIdRef.current;
      if (
        !currentSelectedId ||
        !mergedProviders.find((m) => m.inst.id === currentSelectedId)
      ) {
        const active = configData.activeProvider || configData.provider;
        setSelectedId(active || displayPresets[0]?.id || null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  /** Toggle provider enabled on/off — 同时确保 provider 存在于 config.providers */
  const handleToggle = async (inst: ProviderInstance, pr: ProviderPreset) => {
    if (!config || togglingId) return;
    setTogglingId(inst.id);
    try {
      const exists = savedProviders.find((p) => p.id === inst.id);
      let updated: ProviderInstance[];
      if (exists) {
        updated = savedProviders.map((p) =>
          p.id === inst.id ? { ...p, enabled: !p.enabled } : p,
        );
      } else {
        // 预设 provider 首次启用——添加到 config
        updated = [
          ...savedProviders,
          { ...inst, baseUrl: pr.baseUrl, enabled: true },
        ];
      }
      const activeProvider = !inst.enabled ? inst.id : config.activeProvider;
      await updateAppConfig({
        providers: updated,
        activeProvider,
      } as Partial<AppConfigInfo>);
      await fetchAll();
    } catch {
      // ignore
    } finally {
      setTogglingId(null);
    }
  };

  /** Add a custom provider */
  const handleAddCustom = async () => {
    let newId = "custom";
    const existingIds = new Set(savedProviders.map((p) => p.id));
    let i = 1;
    while (existingIds.has(newId)) {
      i++;
      newId = `custom-${i}`;
    }
    const newInst: ProviderInstance = {
      id: newId,
      type: "openai",
      name: `Custom ${i > 1 ? i : ""}`.trim(),
      enabled: false,
    };
    const updated = [...savedProviders, newInst];
    try {
      await updateAppConfig({ providers: updated } as Partial<AppConfigInfo>);
      setSelectedId(newId);
      await fetchAll();
    } catch {
      // ignore
    }
  };

  /** Delete a custom provider (only for non-preset providers) */
  const handleDeleteCustom = async (id: string) => {
    const updated = savedProviders.filter((p) => p.id !== id);
    const activeProvider =
      config?.activeProvider === id
        ? updated.find((p) => p.enabled)?.id || undefined
        : config?.activeProvider;
    try {
      await updateAppConfig({
        providers: updated,
        activeProvider,
      } as Partial<AppConfigInfo>);
      if (selectedId === id) setSelectedId(displayPresets[0]?.id || null);
      await fetchAll();
    } catch {
      // ignore
    }
  };

  if (loading) {
    return (
      <div className="settings-loading">{t("settings.loadingSettings")}</div>
    );
  }

  const selectedEntry = mergedProviders.find((m) => m.inst.id === selectedId);
  const isCustom = selectedEntry ? !presetIds.has(selectedEntry.inst.id) : false;

  return (
    <>
      {isSetup && (
        <div
          className="settings-setup-hint"
          onClick={() => setSearchParams({})}
        >
          {t("settings.setupHint", "请先配置至少一个 AI 模型才能开始对话")}
        </div>
      )}
      {error && <div className="settings-error">{error}</div>}

      {/* Provider split layout */}
      <div className="model-split">
        {/* Left: provider list */}
        <div className="model-list">
          {mergedProviders.map(({ inst }) => {
            const selected = selectedId === inst.id;
            const toggling = togglingId === inst.id;
            const hasKey = !!inst.apiKey;
            const isPrimary =
              config?.activeProvider === inst.id && hasKey && inst.enabled;
            const canToggle = hasKey;
            return (
              <div
                key={inst.id}
                className={`model-list-item${selected ? " active" : ""}`}
                onClick={() => setSelectedId(inst.id)}
              >
                <div className="model-list-info">
                  <span className="model-list-name">{inst.name}</span>
                  {isPrimary && (
                    <span className="model-primary-badge">
                      {t("settings.primary")}
                    </span>
                  )}
                </div>
                <div
                  className={`channels-toggle${inst.enabled ? " on" : ""}${toggling ? " loading" : ""}${!canToggle ? " disabled" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (canToggle) {
                      const pr = mergedProviders.find((m) => m.inst.id === inst.id)!.preset;
                      handleToggle(inst, pr);
                    }
                  }}
                >
                  <div className="channels-toggle-knob" />
                </div>
              </div>
            );
          })}
          {/* Add custom provider */}
          <div className="model-add-wrapper">
            <button className="model-add-btn" onClick={handleAddCustom}>
              + {t("settings.addCustomProvider")}
            </button>
          </div>
        </div>

        {/* Right: config form for selected provider */}
        <div className="model-detail">
          {selectedEntry ? (
            <ProviderConfigForm
              inst={selectedEntry.inst}
              preset={selectedEntry.preset}
              providers={savedProviders}
              activeProvider={config?.activeProvider}
              onSaved={fetchAll}
              onDelete={isCustom ? () => handleDeleteCustom(selectedEntry.inst.id) : undefined}
            />
          ) : (
            <div className="settings-empty">{t("settings.selectProvider")}</div>
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
  inst,
  preset,
  providers,
  activeProvider,
  onSaved,
  onDelete,
}: {
  inst: ProviderInstance;
  preset: ProviderPreset;
  providers: ProviderInstance[];
  activeProvider?: string;
  onSaved: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState(inst.name);
  const [model, setModel] = useState(inst.model || "");
  const [baseUrl, setBaseUrl] = useState(inst.baseUrl || "");
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
    setName(inst.name);
    setModel(inst.model || "");
    setBaseUrl(inst.baseUrl || "");
    setSaveMsg(null);
    setValidateMsg(null);
  }, [inst.id]);

  const configured = !!inst.apiKey;
  const isActive = activeProvider === inst.id;
  const showBaseUrl = inst.type === "openai";

  const hasChanges = (() => {
    if (apiKey && !isMaskedValue(apiKey)) return true;
    if (name !== inst.name) return true;
    if (model !== (inst.model || "")) return true;
    if (showBaseUrl && baseUrl !== (inst.baseUrl || "")) return true;
    return false;
  })();

  const handleValidate = async () => {
    const keyToValidate = apiKey || inst.apiKey;
    if (!keyToValidate || isMaskedValue(keyToValidate)) {
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
      } = { provider: inst.type, apiKey: keyToValidate };
      if (showBaseUrl && baseUrl) params.baseUrl = baseUrl;
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
      const updatedInst: ProviderInstance = {
        ...inst,
        name: name || inst.name,
        model: model || undefined,
        baseUrl: showBaseUrl ? baseUrl || undefined : inst.baseUrl,
      };
      // Only update apiKey if user typed a new non-masked value
      if (apiKey && !isMaskedValue(apiKey)) {
        updatedInst.apiKey = apiKey;
      }
      // If this preset doesn't exist in saved providers yet, add it
      const exists = providers.find((p) => p.id === inst.id);
      const updatedProviders = exists
        ? providers.map((p) => (p.id === inst.id ? updatedInst : p))
        : [...providers, updatedInst];
      await updateAppConfig({
        providers: updatedProviders,
      } as Partial<AppConfigInfo>);
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
        <h3 className="model-detail-title">{inst.name}</h3>
        <span
          className={`channels-status-badge${configured ? " configured" : ""}`}
        >
          {configured
            ? t("settings.providerConnected")
            : t("settings.providerNotSet")}
        </span>
        {isActive ? (
          <span className="model-primary-badge">{t("settings.primary")}</span>
        ) : (
          inst.enabled &&
          configured && (
            <button
              className="btn btn-sm"
              onClick={async () => {
                await updateAppConfig({
                  activeProvider: inst.id,
                } as Partial<AppConfigInfo>);
                onSaved();
              }}
            >
              {t("settings.setAsPrimary")}
            </button>
          )
        )}
      </div>

      <div className="channels-detail-form">
        {/* Display Name */}
        <div className="channels-detail-field">
          <label className="channels-detail-label">
            {t("settings.displayName")}
          </label>
          <input
            type="text"
            className="config-input"
            placeholder={preset.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {/* API Key */}
        <div className="channels-detail-field">
          <label className="channels-detail-label">API Key</label>
          <input
            type="password"
            className="config-input"
            placeholder={inst.apiKey || preset.keyPlaceholder}
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

        {/* Base URL (OpenAI-compatible only) */}
        {showBaseUrl && (
          <div className="channels-detail-field">
            <label className="channels-detail-label">Base URL</label>
            <input
              type="text"
              className="config-input"
              placeholder={preset.baseUrl || "https://api.openai.com/v1"}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
        )}

        {/* Model */}
        <div className="channels-detail-field">
          <label className="channels-detail-label">{t("settings.model")}</label>
          <input
            type="text"
            className="config-input"
            placeholder={preset.modelPlaceholder}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>

        {/* Actions */}
        <div className="channels-detail-actions">
          <button
            className="btn btn-primary"
            disabled={!hasChanges || saving}
            onClick={handleSave}
          >
            {saving ? t("settings.configSaving") : t("settings.configSave")}
          </button>
          {onDelete && (
            <button
              className="btn btn-danger"
              onClick={onDelete}
              disabled={isActive}
              title={isActive ? t("settings.cannotDeleteActive") : ""}
            >
              {t("settings.delete")}
            </button>
          )}
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

/* ── Search tab — search engine list with enable/disable + config ── */
function SettingsSearch() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<AppConfigInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [localEngines, setLocalEngines] = useState<SearchEngineConfig[]>([]);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; error?: string } | null>>({});

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      const cfg = await getConfig();
      setConfig(cfg);
      setLocalEngines(cfg.searchEngines || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const hasChanges = JSON.stringify(localEngines) !== JSON.stringify(config?.searchEngines || []);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await updateAppConfig({ searchEngines: localEngines } as Partial<AppConfigInfo>);
      setSaveMsg(t("settings.configSaved"));
      await fetchConfig();
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : t("settings.configSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const updateEngine = (id: string, updates: Partial<SearchEngineConfig>) => {
    setLocalEngines((prev) =>
      prev.map((e) => (e.id === id ? { ...e, ...updates } : e)),
    );
  };

  const BUILTIN_IDS = new Set(["searxng", "serper", "querit"]);

  const addCustomEngine = () => {
    const id = `custom-${Date.now()}`;
    setLocalEngines((prev) => [
      ...prev,
      { id, type: "custom" as const, name: "", enabled: false, url: "", apiKey: "" },
    ]);
  };

  const removeEngine = (id: string) => {
    setLocalEngines((prev) => prev.filter((e) => e.id !== id));
  };

  // Drag state for reordering
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const handleDragStart = (idx: number) => setDragIdx(idx);

  const handleDrop = (targetIdx: number) => {
    if (dragIdx === null || dragIdx === targetIdx) return;
    setLocalEngines((prev) => {
      const items = [...prev];
      const [moved] = items.splice(dragIdx, 1);
      items.splice(targetIdx, 0, moved);
      return items;
    });
    setDragIdx(null);
  };

  /** Helper URLs for built-in engines */
  const engineInfoUrl: Record<string, string> = {
    searxng: "https://github.com/searxng/searxng",
    serper: "https://serper.dev",
    querit: "https://querit.ai",
  };

  /** Default URLs for engines that have them */
  const defaultUrls: Record<string, string> = {
    searxng: "http://localhost:8888",
    serper: "https://google.serper.dev/search",
    querit: "https://api.querit.ai/v1/search",
  };

  /** Whether an engine needs an API key */
  const needsApiKey = (type: string) => type !== "searxng";

  const handleTest = async (engine: typeof localEngines[0]) => {
    setTestingId(engine.id);
    setTestResults((prev) => ({ ...prev, [engine.id]: null }));
    try {
      const result = await testSearchEngine({
        type: engine.type,
        url: engine.url,
        apiKey: engine.apiKey,
      });
      setTestResults((prev) => ({ ...prev, [engine.id]: result }));
    } catch {
      setTestResults((prev) => ({ ...prev, [engine.id]: { success: false, error: "Request failed" } }));
    }
    setTestingId(null);
  };

  if (loading) {
    return <div className="settings-loading">{t("settings.loadingSettings")}</div>;
  }

  return (
    <section className="card settings-section">
      <h2 className="settings-section-title">{t("settings.search.title")}</h2>
      <p className="settings-hint" style={{ color: "var(--text-secondary)", fontSize: 13, margin: "0 0 16px" }}>
        {t("settings.search.hint")}
      </p>

      <div className="search-engines-list">
        {localEngines.map((engine, idx) => {
          const isConfigured = engine.type === "searxng" || engine.type === "custom"
            ? !!engine.url
            : !!engine.apiKey;
          const isBuiltin = BUILTIN_IDS.has(engine.id);
          const infoUrl = engineInfoUrl[engine.type];
          return (
            <div
              key={engine.id}
              className={`search-engine-card${dragIdx === idx ? " dragging" : ""}`}
              draggable
              onDragStart={() => handleDragStart(idx)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(idx)}
            >
              <div className="search-engine-header">
                <span className="search-engine-drag">⠿</span>
                <span className="search-engine-priority">{idx + 1}</span>
                {engine.type === "custom" ? (
                  <input
                    type="text"
                    className="search-engine-name-input"
                    placeholder={t("settings.search.customName")}
                    value={engine.name}
                    onChange={(e) => updateEngine(engine.id, { name: e.target.value })}
                  />
                ) : (
                  <span className="search-engine-name">
                    {engine.name}
                    {infoUrl && (
                      <a href={infoUrl} target="_blank" rel="noopener noreferrer" className="search-engine-info-link" title={infoUrl}>↗</a>
                    )}
                  </span>
                )}
                <span
                  className={`channels-status-badge${isConfigured ? " configured" : ""}`}
                >
                  {isConfigured
                    ? t("settings.search.configured")
                    : t("settings.search.notConfigured")}
                </span>
                {!isBuiltin && (
                  <button
                    className="search-engine-delete"
                    title={t("settings.delete")}
                    onClick={() => removeEngine(engine.id)}
                  >×</button>
                )}
                <div
                  className={`channels-toggle${engine.enabled ? " on" : ""}`}
                  onClick={() =>
                    updateEngine(engine.id, { enabled: !engine.enabled })
                  }
                >
                  <div className="channels-toggle-knob" />
                </div>
              </div>

              <div className="search-engine-fields">
                <div className="channels-detail-field">
                  <label className="channels-detail-label">
                    {t("settings.search.url")}
                  </label>
                  <input
                    type="text"
                    className="config-input"
                    placeholder={defaultUrls[engine.type] || "https://..."}
                    value={engine.url || ""}
                    onChange={(e) =>
                      updateEngine(engine.id, { url: e.target.value })
                    }
                  />
                </div>
                {needsApiKey(engine.type) && (
                  <div className="channels-detail-field">
                    <label className="channels-detail-label">
                      {t("settings.search.apiKey")}
                    </label>
                    <input
                      type="password"
                      className="config-input"
                      placeholder={engine.apiKey || "sk-..."}
                      value={engine.apiKey || ""}
                      onChange={(e) =>
                        updateEngine(engine.id, { apiKey: e.target.value })
                      }
                    />
                  </div>
                )}
                <div className="search-engine-test-row">
                  <button
                    className="search-test-btn"
                    onClick={() => handleTest(engine)}
                    disabled={testingId === engine.id || (engine.type !== "serper" && !engine.url)}
                  >
                    {testingId === engine.id ? "testing..." : "test"}
                  </button>
                  {testResults[engine.id] && (
                    <span className={testResults[engine.id]!.success ? "search-test-ok" : "search-test-fail"}>
                      {testResults[engine.id]!.success ? "\u2713" : `\u2717 ${testResults[engine.id]!.error || "failed"}`}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="channels-detail-actions" style={{ marginTop: 16 }}>
        <button className="btn btn-secondary" onClick={addCustomEngine} style={{ marginRight: 8 }}>
          + {t("settings.search.addCustom")}
        </button>
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
    </section>
  );
}

/* ── Tools tab ── */
function SettingsTools() {
  const { t } = useTranslation();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingTool, setTogglingTool] = useState<string | null>(null);

  useEffect(() => {
    listTools()
      .then(setTools)
      .finally(() => setLoading(false));
  }, []);

  const handleToggle = async (name: string, currentDisabled: boolean) => {
    setTogglingTool(name);
    try {
      await setToolDisabled(name, !currentDisabled);
      setTools((prev) =>
        prev.map((t) =>
          t.name === name ? { ...t, disabled: !currentDisabled } : t,
        ),
      );
    } catch {
      // ignore
    }
    setTogglingTool(null);
  };

  if (loading) {
    return (
      <div className="settings-loading">{t("settings.loadingSettings")}</div>
    );
  }

  const enabled = tools.filter((t) => !t.disabled);
  const disabled = tools.filter((t) => t.disabled);

  return (
    <section className="card settings-section">
      <h2 className="settings-section-title">
        {t("settings.tools")}
        <span className="settings-count">
          {enabled.length}/{tools.length}
        </span>
      </h2>
      <div className="tools-list">
        {[...enabled, ...disabled].map((tool) => (
          <div
            key={tool.name}
            className={`tool-item${tool.disabled ? " tool-disabled" : ""}`}
          >
            <div className="tool-header">
              <span className="tool-name">{tool.name}</span>
              <span className="badge badge-info">{tool.category}</span>
              <label className="toggle-switch tool-toggle">
                <input
                  type="checkbox"
                  checked={!tool.disabled}
                  disabled={togglingTool === tool.name}
                  onChange={() => handleToggle(tool.name, !!tool.disabled)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <div className="tool-description">{tool.description}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── About ── */
const APP_VERSION = "1.4.1";

function SettingsAbout() {
  const { t } = useTranslation();
  return (
    <div className="settings-about">
      <img src="/favicon.png" alt="AgentClaw" className="settings-about-icon" />
      <h2 className="settings-about-name">AgentClaw</h2>
      <span className="settings-about-version">v{APP_VERSION}</span>
      <table className="settings-about-table">
        <tbody>
          <tr>
            <td>{t("settings.about.version")}</td>
            <td>{APP_VERSION}</td>
          </tr>
          <tr>
            <td>{t("settings.about.github")}</td>
            <td>
              <a
                href="https://github.com/vorojar/AgentClaw"
                target="_blank"
                rel="noopener noreferrer"
              >
                https://github.com/vorojar/AgentClaw
              </a>
            </td>
          </tr>
          <tr>
            <td>{t("settings.about.license")}</td>
            <td>MIT</td>
          </tr>
        </tbody>
      </table>
      <div className="settings-about-copyright">© 2026 AgentClaw</div>
    </div>
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
      case "search":
        return <SettingsSearch />;
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
      case "about":
        return <SettingsAbout />;
      default:
        return <SettingsGeneral />;
    }
  };

  return (
    <>
      <PageHeader>{t("settings.title")}</PageHeader>
      <div className="settings-layout">
        <nav className="settings-menu">
          {TABS.map((item) =>
            item.id === "divider" ? (
              <hr key="divider" className="settings-menu-divider" />
            ) : (
              <NavLink
                key={item.id}
                to={item.id === "general" ? "/settings" : `/settings/${item.id}`}
                end={item.id === "general"}
                className={({ isActive }) =>
                  `settings-menu-item${isActive ? " active" : ""}`
                }
              >
                {item.icon && <item.icon size={16} />}
                <span>{t(`settings.tabs.${item.id}`)}</span>
              </NavLink>
            ),
          )}
        </nav>
        <div className="settings-content">{renderContent()}</div>
      </div>
    </>
  );
}
