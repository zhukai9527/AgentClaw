import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/PageHeader";
import { IconArrowLeft } from "../components/Icons";
import { useSession } from "../components/SessionContext";
import {
  listAgents,
  updateAgent,
  getConfig,
  createAgentApiKey,
  listAgentApiKeys,
  deleteAgentApiKey,
  listTools,
  listSkills,
  createSession,
  chatInSession,
  getAgentUsage,
  type AgentUsageInfo,
  type AgentInfo,
  type AgentApiKeyInfo,
  type KnowledgeSourceInfo,
  type ToolInfo,
  type SkillInfo,
  type ProviderInstance,
} from "../api/client";
import "./AgentDetailPage.css";

type TabName = "profile" | "tools" | "knowledge" | "api" | "test";

const EMOJI_PRESETS = [
  "🤖", "💻", "✍️", "🔬", "🎨", "📊", "🧠", "🎯", "🌐", "📚",
  "🛠️", "🎭", "🏢", "💡", "🔥", "🎧", "📋", "🔍", "💬", "⚡",
];

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const d = (key: string) => t(`agents.detail.${key}`);
  const { refreshSessions } = useSession();
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<TabName>("profile");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Profile state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [avatar, setAvatar] = useState("🤖");
  const [soul, setSoul] = useState("");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState("");
  const [maxIterations, setMaxIterations] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);

  // Provider list
  const [defaultModel, setDefaultModel] = useState("");
  const [providers, setProviders] = useState<ProviderInstance[]>([]);

  // Tools & Skills state
  const [allTools, setAllTools] = useState<ToolInfo[]>([]);
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [disabledSkills, setDisabledSkills] = useState<string[]>([]);

  // Knowledge state
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSourceInfo[]>([]);

  // API state
  const [isPublished, setIsPublished] = useState(false);
  const [apiKeys, setApiKeys] = useState<AgentApiKeyInfo[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [justCreatedKey, setJustCreatedKey] = useState<string | null>(null);
  const [usage24h, setUsage24h] = useState<AgentUsageInfo | null>(null);
  const [usage7d, setUsage7d] = useState<AgentUsageInfo | null>(null);

  // Knowledge source editor state
  const [ksEditing, setKsEditing] = useState<KnowledgeSourceInfo | null>(null);
  const [ksIsNew, setKsIsNew] = useState(false);

  // Test state
  const [testInput, setTestInput] = useState("");
  const [testMessages, setTestMessages] = useState<Array<{ role: string; text: string }>>([]);
  const [testLoading, setTestLoading] = useState(false);
  const testEndRef = useRef<HTMLDivElement>(null);

  const loadAgent = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      const [agents, config, tools, skills] = await Promise.all([
        listAgents(),
        getConfig(),
        listTools(),
        listSkills(),
      ]);
      const found = agents.find((a) => a.id === id);
      if (!found) {
        navigate("/settings/agents", { replace: true });
        return;
      }
      setAgent(found);
      setName(found.name);
      setDescription(found.description);
      setAvatar(found.avatar || "🤖");
      setSoul(found.soul ?? "");
      setModel(found.model ?? "");
      setTemperature(found.temperature !== undefined ? String(found.temperature) : "");
      setMaxIterations(found.maxIterations !== undefined ? String(found.maxIterations) : "");
      setSelectedTools(found.tools ?? []);
      setDisabledSkills(found.disabledSkills ?? []);
      setKnowledgeSources(found.knowledgeSources ?? []);
      setIsPublished(found.isPublished ?? false);
      setDefaultModel(config.model || "");
      setProviders((config.providers || []).filter((p: ProviderInstance) => p.enabled && p.apiKey));
      setAllTools(tools);
      setAllSkills(skills);
      // Load API keys
      try {
        const keys = await listAgentApiKeys(id);
        setApiKeys(keys);
      } catch {
        setApiKeys([]);
      }
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agent");
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => { loadAgent(); }, [loadAgent]);

  useEffect(() => {
    testEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [testMessages]);

  // Load usage stats when API tab is active
  useEffect(() => {
    if (tab === "api" && id) {
      getAgentUsage(id, 24).then(setUsage24h).catch(() => setUsage24h(null));
      getAgentUsage(id, 168).then(setUsage7d).catch(() => setUsage7d(null));
    }
  }, [tab, id]);

  const handleSave = async () => {
    if (!agent) return;
    setSaving(true);
    setError(null);
    try {
      const payload: AgentInfo = {
        ...agent,
        name: name.trim(),
        description: description.trim(),
        avatar,
        soul,
        model: model || undefined,
        temperature: temperature ? Number(temperature) : undefined,
        maxIterations: maxIterations ? Number(maxIterations) : undefined,
        tools: selectedTools.length > 0 ? selectedTools : undefined,
        disabledSkills: disabledSkills.length > 0 ? disabledSkills : undefined,
        knowledgeSources: knowledgeSources.length > 0 ? knowledgeSources : undefined,
        isPublished: isPublished || undefined,
      };
      await updateAgent(agent.id, payload);
      setDirty(false);
      setSuccessMsg(d('saved'));
      setTimeout(() => setSuccessMsg(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const markDirty = () => setDirty(true);

  const handleTest = async () => {
    if (!testInput.trim() || !agent) return;
    const userMsg = testInput.trim();
    setTestInput("");
    setTestMessages((prev) => [...prev, { role: "user", text: userMsg }]);
    setTestLoading(true);
    try {
      const session = await createSession(agent.id);
      const data = await chatInSession(session.id, userMsg);
      const text = data.message?.content || "No response";
      setTestMessages((prev) => [...prev, { role: "assistant", text }]);
      refreshSessions();
    } catch (err) {
      setTestMessages((prev) => [
        ...prev,
        { role: "assistant", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setTestLoading(false);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader>{t('agents.title')}</PageHeader>
        <div className="page-body"><div className="agent-detail-loading">{d('loading')}</div></div>
      </>
    );
  }

  if (!agent) return null;

  const tabs: Array<{ key: TabName; label: string; icon: string }> = [
    { key: "profile", label: d('tabProfile'), icon: "👤" },
    { key: "tools", label: d('tabTools'), icon: "🛠️" },
    { key: "knowledge", label: d('tabKnowledge'), icon: "📡" },
    { key: "api", label: d('tabApi'), icon: "🔑" },
    { key: "test", label: d('tabTest'), icon: "💬" },
  ];

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <>
      <PageHeader>
        <button className="agent-detail-back" onClick={() => navigate("/settings/agents")}><IconArrowLeft size={16} /></button>
        <span className="agent-detail-avatar-header">{avatar}</span>
        <span>{name || agent.id}</span>
        {isPublished && <span className="agent-detail-badge">API</span>}
        {dirty && <span className="agent-detail-dirty">{d('unsaved')}</span>}
      </PageHeader>

      <div className="page-body agent-detail-page">
        {error && (
          <div className="agent-detail-error">
            {error}
            <button onClick={() => setError(null)}>&times;</button>
          </div>
        )}
        {successMsg && <div className="agent-detail-success">{successMsg}</div>}

        {/* Tab bar */}
        <div className="agent-detail-tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={`agent-detail-tab${tab === t.key ? " active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              <span className="agent-detail-tab-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
          <div className="agent-detail-tab-spacer" />
          {tab !== "test" && (
            <button
              className="btn-primary agent-detail-save"
              onClick={handleSave}
              disabled={saving || !name.trim()}
            >
              {saving ? d('saving') : d('save')}
            </button>
          )}
        </div>

        {/* ─── Profile Tab ─── */}
        {tab === "profile" && (
          <div className="agent-detail-content">
            <div className="agent-detail-section">
              <div className="agd-field">
                <label>{d('avatarAndName')}</label>
                <div className="agd-identity-row">
                  <div className="agd-avatar-picker">
                    <button className="agd-avatar-btn" onClick={() => setEmojiOpen((v) => !v)}>
                      {avatar}
                    </button>
                    {emojiOpen && (
                      <div className="agd-emoji-grid">
                        {EMOJI_PRESETS.map((e) => (
                          <button
                            key={e}
                            className={`agd-emoji-item${avatar === e ? " active" : ""}`}
                            onClick={() => { setAvatar(e); setEmojiOpen(false); markDirty(); }}
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <input
                    className="agd-input agd-input-name"
                    value={name}
                    onChange={(e) => { setName(e.target.value); markDirty(); }}
                    placeholder={d('namePlaceholder')}
                  />
                </div>
              </div>

              <div className="agd-field">
                <label>{d('descLabel')}</label>
                <input
                  className="agd-input"
                  value={description}
                  onChange={(e) => { setDescription(e.target.value); markDirty(); }}
                  placeholder={d('descPlaceholder')}
                />
              </div>

              <div className="agd-field">
                <label>
                  {d('soulLabel')}
                  <span className="agd-hint">{d('soulHint')}</span>
                </label>
                <textarea
                  className="agd-textarea"
                  value={soul}
                  onChange={(e) => { setSoul(e.target.value); markDirty(); }}
                  placeholder={d('soulPlaceholder')}
                  rows={12}
                />
              </div>

              <div className="agd-field">
                <label>{d('modelLabel')}</label>
                <select
                  className="agd-input"
                  value={model}
                  onChange={(e) => { setModel(e.target.value); markDirty(); }}
                >
                  <option value="">{defaultModel ? `${d('systemDefault')} (${defaultModel})` : d('systemDefault')}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.model || p.id}>
                      {p.name}{p.model ? ` — ${p.model}` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="agd-row">
                <div className="agd-field agd-field-half">
                  <label>{d('tempLabel')} <span className="agd-hint">{d('tempHint')}</span></label>
                  <input
                    className="agd-input"
                    type="number" min="0" max="2" step="0.1"
                    value={temperature}
                    onChange={(e) => { setTemperature(e.target.value); markDirty(); }}
                    placeholder="0.7"
                  />
                </div>
                <div className="agd-field agd-field-half">
                  <label>{d('maxIterLabel')} <span className="agd-hint">{d('maxIterHint')}</span></label>
                  <input
                    className="agd-input"
                    type="number" min="1" max="100"
                    value={maxIterations}
                    onChange={(e) => { setMaxIterations(e.target.value); markDirty(); }}
                    placeholder="25"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─── Tools & Skills Tab ─── */}
        {tab === "tools" && (
          <div className="agent-detail-content">
            <div className="agent-detail-section">
              <h4>{d('toolsWhitelist')}</h4>
              <p className="agd-hint-block">{d('toolsHint')}</p>
              <div className="agd-checkbox-grid">
                {allTools.map((tool) => (
                  <label key={tool.name} className="agd-checkbox-item" title={tool.description}>
                    <input
                      type="checkbox"
                      checked={selectedTools.length === 0 || selectedTools.includes(tool.name)}
                      onChange={(e) => {
                        markDirty();
                        if (selectedTools.length === 0) {
                          // Uncheck in "allow all" mode → switch to whitelist, exclude this tool
                          setSelectedTools(allTools.map((t) => t.name).filter((n) => n !== tool.name));
                        } else {
                          setSelectedTools((prev) =>
                            e.target.checked ? [...prev, tool.name] : prev.filter((n) => n !== tool.name),
                          );
                        }
                      }}
                    />
                    <span className="agd-checkbox-name">{tool.name}</span>
                    <span className="agd-checkbox-cat">{tool.category}</span>
                  </label>
                ))}
              </div>
              {selectedTools.length > 0 && (
                <button className="agd-clear-btn" onClick={() => { setSelectedTools([]); markDirty(); }}>
                  {d('clearWhitelist')}
                </button>
              )}
            </div>

            <div className="agent-detail-section">
              <h4>{d('skillsBlacklist')}</h4>
              <p className="agd-hint-block">{d('skillsHint')}</p>
              <div className="agd-checkbox-grid">
                {allSkills.map((skill) => (
                  <label key={skill.id} className="agd-checkbox-item" title={skill.description}>
                    <input
                      type="checkbox"
                      checked={disabledSkills.includes(skill.id)}
                      onChange={(e) => {
                        markDirty();
                        setDisabledSkills((prev) =>
                          e.target.checked ? [...prev, skill.id] : prev.filter((s) => s !== skill.id),
                        );
                      }}
                    />
                    <span className="agd-checkbox-name">{skill.name}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ─── Knowledge Tab ─── */}
        {tab === "knowledge" && (
          <div className="agent-detail-content">
            <div className="agent-detail-section">
              <h4>{d('knowledgeTitle')}</h4>
              <p className="agd-hint-block">{d('knowledgeHint')}</p>

              {/* Source list */}
              {!ksEditing && (
                <>
                  {knowledgeSources.map((ks, idx) => (
                    <div key={ks.id} className="agd-ks-card">
                      <div className="agd-ks-header">
                        <span className="agd-ks-method">{ks.config.method}</span>
                        <strong>{ks.name}</strong>
                        <div className="agd-ks-actions">
                          <button className="agd-ks-edit-btn" onClick={() => { setKsEditing(ks); setKsIsNew(false); }}>
                            ✎
                          </button>
                          <label className="agd-ks-toggle">
                            <input type="checkbox" checked={ks.enabled} onChange={(e) => {
                              markDirty();
                              setKnowledgeSources((prev) => prev.map((s, i) => i === idx ? { ...s, enabled: e.target.checked } : s));
                            }} />
                            <span className="agents-toggle-slider" />
                          </label>
                          <button className="agd-ks-delete" onClick={() => { setKnowledgeSources((prev) => prev.filter((_, i) => i !== idx)); markDirty(); }}>
                            &times;
                          </button>
                        </div>
                      </div>
                      <code className="agd-ks-url">{ks.config.url}</code>
                      <div className="agd-ks-desc">{ks.description}</div>
                      {ks.config.parameters.length > 0 && (
                        <div className="agd-ks-params">
                          {ks.config.parameters.map((p) => (
                            <span key={p.name} className="agd-ks-param">
                              {p.name}{p.required ? "*" : ""}: {p.type} ({p.in})
                            </span>
                          ))}
                        </div>
                      )}
                      {ks.config.responseMapping && (
                        <div className="agd-ks-mapping">→ {ks.config.responseMapping}</div>
                      )}
                    </div>
                  ))}
                  <button className="agd-ks-add" onClick={() => {
                    setKsEditing({
                      id: `ks_${Date.now()}`,
                      type: "http_api",
                      name: "",
                      description: "",
                      config: { url: "", method: "GET", parameters: [], headers: {} },
                      enabled: true,
                    });
                    setKsIsNew(true);
                  }}>
                    {d('addApiSource')}
                  </button>
                </>
              )}

              {/* Source editor form */}
              {ksEditing && (
                <div className="agd-ks-editor">
                  <h4>{ksIsNew ? d('ksNewTitle') : d('ksEditTitle')}</h4>

                  <div className="agd-row">
                    <div className="agd-field agd-field-half">
                      <label>{d('ksToolName')} <span className="agd-hint">{d('ksToolNameHint')}</span></label>
                      <input className="agd-input" value={ksEditing.name} placeholder={d('ksToolNamePlaceholder')}
                        onChange={(e) => setKsEditing({ ...ksEditing, name: e.target.value })} />
                    </div>
                    <div className="agd-field agd-field-half">
                      <label>{d('ksMethod')}</label>
                      <select className="agd-input" value={ksEditing.config.method}
                        onChange={(e) => setKsEditing({ ...ksEditing, config: { ...ksEditing.config, method: e.target.value as "GET" | "POST" | "PUT" | "DELETE" } })}>
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                        <option value="DELETE">DELETE</option>
                      </select>
                    </div>
                  </div>

                  <div className="agd-field">
                    <label>{d('ksDesc')}</label>
                    <input className="agd-input" value={ksEditing.description} placeholder={d('ksDescPlaceholder')}
                      onChange={(e) => setKsEditing({ ...ksEditing, description: e.target.value })} />
                  </div>

                  <div className="agd-field">
                    <label>{d('ksUrl')} <span className="agd-hint">{d('ksUrlHint')}</span></label>
                    <input className="agd-input" value={ksEditing.config.url} placeholder={d('ksUrlPlaceholder')}
                      onChange={(e) => setKsEditing({ ...ksEditing, config: { ...ksEditing.config, url: e.target.value } })} />
                  </div>

                  {/* Headers */}
                  <div className="agd-field">
                    <label>{d('ksHeaders')}</label>
                    {Object.entries(ksEditing.config.headers || {}).map(([hKey, hVal], hi) => (
                      <div key={hi} className="agd-ks-header-row">
                        <input className="agd-input" value={hKey} placeholder={d('ksHeaderKeyPlaceholder')}
                          onChange={(e) => {
                            const headers = { ...ksEditing.config.headers };
                            const entries = Object.entries(headers);
                            entries[hi] = [e.target.value, hVal];
                            setKsEditing({ ...ksEditing, config: { ...ksEditing.config, headers: Object.fromEntries(entries) } });
                          }} />
                        <input className="agd-input" value={hVal} placeholder={d('ksHeaderValuePlaceholder')}
                          onChange={(e) => {
                            const headers = { ...ksEditing.config.headers };
                            headers[hKey] = e.target.value;
                            setKsEditing({ ...ksEditing, config: { ...ksEditing.config, headers } });
                          }} />
                        <button className="agd-ks-delete" onClick={() => {
                          const headers = { ...ksEditing.config.headers };
                          delete headers[hKey];
                          setKsEditing({ ...ksEditing, config: { ...ksEditing.config, headers } });
                        }}>&times;</button>
                      </div>
                    ))}
                    <button className="agd-ks-add-inline" onClick={() => {
                      const headers = { ...ksEditing.config.headers, "": "" };
                      setKsEditing({ ...ksEditing, config: { ...ksEditing.config, headers } });
                    }}>{d('ksAddHeader')}</button>
                  </div>

                  {/* Parameters */}
                  <div className="agd-field">
                    <label>{d('ksParams')}</label>
                    <div className="agd-ks-param-table">
                      {ksEditing.config.parameters.length > 0 && (
                        <div className="agd-ks-param-header-row">
                          <span>{d('ksParamName')}</span>
                          <span>{d('ksParamDesc')}</span>
                          <span>{d('ksParamType')}</span>
                          <span>{d('ksParamIn')}</span>
                          <span>{d('ksParamRequired')}</span>
                          <span />
                        </div>
                      )}
                      {ksEditing.config.parameters.map((param, pi) => (
                        <div key={pi} className="agd-ks-param-row">
                          <input className="agd-input" value={param.name} placeholder="name"
                            onChange={(e) => {
                              const params = [...ksEditing.config.parameters];
                              params[pi] = { ...param, name: e.target.value };
                              setKsEditing({ ...ksEditing, config: { ...ksEditing.config, parameters: params } });
                            }} />
                          <input className="agd-input" value={param.description} placeholder="description"
                            onChange={(e) => {
                              const params = [...ksEditing.config.parameters];
                              params[pi] = { ...param, description: e.target.value };
                              setKsEditing({ ...ksEditing, config: { ...ksEditing.config, parameters: params } });
                            }} />
                          <select className="agd-input" value={param.type}
                            onChange={(e) => {
                              const params = [...ksEditing.config.parameters];
                              params[pi] = { ...param, type: e.target.value as "string" | "number" | "boolean" };
                              setKsEditing({ ...ksEditing, config: { ...ksEditing.config, parameters: params } });
                            }}>
                            <option value="string">string</option>
                            <option value="number">number</option>
                            <option value="boolean">boolean</option>
                          </select>
                          <select className="agd-input" value={param.in}
                            onChange={(e) => {
                              const params = [...ksEditing.config.parameters];
                              params[pi] = { ...param, in: e.target.value as "query" | "body" | "path" };
                              setKsEditing({ ...ksEditing, config: { ...ksEditing.config, parameters: params } });
                            }}>
                            <option value="query">query</option>
                            <option value="path">path</option>
                            <option value="body">body</option>
                          </select>
                          <input type="checkbox" checked={param.required}
                            onChange={(e) => {
                              const params = [...ksEditing.config.parameters];
                              params[pi] = { ...param, required: e.target.checked };
                              setKsEditing({ ...ksEditing, config: { ...ksEditing.config, parameters: params } });
                            }} />
                          <button className="agd-ks-delete" onClick={() => {
                            const params = ksEditing.config.parameters.filter((_, i) => i !== pi);
                            setKsEditing({ ...ksEditing, config: { ...ksEditing.config, parameters: params } });
                          }}>&times;</button>
                        </div>
                      ))}
                    </div>
                    <button className="agd-ks-add-inline" onClick={() => {
                      const params = [...ksEditing.config.parameters, { name: "", description: "", type: "string" as const, in: "query" as const, required: false }];
                      setKsEditing({ ...ksEditing, config: { ...ksEditing.config, parameters: params } });
                    }}>{d('ksAddParam')}</button>
                  </div>

                  {/* Response mapping */}
                  <div className="agd-field">
                    <label>{d('ksResponseMapping')} <span className="agd-hint">{d('ksResponseMappingHint')}</span></label>
                    <input className="agd-input" value={ksEditing.config.responseMapping || ""} placeholder={d('ksResponseMappingPlaceholder')}
                      onChange={(e) => setKsEditing({ ...ksEditing, config: { ...ksEditing.config, responseMapping: e.target.value || undefined } })} />
                  </div>

                  {/* Actions */}
                  <div className="agd-ks-editor-actions">
                    <button className="agd-ks-cancel-btn" onClick={() => setKsEditing(null)}>{d('ksCancel')}</button>
                    <button className="btn-primary" disabled={!ksEditing.name.trim() || !ksEditing.config.url.trim()}
                      onClick={() => {
                        if (ksIsNew) {
                          setKnowledgeSources((prev) => [...prev, ksEditing]);
                        } else {
                          setKnowledgeSources((prev) => prev.map((s) => s.id === ksEditing.id ? ksEditing : s));
                        }
                        setKsEditing(null);
                        markDirty();
                      }}>
                      {d('ksSave')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── API Tab ─── */}
        {tab === "api" && (
          <div className="agent-detail-content">
            {/* Usage stats */}
            {(usage24h || usage7d) && (
              <div className="agent-detail-section">
                <h4>{d('usageTitle')}</h4>
                <div className="agd-usage-grid">
                  {usage24h && (
                    <div className="agd-usage-card">
                      <div className="agd-usage-period">{d('usage24h')}</div>
                      <div className="agd-usage-stat"><strong>{usage24h.requests}</strong> {d('usageRequests')}</div>
                      <div className="agd-usage-stat">{(usage24h.tokensIn + usage24h.tokensOut).toLocaleString()} tokens</div>
                      <div className="agd-usage-stat">{Math.round(usage24h.avgDurationMs / 1000 * 10) / 10}s {d('usageAvgLatency')}</div>
                    </div>
                  )}
                  {usage7d && (
                    <div className="agd-usage-card">
                      <div className="agd-usage-period">{d('usage7d')}</div>
                      <div className="agd-usage-stat"><strong>{usage7d.requests}</strong> {d('usageRequests')}</div>
                      <div className="agd-usage-stat">{(usage7d.tokensIn + usage7d.tokensOut).toLocaleString()} tokens</div>
                      <div className="agd-usage-stat">{Math.round(usage7d.avgDurationMs / 1000 * 10) / 10}s {d('usageAvgLatency')}</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="agent-detail-section">
              <h4>{d('publishTitle')}</h4>
              <div className="agd-publish-row">
                <div>
                  <div className="agd-publish-label">{d('publishLabel')}</div>
                  <div className="agd-hint">{d('publishHint')}</div>
                </div>
                <label className="agents-toggle">
                  <input
                    type="checkbox"
                    checked={isPublished}
                    onChange={(e) => { setIsPublished(e.target.checked); markDirty(); }}
                  />
                  <span className="agents-toggle-slider" />
                </label>
              </div>
            </div>

            <div className="agent-detail-section">
              <h4>{d('apiKeysTitle')}</h4>
              {apiKeys.length > 0 && (
                <div className="agd-keys-list">
                  {apiKeys.map((k) => (
                    <div key={k.keyId} className="agd-key-row">
                      <code className="agd-key-value">{k.key}</code>
                      <span className="agd-key-name">{k.name}</span>
                      <span className="agd-key-date">{new Date(k.createdAt).toLocaleDateString()}</span>
                      <button
                        className="agd-key-delete"
                        onClick={async () => {
                          await deleteAgentApiKey(agent.id, k.keyId);
                          setApiKeys((prev) => prev.filter((x) => x.keyId !== k.keyId));
                        }}
                      >
                        {d('revoke')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {justCreatedKey && (
                <div className="agd-key-created">
                  <strong>{d('newKeyHint')}</strong>
                  <code
                    className="agd-key-full"
                    onClick={() => { navigator.clipboard.writeText(justCreatedKey); setSuccessMsg(d('copied')); setTimeout(() => setSuccessMsg(null), 1500); }}
                  >
                    {justCreatedKey}
                  </code>
                </div>
              )}
              <div className="agd-key-create">
                <input
                  className="agd-input"
                  placeholder={d('keyNamePlaceholder')}
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                />
                <button
                  className="btn-primary"
                  disabled={!newKeyName.trim()}
                  onClick={async () => {
                    const key = await createAgentApiKey(agent.id, newKeyName.trim());
                    setApiKeys((prev) => [...prev, { ...key, key: key.key.slice(0, 12) + "..." + key.key.slice(-4) }]);
                    setJustCreatedKey(key.key);
                    setNewKeyName("");
                  }}
                >
                  {d('generateKey')}
                </button>
              </div>
            </div>

            <div className="agent-detail-section">
              <h4>{d('endpointTitle')}</h4>
              <div className="agd-endpoint-block">
                <div className="agd-endpoint-title">{d('statelessChat')}</div>
                <code className="agd-endpoint-url">POST {baseUrl}/api/v1/agents/{agent.id}/chat</code>
                <pre className="agd-endpoint-example">{`curl -X POST ${baseUrl}/api/v1/agents/${agent.id}/chat \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{"input": "Hello"}'`}</pre>
              </div>
              <div className="agd-endpoint-block">
                <div className="agd-endpoint-title">{d('createSession')}</div>
                <code className="agd-endpoint-url">POST {baseUrl}/api/v1/agents/{agent.id}/sessions</code>
              </div>
              <div className="agd-endpoint-block">
                <div className="agd-endpoint-title">{d('sessionChat')}</div>
                <code className="agd-endpoint-url">POST {baseUrl}/api/v1/agents/{agent.id}/sessions/:sessionId/chat</code>
              </div>
            </div>
          </div>
        )}

        {/* ─── Test Tab ─── */}
        {tab === "test" && (
          <div className="agent-detail-content agd-test-content">
            <div className="agd-test-messages">
              {testMessages.length === 0 && (
                <div className="agd-test-empty">{d('testEmpty')}</div>
              )}
              {testMessages.map((msg, i) => (
                <div key={i} className={`agd-test-msg agd-test-msg-${msg.role}`}>
                  <div className="agd-test-msg-role">{msg.role === "user" ? "You" : agent.name}</div>
                  <div className="agd-test-msg-text">{msg.text}</div>
                </div>
              ))}
              {testLoading && (
                <div className="agd-test-msg agd-test-msg-assistant">
                  <div className="agd-test-msg-role">{agent.name}</div>
                  <div className="agd-test-msg-text agd-test-typing">{t('common.loading')}</div>
                </div>
              )}
              <div ref={testEndRef} />
            </div>
            <div className="agd-test-input-row">
              <input
                className="agd-input agd-test-input"
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleTest()}
                placeholder={d('testPlaceholder')}
                disabled={testLoading}
              />
              <button className="btn-primary" onClick={handleTest} disabled={testLoading || !testInput.trim()}>
                {d('send')}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
