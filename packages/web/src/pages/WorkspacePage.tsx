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
  const [gitUrl, setGitUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
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

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (workspace?.activeWorkspacePath) {
      fetchTasks();
    }
  }, [workspace?.activeWorkspacePath, fetchTasks]);

  const selectTask = (task: TaskItem) => {
    setActiveTask(task);
    setViewMode("execute");
    setChatMessages([]);
    setPreviewUrl(null);
  };

  const handleWorkflowChange = useCallback((def: WorkflowDef) => {
    setWorkflowDef(def);
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
            <label className="ws-modal-label">{t("workspace.gitUrl")}</label>
            <input
              className="ws-modal-input"
              type="text"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder={t("workspace.gitUrlPlaceholder")}
              onKeyDown={(e) => e.key === "Enter" && handleImport()}
            />
            {importError && <p className="ws-modal-error">{importError}</p>}
            <div className="ws-modal-actions">
              <button className="btn-secondary" onClick={() => setShowImport(false)}>
                {t("common.cancel")}
              </button>
              <button
                className="btn-primary"
                onClick={handleImport}
                disabled={importing || !gitUrl.trim()}
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
