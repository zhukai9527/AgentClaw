import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/PageHeader";
import {
  searchMemories,
  deleteMemory,
  updateMemory,
  deprecateMemory,
  mergeMemories,
  getMemoryNamespaces,
  listAgents,
  type MemoryInfo,
  type MemoryNamespaceInfo,
  type AgentInfo,
} from "../api/client";
import { formatDateTime } from "../utils/format";
import "./MemoryPage.css";

const MEMORY_TYPES = [
  "all",
  "identity",
  "fact",
  "preference",
  "entity",
  "episodic",
];

type SortMode = "importance" | "time";

interface EditDraft {
  content: string;
  type: string;
  importance: string;
}

function typeBadgeClass(type: string): string {
  switch (type) {
    case "identity":
      return "badge badge-accent";
    case "fact":
      return "badge badge-info";
    case "preference":
      return "badge badge-warning";
    case "entity":
      return "badge badge-success";
    case "episodic":
      return "badge badge-error";
    default:
      return "badge badge-muted";
  }
}

function renderImportance(importance: number): string {
  const stars = Math.min(Math.max(Math.round(importance), 0), 5);
  return "\u2605".repeat(stars) + "\u2606".repeat(5 - stars);
}

export function MemoryPage() {
  const { t } = useTranslation();
  const [memories, setMemories] = useState<MemoryInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [namespaces, setNamespaces] = useState<MemoryNamespaceInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>("importance");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({
    content: "",
    type: "fact",
    importance: "0.8",
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mergeDraft, setMergeDraft] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load namespaces and agents on mount
  useEffect(() => {
    getMemoryNamespaces()
      .then(setNamespaces)
      .catch(() => {});
    listAgents()
      .then(setAgents)
      .catch(() => {});
  }, []);

  const fetchMemories = useCallback(
    async (q: string, tp: string, ns: string) => {
      try {
        setLoading(true);
        const typeParam = tp === "all" ? undefined : tp;
        const nsParam = ns === "all" ? undefined : ns;
        const data = await searchMemories(
          q || undefined,
          typeParam,
          100,
          nsParam,
        );
        setMemories(data);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load memories",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    fetchMemories(query, typeFilter, namespaceFilter);
  }, [typeFilter, namespaceFilter, fetchMemories, query]);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      fetchMemories(value, typeFilter, namespaceFilter);
    }, 300);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const handleDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    try {
      setDeletingId(id);
      await deleteMemory(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
      setSelectedIds((prev) => prev.filter((selectedId) => selectedId !== id));
      setConfirmDeleteId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete memory");
    } finally {
      setDeletingId(null);
    }
  };

  const cancelDelete = () => {
    setConfirmDeleteId(null);
  };

  const beginEdit = (mem: MemoryInfo) => {
    setEditingId(mem.id);
    setEditDraft({
      content: mem.content,
      type: mem.type,
      importance: String(mem.importance),
    });
  };

  const saveEdit = async (id: string) => {
    try {
      setSavingId(id);
      const updated = await updateMemory(id, {
        content: editDraft.content.trim(),
        type: editDraft.type,
        importance: Number(editDraft.importance),
        metadata: { editedAt: new Date().toISOString() },
      });
      setMemories((prev) => prev.map((mem) => (mem.id === id ? updated : mem)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update memory");
    } finally {
      setSavingId(null);
    }
  };

  const handleDeprecate = async (id: string) => {
    try {
      setSavingId(id);
      const updated = await deprecateMemory(id, "manual review");
      setMemories((prev) => prev.filter((mem) => mem.id !== updated.id));
      setSelectedIds((prev) => prev.filter((selectedId) => selectedId !== id));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to deprecate memory",
      );
    } finally {
      setSavingId(null);
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id)
        ? prev.filter((selectedId) => selectedId !== id)
        : [...prev, id],
    );
  };

  const startMerge = () => {
    const selected = memories.filter((mem) => selectedIds.includes(mem.id));
    setMergeDraft(selected.map((mem) => mem.content).join("\n"));
    setMerging(true);
  };

  const saveMerge = async () => {
    const selected = memories.filter((mem) => selectedIds.includes(mem.id));
    if (selected.length < 2) return;
    try {
      setSavingId("merge");
      const result = await mergeMemories({
        sourceIds: selectedIds,
        content: mergeDraft.trim(),
        type: selected[0].type,
        importance: Math.max(...selected.map((mem) => mem.importance)),
        namespace:
          namespaceFilter === "all" ? selected[0].namespace : namespaceFilter,
      });
      setMemories((prev) => [
        result.target,
        ...prev.filter(
          (mem) =>
            !result.deprecatedIds.includes(mem.id) &&
            mem.id !== result.target.id,
        ),
      ]);
      setSelectedIds([]);
      setMerging(false);
      setMergeDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to merge memories");
    } finally {
      setSavingId(null);
    }
  };

  // Resolve namespace to agent name for display
  const nsLabel = (ns: string) => {
    if (ns === "default") return t("memory.nsDefault");
    const ag = agents.find((a) => a.id === ns);
    return ag ? `${ag.avatar || "🤖"} ${ag.name}` : ns;
  };

  const sortedMemories = [...memories].sort((a, b) => {
    if (sortMode === "importance") {
      return b.importance - a.importance;
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <>
      <PageHeader>{t("memory.title")}</PageHeader>
      <div className="page-body">
        <div className="memory-toolbar">
          <div className="memory-search-row">
            <input
              type="text"
              className="memory-search-input"
              placeholder={t("memory.searchPlaceholder")}
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
            />
            {namespaces.length > 1 && (
              <select
                className="memory-ns-select"
                value={namespaceFilter}
                onChange={(e) => setNamespaceFilter(e.target.value)}
              >
                <option value="all">{t("memory.allAgents")}</option>
                {namespaces.map((ns) => (
                  <option key={ns.namespace} value={ns.namespace}>
                    {nsLabel(ns.namespace)} ({ns.count})
                  </option>
                ))}
              </select>
            )}
            <select
              className="memory-type-select"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              {MEMORY_TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {tp === "all"
                    ? t("memory.allTypes")
                    : t(`memory.types.${tp}`, tp)}
                </option>
              ))}
            </select>
          </div>
          <div className="memory-sort-row">
            <span className="memory-sort-label">{t("memory.sortBy")}</span>
            <button
              className={`btn-secondary memory-sort-btn ${sortMode === "importance" ? "active" : ""}`}
              onClick={() => setSortMode("importance")}
            >
              {t("memory.importance")}
            </button>
            <button
              className={`btn-secondary memory-sort-btn ${sortMode === "time" ? "active" : ""}`}
              onClick={() => setSortMode("time")}
            >
              {t("memory.time")}
            </button>
            <span className="memory-count">
              {memories.length === 1
                ? t("memory.memoryCount", { count: memories.length })
                : t("memory.memoriesCount", { count: memories.length })}
            </span>
          </div>
          {selectedIds.length >= 2 && (
            <div className="memory-merge-row">
              <span>
                {t("memory.selectedCount", { count: selectedIds.length })}
              </span>
              <button className="btn-secondary" onClick={startMerge}>
                {t("memory.mergeSelected")}
              </button>
              <button
                className="btn-secondary"
                onClick={() => setSelectedIds([])}
              >
                {t("common.cancel")}
              </button>
            </div>
          )}
          {merging && (
            <div className="memory-merge-editor">
              <textarea
                value={mergeDraft}
                onChange={(e) => setMergeDraft(e.target.value)}
              />
              <div className="memory-edit-actions">
                <button
                  className="btn-primary"
                  onClick={saveMerge}
                  disabled={savingId === "merge" || !mergeDraft.trim()}
                >
                  {savingId === "merge" ? "..." : t("memory.saveMerge")}
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => setMerging(false)}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>

        {error && <div className="memory-error">{error}</div>}

        {loading && memories.length === 0 && (
          <div className="memory-loading">{t("memory.loadingMemories")}</div>
        )}

        {!loading && !error && memories.length === 0 && (
          <div className="memory-empty">{t("memory.noMemories")}</div>
        )}

        <div className="memory-list">
          {sortedMemories.map((mem) => (
            <div key={mem.id} className="card memory-card">
              <div className="memory-card-top">
                <div className="memory-card-left">
                  <input
                    type="checkbox"
                    className="memory-select"
                    checked={selectedIds.includes(mem.id)}
                    onChange={() => toggleSelected(mem.id)}
                    aria-label={t("memory.selectMemory")}
                  />
                  <span className={typeBadgeClass(mem.type)}>
                    {t(`memory.types.${mem.type}`, mem.type)}
                  </span>
                  {typeof mem.metadata?.status === "string" && (
                    <span className="memory-status-tag">
                      {String(mem.metadata.status)}
                    </span>
                  )}
                  {mem.namespace &&
                    mem.namespace !== "default" &&
                    namespaceFilter === "all" && (
                      <span className="memory-ns-tag">
                        {nsLabel(mem.namespace)}
                      </span>
                    )}
                  <span
                    className="memory-importance"
                    title={`Importance: ${mem.importance}`}
                  >
                    {renderImportance(mem.importance)}
                  </span>
                </div>
                <div className="memory-card-actions">
                  {confirmDeleteId === mem.id ? (
                    <span className="memory-confirm-delete">
                      <span className="memory-confirm-text">
                        {t("memory.deleteConfirm")}
                      </span>
                      <button
                        className="btn-danger memory-delete-btn"
                        onClick={() => handleDelete(mem.id)}
                        disabled={deletingId === mem.id}
                      >
                        {deletingId === mem.id ? "..." : t("common.yes")}
                      </button>
                      <button
                        className="btn-secondary memory-cancel-btn"
                        onClick={cancelDelete}
                      >
                        {t("common.no")}
                      </button>
                    </span>
                  ) : (
                    <>
                      <button
                        className="btn-secondary memory-delete-btn"
                        onClick={() => beginEdit(mem)}
                      >
                        {t("common.edit")}
                      </button>
                      <button
                        className="btn-secondary memory-delete-btn"
                        onClick={() => handleDeprecate(mem.id)}
                        disabled={savingId === mem.id}
                      >
                        {t("memory.deprecate")}
                      </button>
                      <button
                        className="btn-secondary memory-delete-btn"
                        onClick={() => handleDelete(mem.id)}
                      >
                        {t("common.delete")}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {editingId === mem.id ? (
                <div className="memory-edit-form">
                  <textarea
                    value={editDraft.content}
                    onChange={(e) =>
                      setEditDraft((draft) => ({
                        ...draft,
                        content: e.target.value,
                      }))
                    }
                  />
                  <div className="memory-edit-fields">
                    <select
                      value={editDraft.type}
                      onChange={(e) =>
                        setEditDraft((draft) => ({
                          ...draft,
                          type: e.target.value,
                        }))
                      }
                    >
                      {MEMORY_TYPES.filter((type) => type !== "all").map(
                        (type) => (
                          <option key={type} value={type}>
                            {t(`memory.types.${type}`, type)}
                          </option>
                        ),
                      )}
                    </select>
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={editDraft.importance}
                      onChange={(e) =>
                        setEditDraft((draft) => ({
                          ...draft,
                          importance: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="memory-edit-actions">
                    <button
                      className="btn-primary"
                      onClick={() => saveEdit(mem.id)}
                      disabled={
                        savingId === mem.id || !editDraft.content.trim()
                      }
                    >
                      {savingId === mem.id ? "..." : t("common.save")}
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => setEditingId(null)}
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="memory-content">{mem.content}</div>
              )}
              <div className="memory-card-meta">
                <span>
                  {t("memory.created")} {formatDateTime(mem.createdAt)}
                </span>
                <span>
                  {t("memory.accessed")} {formatDateTime(mem.accessedAt)}
                </span>
                <span>
                  {t("memory.views")} {mem.accessCount}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
