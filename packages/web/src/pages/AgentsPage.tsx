import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import {
  listAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  getConfig,
  createAgentApiKey,
  listAgentApiKeys,
  deleteAgentApiKey,
  type AgentInfo,
  type AgentApiKeyInfo,
  type FileSourceConfigInfo,
  type HttpApiConfigInfo,
  type KnowledgeSourceInfo,
  type ProviderInstance,
} from "../api/client";
import "./AgentsPage.css";

const EMOJI_PRESETS = [
  "🤖",
  "💻",
  "✍️",
  "🔬",
  "🎨",
  "📊",
  "🧠",
  "🎯",
  "🌐",
  "📚",
  "🛠️",
  "🎭",
  "🏢",
  "💡",
  "🔥",
];

interface AgentFormData {
  name: string;
  description: string;
  avatar: string;
  soul: string;
  model: string;
  temperature: string;
  maxIterations: string;
}

const emptyForm: AgentFormData = {
  name: "",
  description: "",
  avatar: "🤖",
  soul: "",
  model: "",
  temperature: "",
  maxIterations: "",
};

function agentToForm(a: AgentInfo): AgentFormData {
  return {
    name: a.name,
    description: a.description,
    avatar: a.avatar || "🤖",
    soul: a.soul ?? "",
    model: a.model ?? "",
    temperature: a.temperature !== undefined ? String(a.temperature) : "",
    maxIterations: a.maxIterations !== undefined ? String(a.maxIterations) : "",
  };
}

export function AgentsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [defaultModel, setDefaultModel] = useState("");
  const [configuredProviders, setConfiguredProviders] = useState<ProviderInstance[]>([]);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // null = create
  const [form, setForm] = useState<AgentFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHive, setShowHive] = useState(false);
  const [isPublished, setIsPublished] = useState(false);
  const [apiKeys, setApiKeys] = useState<AgentApiKeyInfo[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [justCreatedKey, setJustCreatedKey] = useState<string | null>(null);
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSourceInfo[]>([]);

  const fetchAgents = useCallback(async () => {
    try {
      setLoading(true);
      const [data, config] = await Promise.all([listAgents(), getConfig()]);
      setAgents(data);
      setDefaultModel(config.model || "");
      setConfiguredProviders((config.providers || []).filter((p) => p.enabled && p.apiKey));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setModalOpen(true);
    setEmojiPickerOpen(false);
    setShowAdvanced(false);
    setShowHive(false);
    setIsPublished(false);
    setApiKeys([]);
    setJustCreatedKey(null);
    setKnowledgeSources([]);
  };

  const openEdit = async (agent: AgentInfo) => {
    setEditingId(agent.id);
    setForm(agentToForm(agent));
    setModalOpen(true);
    setEmojiPickerOpen(false);
    setShowAdvanced(!!(agent.temperature !== undefined || agent.maxIterations !== undefined));
    setIsPublished(agent.isPublished ?? false);
    setKnowledgeSources(agent.knowledgeSources ?? []);
    setJustCreatedKey(null);
    // Show Hive section if agent has any Hive config
    const hasHive = !!(agent.isPublished || agent.apiKeys?.length || agent.knowledgeSources?.length);
    setShowHive(hasHive);
    // Load API keys (masked)
    if (agent.id !== "default") {
      try {
        const keys = await listAgentApiKeys(agent.id);
        setApiKeys(keys);
      } catch {
        setApiKeys([]);
      }
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingId(null);
    setEmojiPickerOpen(false);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setError(t('agents.nameRequired'));
      return;
    }
    setSaving(true);
    try {
      const agentId = editingId ?? form.name.trim().toLowerCase().replace(/\s+/g, "-");
      const payload: AgentInfo = {
        id: agentId,
        name: form.name.trim(),
        description: form.description.trim(),
        avatar: form.avatar,
        soul: form.soul,
        model: form.model || undefined,
        temperature: form.temperature ? Number(form.temperature) : undefined,
        maxIterations: form.maxIterations
          ? Number(form.maxIterations)
          : undefined,
        isPublished: isPublished || undefined,
        knowledgeSources: knowledgeSources.length > 0 ? knowledgeSources : undefined,
      };
      if (editingId) {
        await updateAgent(editingId, payload);
      } else {
        await createAgent(payload);
      }
      closeModal();
      await fetchAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save agent");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (agent: AgentInfo) => {
    if (agent.id === "default") return;
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    try {
      await deleteAgent(agent.id);
      setAgents((prev) => prev.filter((a) => a.id !== agent.id));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete agent",
      );
    }
  };

  const updateField = (field: keyof AgentFormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  if (loading) {
    return (
      <>
        <PageHeader>{t('agents.title')}</PageHeader>
        <div className="page-body">
          <div className="agents-loading">{t('agents.loadingAgents')}</div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader>{t('agents.title')}</PageHeader>
      <div className="page-body">
        {error && (
          <div className="agents-error">
            {error}
            <button onClick={() => setError(null)}>{t('common.dismiss')}</button>
          </div>
        )}

        {/* Toolbar */}
        <div className="agents-toolbar">
          <span className="agents-count">{t('agents.agentsCount', { count: agents.length })}</span>
          <button className="btn-primary agents-add-btn" onClick={openCreate}>
            {t('agents.newAgent')}
          </button>
        </div>

        {/* Agent cards */}
        {agents.length === 0 ? (
          <div className="agents-empty">{t('agents.noAgents')}</div>
        ) : (
          <div className="agents-grid">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className={`agent-card${agent.id === "default" ? " agent-card-default" : ""}`}
                onClick={() => navigate(`/agents/${agent.id}`)}
              >
                <div className="agent-card-top">
                  <span className="agent-card-avatar">
                    {agent.avatar || "🤖"}
                  </span>
                  {agent.id !== "default" && (
                    <button
                      className="agent-card-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(agent);
                      }}
                      title={t('common.delete')}
                    >
                      &times;
                    </button>
                  )}
                </div>
                <div className="agent-card-name">{agent.name}</div>
                <div className="agent-card-desc">
                  {agent.description || t('agents.noDescription')}
                </div>
                {agent.model && (
                  <code className="agent-card-model">{agent.model}</code>
                )}
                {agent.isPublished && (
                  <span className="agent-card-badge">API</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Modal */}
        {modalOpen && (
          <div className="agents-modal-backdrop" onClick={closeModal}>
            <div
              className="agents-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="agents-modal-header">
                <h3>{editingId ? t('agents.editAgent') : t('agents.createAgent')}</h3>
                <button className="agents-modal-close" onClick={closeModal}>
                  &times;
                </button>
              </div>

              <div className="agents-modal-body">
                {/* Avatar + Name row */}
                <div className="agents-form-row agents-form-identity">
                  <div className="agents-avatar-picker">
                    <button
                      className="agents-avatar-btn"
                      onClick={() => setEmojiPickerOpen((v) => !v)}
                      title={t('agents.pickAvatar')}
                    >
                      {form.avatar || "🤖"}
                    </button>
                    {emojiPickerOpen && (
                      <div className="agents-emoji-grid">
                        {EMOJI_PRESETS.map((e) => (
                          <button
                            key={e}
                            className={`agents-emoji-item${form.avatar === e ? " active" : ""}`}
                            onClick={() => {
                              updateField("avatar", e);
                              setEmojiPickerOpen(false);
                            }}
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="agents-form-name-group">
                    <input
                      type="text"
                      placeholder={t('agents.agentName')}
                      value={form.name}
                      onChange={(e) => updateField("name", e.target.value)}
                      className="agents-input agents-input-name"
                      autoFocus
                    />
                  </div>
                </div>

                {/* Description */}
                <div className="agents-form-row">
                  <label className="agents-label">{t('agents.description')}</label>
                  <input
                    type="text"
                    placeholder={t('agents.descPlaceholder')}
                    value={form.description}
                    onChange={(e) =>
                      updateField("description", e.target.value)
                    }
                    className="agents-input"
                  />
                </div>

                {/* Soul */}
                <div className="agents-form-row">
                  <label className="agents-label">
                    {t('agents.soul')}
                    <span className="agents-label-hint">
                      {t('agents.soulHint')}
                    </span>
                  </label>
                  <textarea
                    placeholder={t('agents.soulPlaceholder')}
                    value={form.soul}
                    onChange={(e) => updateField("soul", e.target.value)}
                    className="agents-textarea"
                    rows={6}
                  />
                </div>

                {/* Model */}
                <div className="agents-form-row">
                  <label className="agents-label">{t('agents.model')}</label>
                  <select
                    value={form.model}
                    onChange={(e) => updateField("model", e.target.value)}
                    className="agents-input"
                  >
                    <option value="">
                      {defaultModel ? `${t('agents.useSystemDefault')} (${defaultModel})` : t('agents.useSystemDefault')}
                    </option>
                    {configuredProviders.map((p) => (
                      <option key={p.id} value={p.model || p.id}>
                        {p.name}{p.model ? ` — ${p.model}` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Advanced toggle */}
                <button
                  type="button"
                  className="agents-advanced-toggle"
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? "▾" : "▸"} {t('agents.advanced')}
                </button>

                {showAdvanced && (
                  <div className="agents-form-row agents-form-inline">
                    <div className="agents-form-field">
                      <label className="agents-label">
                        {t('agents.temperature')}
                        <span className="agents-label-hint">{t('agents.temperatureHint')}</span>
                      </label>
                      <input
                        type="number"
                        placeholder="0.7"
                        min="0"
                        max="2"
                        step="0.1"
                        value={form.temperature}
                        onChange={(e) =>
                          updateField("temperature", e.target.value)
                        }
                        className="agents-input"
                      />
                    </div>
                    <div className="agents-form-field">
                      <label className="agents-label">
                        {t('agents.maxIterations')}
                        <span className="agents-label-hint">{t('agents.maxIterationsHint')}</span>
                      </label>
                      <input
                        type="number"
                        placeholder="25"
                        min="1"
                        max="100"
                        value={form.maxIterations}
                        onChange={(e) =>
                          updateField("maxIterations", e.target.value)
                        }
                        className="agents-input"
                      />
                    </div>
                  </div>
                )}

                {/* ─── Hive API Section ─── */}
                {editingId && editingId !== "default" && (
                  <>
                    <button
                      type="button"
                      className="agents-advanced-toggle"
                      onClick={() => setShowHive((v) => !v)}
                    >
                      {showHive ? "▾" : "▸"} Hive API
                    </button>

                    {showHive && (
                      <div className="agents-hive-section">
                        {/* Publish toggle */}
                        <div className="agents-form-row agents-form-inline">
                          <label className="agents-label" style={{ flex: 1 }}>
                            Published
                            <span className="agents-label-hint">Enable external API access</span>
                          </label>
                          <label className="agents-toggle">
                            <input
                              type="checkbox"
                              checked={isPublished}
                              onChange={(e) => setIsPublished(e.target.checked)}
                            />
                            <span className="agents-toggle-slider" />
                          </label>
                        </div>

                        {/* API Keys */}
                        <div className="agents-form-row">
                          <label className="agents-label">API Keys</label>
                          {apiKeys.length > 0 && (
                            <div className="agents-apikeys-list">
                              {apiKeys.map((k) => (
                                <div key={k.keyId} className="agents-apikey-row">
                                  <code className="agents-apikey-value">{k.key}</code>
                                  <span className="agents-apikey-name">{k.name}</span>
                                  <button
                                    className="agents-apikey-delete"
                                    onClick={async () => {
                                      await deleteAgentApiKey(editingId, k.keyId);
                                      setApiKeys((prev) => prev.filter((x) => x.keyId !== k.keyId));
                                    }}
                                    title="Revoke"
                                  >
                                    &times;
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          {justCreatedKey && (
                            <div className="agents-apikey-created">
                              <strong>New key (copy now, won&apos;t show again):</strong>
                              <code
                                className="agents-apikey-full"
                                onClick={() => navigator.clipboard.writeText(justCreatedKey)}
                                title="Click to copy"
                              >
                                {justCreatedKey}
                              </code>
                            </div>
                          )}
                          <div className="agents-apikey-create">
                            <input
                              type="text"
                              placeholder="Key name (e.g., production)"
                              value={newKeyName}
                              onChange={(e) => setNewKeyName(e.target.value)}
                              className="agents-input"
                              style={{ flex: 1 }}
                            />
                            <button
                              className="btn-primary"
                              disabled={!newKeyName.trim()}
                              onClick={async () => {
                                const key = await createAgentApiKey(editingId, newKeyName.trim());
                                setApiKeys((prev) => [...prev, { ...key, key: key.key.slice(0, 12) + "..." + key.key.slice(-4) }]);
                                setJustCreatedKey(key.key);
                                setNewKeyName("");
                              }}
                            >
                              Generate
                            </button>
                          </div>
                        </div>

                        {/* Knowledge Sources */}
                        <div className="agents-form-row">
                          <label className="agents-label">
                            Knowledge Sources
                            <span className="agents-label-hint">HTTP APIs the agent can query</span>
                          </label>
                          {knowledgeSources.map((ks, idx) => (
                            <div key={ks.id} className="agents-ks-card">
                              <div className="agents-ks-header">
                                <strong>{ks.name}</strong>
                                <span className="agents-ks-method">
                                  {ks.type === "http_api"
                                    ? (ks.config as HttpApiConfigInfo).method
                                    : "FILE"}
                                </span>
                                <button
                                  className="agents-apikey-delete"
                                  onClick={() => setKnowledgeSources((prev) => prev.filter((_, i) => i !== idx))}
                                >
                                  &times;
                                </button>
                              </div>
                              <code className="agents-ks-url">
                                {ks.type === "http_api"
                                  ? (ks.config as HttpApiConfigInfo).url
                                  : (ks.config as FileSourceConfigInfo).filename}
                              </code>
                              <div className="agents-ks-desc">{ks.description}</div>
                            </div>
                          ))}
                          <button
                            className="agents-ks-add"
                            onClick={() => {
                              const name = prompt("Tool name (e.g., check_inventory):");
                              if (!name) return;
                              const desc = prompt("Description (what does this API do?):");
                              if (!desc) return;
                              const url = prompt("URL (use {param} for path params):");
                              if (!url) return;
                              const method = (prompt("Method (GET/POST):", "GET") || "GET").toUpperCase() as "GET" | "POST";
                              const newKs: KnowledgeSourceInfo = {
                                id: `ks_${Date.now()}`,
                                type: "http_api",
                                name,
                                description: desc,
                                config: { url, method, parameters: [], headers: {} },
                                enabled: true,
                              };
                              setKnowledgeSources((prev) => [...prev, newKs]);
                            }}
                          >
                            + Add API Source
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="agents-modal-footer">
                <button className="agents-btn-cancel" onClick={closeModal}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn-primary agents-btn-save"
                  onClick={handleSave}
                  disabled={saving || !form.name.trim()}
                >
                  {saving ? t('common.saving') : editingId ? t('agents.saveChanges') : t('agents.createAgentBtn')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
