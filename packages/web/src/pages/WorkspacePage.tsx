import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/PageHeader";
import { WorkflowCanvas } from "../components/WorkflowCanvas";
import { WorkflowEditor } from "../components/WorkflowEditor";
import type { WorkflowDef } from "../components/WorkflowEditor";
import { listManagedTasks, updateManagedTask, type TaskItem } from "../api/client";
import type { CanvasStep, CanvasEdge } from "../components/WorkflowCanvas";
import { connectWebSocket } from "../api/client";
import "./WorkspacePage.css";

type ViewMode = "execute" | "edit";

interface WorkspaceState {
  activeWorkspacePath?: string;
  targetProjects: { name: string; path: string }[];
  lastActiveTaskId?: string;
}

const STATUS_ORDER: Record<string, number> = {
  queued: 0,
  running: 1,
  waiting_decision: 2,
  todo: 3,
  done: 4,
  failed: 5,
};

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting_decision: "Wait",
  todo: "Todo",
  done: "Done",
  failed: "Failed",
};

export function WorkspacePage() {
  const { t } = useTranslation();
  const [activeTask, setActiveTask] = useState<TaskItem | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("execute");
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importMode, setImportMode] = useState<"git" | "local">("git");
  const [gitUrl, setGitUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [browsePath, setBrowsePath] = useState("");
  const [browseEntries, setBrowseEntries] = useState<{ name: string; path: string; isDirectory: boolean }[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseHistory, setBrowseHistory] = useState<string[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [rootsLoading, setRootsLoading] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  const [importedWorkspaces, setImportedWorkspaces] = useState<{ name: string; path: string; active: boolean }[]>([]);
  const [workflowDef, setWorkflowDef] = useState<WorkflowDef>({ name: "untitled", steps: [], edges: [] });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<{ role: string; text: string }[]>([]);
  const wsRef = useRef<ReturnType<typeof connectWebSocket> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace/status");
      if (res.ok) {
        const data = await res.json();
        setWorkspace(data);
      }
    } catch {}
  }, []);

  const fetchTasks = useCallback(async () => {
    setTasksLoading(true);
    try {
      const res = await listManagedTasks({ limit: 50 });
      setTasks(res.items);
    } catch {} finally {
      setTasksLoading(false);
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace/projects");
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
      }
    } catch {}
  }, []);

  const fetchImportedWorkspaces = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace/list");
      if (res.ok) {
        const data = await res.json();
        setImportedWorkspaces(data.workspaces || []);
      }
    } catch {}
  }, []);

  const switchWorkspace = useCallback(async (path: string) => {
    try {
      const res = await fetch("/api/workspace/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (res.ok) {
        const data = await res.json();
        setWorkspace({ activeWorkspacePath: data.path, targetProjects: [] });
        fetchImportedWorkspaces();
      }
    } catch {}
  }, [fetchImportedWorkspaces]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (workspace?.activeWorkspacePath) {
      fetchTasks();
      fetchProjects();
    } else {
      fetchImportedWorkspaces();
    }
  }, [workspace?.activeWorkspacePath, fetchTasks, fetchProjects, fetchImportedWorkspaces]);

  const selectTask = (task: TaskItem) => {
    setActiveTask(task);
    setViewMode("execute");
    setChatMessages([]);
    setPreviewUrl(null);
  };

  const handleWorkflowChange = useCallback((def: WorkflowDef) => {
    setWorkflowDef(def);
  }, []);

  const handleImport = async () => {
    if (importing) return;
    if (importMode === "git" && !gitUrl.trim()) return;
    if (importMode === "local" && !localPath.trim()) return;
    setImporting(true);
    setImportError("");
    const body = importMode === "git"
      ? { remoteUrl: gitUrl.trim() }
      : { localPath: localPath.trim() };
    try {
      const res = await fetch("/api/workspace/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Import failed");
      }
      const data = await res.json();
      setWorkspace({ activeWorkspacePath: data.path, targetProjects: [] });
      setShowImport(false);
      setGitUrl("");
      fetchProjects();
    } catch (e: any) {
      setImportError(e.message || "Unknown error");
    } finally {
      setImporting(false);
    }
  };

  const loadBrowse = useCallback(async (dirPath: string) => {
    setBrowseLoading(true);
    try {
      const res = await fetch(`/api/workspace/browse?path=${encodeURIComponent(dirPath)}`);
      if (res.ok) {
        const data = await res.json();
        setBrowsePath(data.path);
        setBrowseEntries(data.entries);
      }
    } catch {} finally {
      setBrowseLoading(false);
    }
  }, []);

  const openLocalImport = useCallback(async () => {
    setBrowsePath("");
    setBrowseEntries([]);
    setBrowseHistory([]);
    setLocalPath("");
    setRootsLoading(true);
    try {
      const res = await fetch("/api/workspace/roots");
      if (res.ok) {
        const data = await res.json();
        setRoots(data.roots || ["C:\\"]);
      } else {
        setRoots(["C:\\"]);
      }
    } catch {
      setRoots(["C:\\"]);
    } finally {
      setRootsLoading(false);
    }
  }, []);

  const browseEnterDir = useCallback((dirPath: string) => {
    setBrowseHistory((h) => [...h, browsePath]);
    loadBrowse(dirPath);
  }, [browsePath, loadBrowse]);

  const browseGoBack = useCallback(() => {
    if (browseHistory.length > 0) {
      const prev = browseHistory[browseHistory.length - 1];
      setBrowseHistory((h) => h.slice(0, -1));
      if (!prev) {
        setBrowsePath("");
        setBrowseEntries([]);
      } else {
        loadBrowse(prev);
      }
    } else if (browsePath) {
      setBrowsePath("");
      setBrowseEntries([]);
    }
  }, [browseHistory, browsePath, loadBrowse]);

  const selectRoot = useCallback((root: string) => {
    setBrowseHistory((h) => [...h, browsePath]);
    loadBrowse(root);
  }, [browsePath, loadBrowse]);

  const browseSelectDir = useCallback((dirPath: string) => {
    setLocalPath(dirPath);
  }, []);

  const handleSendChat = async () => {
    if (!chatInput.trim() || !activeTask) return;
    const text = chatInput.trim();
    setChatInput("");
    setChatMessages((m) => [...m, { role: "user", text }]);
    setChatMessages((m) => [...m, { role: "assistant", text: "Thinking..." }]);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: activeTask.title }),
      });
      if (!res.ok) throw new Error("Session creation failed");
      const session = await res.json();
      const chatRes = await fetch(`/api/sessions/${session.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!chatRes.ok) throw new Error("Chat failed");
      const chatData = await chatRes.json();
      setChatMessages((m) => m.slice(0, -1));
      setChatMessages((m) => [...m, { role: "assistant", text: chatData.response || "Done" }]);
    } catch {}
  };

  const sortedTasks = [...tasks].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99),
  );
  const hasWorkspace = !!workspace?.activeWorkspacePath;
  const canvasSteps: CanvasStep[] = workflowDef.steps;
  const canvasEdges: CanvasEdge[] = workflowDef.edges;

  return (
    <>
      <PageHeader>
        {t("nav.workspace")}
        {activeTask && (
          <span className="ws-header-task">
            — {activeTask.title}
          </span>
        )}
      </PageHeader>
      <div className="ws-layout">
        {hasWorkspace ? (
          <>
            <aside className="ws-sidebar">
              <div className="ws-project-info">
                <div className="ws-project-name">
                  {workspace?.activeWorkspacePath?.split(/[\\/]/).filter(Boolean).pop() || "Workspace"}
                </div>
                <div className="ws-project-path" title={workspace?.activeWorkspacePath}>
                  {workspace?.activeWorkspacePath}
                </div>
              </div>
              {projects.length > 0 && (
                <div className="ws-project-list">
                  {projects.map((p) => (
                    <div key={p.path} className="ws-project-item" title={p.path}>
                      &#x1f4c1; {p.name}
                    </div>
                  ))}
                </div>
              )}
              <div className="ws-sidebar-header">
                <span className="ws-sidebar-title">{t("tasks.title")}</span>
                <button
                  className="btn-icon"
                  title={t("common.refresh")}
                  onClick={fetchTasks}
                >
                  &#x21bb;
                </button>
              </div>
              <div className="ws-task-list">
                {tasksLoading ? (
                  <div className="ws-task-empty">{t("common.loading")}</div>
                ) : sortedTasks.length === 0 ? (
                  <div className="ws-task-empty">{t("workspace.noTasks")}</div>
                ) : (
                  sortedTasks.map((task) => (
                    <button
                      key={task.id}
                      className={`ws-task-item${activeTask?.id === task.id ? " active" : ""}`}
                      onClick={() => selectTask(task)}
                    >
                      <div className="ws-task-item-top">
                        <span className="ws-task-item-title">{task.title}</span>
                        <span className={`ws-task-status ws-task-status-${task.status}`}>
                          {task.status === "running" && <span className="ws-task-spinner" />}
                          {STATUS_LABELS[task.status] ?? task.status}
                        </span>
                      </div>
                      {task.description && (
                        <div className="ws-task-item-desc">{task.description}</div>
                      )}
                      <div className="ws-task-item-meta">
                        {task.priority && (
                          <span className={`ws-task-priority ws-priority-${task.priority}`}>
                            {task.priority}
                          </span>
                        )}
                        {task.source && (
                          <span className="ws-task-source">{task.source}</span>
                        )}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </aside>

            <main className="ws-main">
              {!activeTask ? (
                <div className="ws-welcome">
                  <div className="ws-welcome-icon">&#x2699;</div>
                  <h2>{t("nav.workspace")}</h2>
                  <p>{t("workspace.selectTask")}</p>
                </div>
              ) : (
                <>
                  <div className="ws-mode-bar">
                    <button
                      className={`ws-mode-btn${viewMode === "execute" ? " active" : ""}`}
                      onClick={() => setViewMode("execute")}
                    >
                      Execute
                    </button>
                    <button
                      className={`ws-mode-btn${viewMode === "edit" ? " active" : ""}`}
                      onClick={() => setViewMode("edit")}
                    >
                      Edit
                    </button>
                  </div>

                  <div className="ws-canvas-area">
                    {viewMode === "execute" ? (
                      <WorkflowCanvas steps={canvasSteps} edges={canvasEdges} />
                    ) : (
                      <WorkflowEditor
                        initial={workflowDef}
                        onChange={handleWorkflowChange}
                      />
                    )}
                  </div>

                  <div className="ws-chat">
                    <div className="ws-chat-messages">
                      {chatMessages.length === 0 ? (
                        <div className="ws-chat-placeholder">
                          Describe the workflow you want to create, or ask the agent to modify it.
                        </div>
                      ) : (
                        chatMessages.map((msg, i) => (
                          <div key={i} className={`ws-chat-msg ws-chat-msg-${msg.role}`}>
                            <div className="ws-chat-msg-role">{msg.role === "user" ? "You" : "Agent"}</div>
                            <div className="ws-chat-msg-text">{msg.text}</div>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="ws-chat-input-row">
                      <input
                        className="ws-chat-input"
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleSendChat()}
                        placeholder={t("chat.askPlaceholder") || "Ask the agent to create or modify a workflow..."}
                      />
                      <button
                        className="btn-primary ws-chat-send"
                        onClick={handleSendChat}
                        disabled={!chatInput.trim()}
                      >
                        Send
                      </button>
                    </div>
                  </div>
                </>
              )}
            </main>

            {activeTask && (
              <aside className="ws-preview">
                <div className="ws-preview-header">
                  <span className="ws-preview-title">{t("chat.preview") || "Preview"}</span>
                </div>
                <div className="ws-preview-body">
                  {previewUrl ? (
                    <iframe
                      className="ws-preview-iframe"
                      src={previewUrl}
                      title="Preview"
                      sandbox="allow-scripts"
                    />
                  ) : (
                    <div className="ws-preview-empty">
                      Select a file or artifact below
                    </div>
                  )}
                  {activeTask.result && (
                    <div className="ws-preview-artifact-list">
                      <div className="ws-preview-artifact-title">Artifacts</div>
                      <button
                        className="ws-preview-artifact-item"
                        onClick={() => setPreviewUrl(`/preview/${encodeURIComponent(activeTask.result!)}`)}
                      >
                        {activeTask.result}
                      </button>
                    </div>
                  )}
                </div>
              </aside>
            )}
          </>
        ) : (
          <div className="ws-no-workspace">
            <div className="ws-no-workspace-icon">&#x1f4e6;</div>
            <h2>{t("workspace.noWorkspace")}</h2>
            <p>{t("workspace.noWorkspaceDesc")}</p>
            <button className="btn-primary" onClick={() => setShowImport(true)}>
              {t("workspace.import")}
            </button>

            {importedWorkspaces.length > 0 && (
              <div className="ws-existing-workspaces">
                <h3>Imported Workspaces</h3>
                <div className="ws-existing-list">
                  {importedWorkspaces.map((ws) => (
                    <div key={ws.path} className="ws-existing-item">
                      <span className="ws-existing-name">&#x1f4c1; {ws.name}</span>
                      <button className="btn-secondary ws-existing-switch" onClick={() => switchWorkspace(ws.path)}>
                        Switch
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {showImport && (
        <div className="ws-modal-overlay" onClick={() => setShowImport(false)}>
          <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
            <button className="ws-modal-close" onClick={() => setShowImport(false)}>
              &times;
            </button>
            <h3>{t("workspace.import")}</h3>
            <p className="ws-modal-desc">{t("workspace.importDesc")}</p>
            <div className="ws-modal-tabs">
              <button
                className={`ws-modal-tab${importMode === "git" ? " active" : ""}`}
                onClick={() => setImportMode("git")}
              >
                Git URL
              </button>
              <button
                className={`ws-modal-tab${importMode === "local" ? " active" : ""}`}
                onClick={() => { setImportMode("local"); openLocalImport(); }}
              >
                Local Path
              </button>
            </div>
            {importMode === "git" ? (
              <>
                <label className="ws-modal-label">{t("workspace.gitUrl")}</label>
                <input
                  className="ws-modal-input"
                  type="text"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder={t("workspace.gitUrlPlaceholder")}
                  onKeyDown={(e) => e.key === "Enter" && handleImport()}
                />
              </>
            ) : (
              <>
                <label className="ws-modal-label">Select Directory</label>
                <div className="ws-browse-bar">
                  <button className="ws-browse-back" onClick={browseGoBack} disabled={!browsePath && browseHistory.length === 0}>
                    &larr;
                  </button>
                  <span className="ws-browse-current">{browsePath || "Click a directory to browse"}</span>
                  {browsePath && (
                    <button className="ws-browse-root-btn" onClick={() => { setBrowsePath(""); setBrowseEntries([]); setBrowseHistory([]); }}>
                      Drives
                    </button>
                  )}
                </div>
                {!browsePath ? (
                  rootsLoading ? (
                    <div className="ws-browse-loading">Loading drives...</div>
                  ) : roots.length > 0 ? (
                    <div className="ws-browse-list">
                      <div className="ws-browse-list-title">Select a drive</div>
                      {roots.map((root) => (
                        <div key={root} className="ws-browse-entry">
                          <button className="ws-browse-btn" onClick={() => selectRoot(root)}>
                            &#x1f4c1; {root}
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <button className="ws-browse-start" onClick={openLocalImport}>
                      Browse Filesystem
                    </button>
                  )
                ) : (
                  <div className="ws-browse-list">
                    {browseLoading ? (
                      <div className="ws-browse-loading">Loading...</div>
                    ) : browseEntries.length === 0 ? (
                      <div className="ws-browse-empty">Empty directory</div>
                    ) : (
                      browseEntries.map((entry) => {
                        const isSelected = localPath === entry.path;
                        return (
                          <div key={entry.path} className={`ws-browse-entry${isSelected ? " selected" : ""}`}>
                            {entry.isDirectory ? (
                              <>
                                <button className="ws-browse-btn" onClick={() => browseEnterDir(entry.path)}>
                                  &#x1f4c1; {entry.name}
                                </button>
                                <button className="ws-browse-select" onClick={() => browseSelectDir(entry.path)}>
                                  {isSelected ? "Selected" : "Select"}
                                </button>
                              </>
                            ) : (
                              <span className="ws-browse-file">&#x1f4c4; {entry.name}</span>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
                {localPath && <p className="ws-browse-selected">Selected: {localPath}</p>}
              </>
            )}
            {importError && <p className="ws-modal-error">{importError}</p>}
            <div className="ws-modal-actions">
              <button className="btn-secondary" onClick={() => setShowImport(false)}>
                {t("common.cancel")}
              </button>
              <button
                className="btn-primary"
                onClick={handleImport}
                disabled={importing || (importMode === "git" ? !gitUrl.trim() : !localPath.trim())}
              >
                {importing ? t("workspace.importing") : t("workspace.import")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
