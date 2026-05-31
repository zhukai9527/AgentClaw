import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/PageHeader";
import { WorkflowCanvas } from "../components/WorkflowCanvas";
import { WorkflowEditor } from "../components/WorkflowEditor";
import type { WorkflowDef } from "../components/WorkflowEditor";
import { listManagedTasks, type TaskItem } from "../api/client";
import type { CanvasStep, CanvasEdge } from "../components/WorkflowCanvas";
import { connectWebSocket } from "../api/client";
import {
  Folder,
  FileText,
  CheckCircle,
  XCircle,
  AlertCircle,
  Plus,
  Trash2,
  Save,
  Play,
  Search,
  Layout,
  ChevronLeft,
  List,
  Workflow,
  Terminal,
  X,
  File,
} from "lucide-react";
import "./WorkspacePage.css";

type ViewMode = "execute" | "edit";
type SidebarTab = "tasks" | "workflows";

interface WorkspaceState {
  activeWorkspacePath?: string;
  targetProjects: { name: string; path: string }[];
  lastActiveTaskId?: string;
}

interface Toast {
  id: number;
  type: "success" | "error" | "info";
  message: string;
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

let toastId = 0;

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
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("tasks");
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [activeWorkflow, setActiveWorkflow] = useState<any | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDesc, setNewTaskDesc] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState("medium");
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const wsRef = useRef<ReturnType<typeof connectWebSocket> | null>(null);

  const addToast = useCallback((type: Toast["type"], message: string) => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

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

  const fetchWorkflows = useCallback(async () => {
    setWorkflowsLoading(true);
    try {
      const res = await fetch("/api/workspace/workflows");
      if (res.ok) {
        const data = await res.json();
        setWorkflows(data.workflows || []);
      }
    } catch {} finally {
      setWorkflowsLoading(false);
    }
  }, []);

  const selectWorkflow = useCallback((wf: any) => {
    setActiveWorkflow(wf);
    setActiveTask(null);
    setViewMode("execute");
    const steps: CanvasStep[] = (wf.steps || []).map((s: any, i: number) => ({
      id: s.id || `step-${i}`,
      name: s.name || `Step ${i + 1}`,
      type: s.type || "task",
      status: undefined,
      skill: s.skill,
      skillSource: s.skillSource,
    }));
    const edges: CanvasEdge[] = (wf.edges || []).map((e: any) => ({
      from: e.from || "",
      to: e.to || null,
      label: e.label || e.condition,
    }));
    setWorkflowDef({ name: wf.name, steps, edges });
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
      fetchWorkflows();
    } else {
      fetchImportedWorkspaces();
    }
  }, [workspace?.activeWorkspacePath, fetchTasks, fetchProjects, fetchWorkflows, fetchImportedWorkspaces]);

  const selectTask = (task: TaskItem) => {
    setActiveTask(task);
    setActiveWorkflow(null);
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
      addToast("success", "Workspace imported successfully");
      fetchProjects();
    } catch (e: any) {
      setImportError(e.message || "Unknown error");
    } finally {
      setImporting(false);
    }
  };

  const handleSaveWorkflow = async () => {
    if (!workflowDef.name || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/workspace/workflows/${encodeURIComponent(workflowDef.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition: workflowDef }),
      });
      if (!res.ok) throw new Error("Save failed");
      addToast("success", "Workflow saved");
      fetchWorkflows();
    } catch {
      addToast("error", "Failed to save workflow");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteWorkflow = async () => {
    if (!activeWorkflow) return;
    try {
      const res = await fetch(`/api/workspace/workflows/${encodeURIComponent(activeWorkflow.name)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
      addToast("success", "Workflow deleted");
      setActiveWorkflow(null);
      setShowConfirmDelete(false);
      fetchWorkflows();
    } catch {
      addToast("error", "Failed to delete workflow");
    }
  };

  const handleRunWorkflow = async () => {
    if (!activeWorkflow || running) return;
    setRunning(true);
    try {
      const task = {
        title: `Run: ${activeWorkflow.name}`,
        description: `Executing workflow: ${activeWorkflow.name}`,
        priority: "medium",
      };
      const res = await fetch("/api/workspace/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(task),
      });
      if (!res.ok) throw new Error("Task creation failed");
      const data = await res.json();
      setActiveTask(data);
      addToast("success", `Workflow "${activeWorkflow.name}" started`);
      fetchTasks();
    } catch {
      addToast("error", "Failed to start workflow");
    } finally {
      setRunning(false);
    }
  };

  const handleCreateTask = async () => {
    if (!newTaskTitle.trim()) return;
    try {
      const res = await fetch("/api/workspace/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTaskTitle.trim(),
          description: newTaskDesc.trim(),
          priority: newTaskPriority,
        }),
      });
      if (!res.ok) throw new Error("Task creation failed");
      const data = await res.json();
      setActiveTask(data);
      setShowNewTask(false);
      setNewTaskTitle("");
      setNewTaskDesc("");
      setNewTaskPriority("medium");
      addToast("success", "Task created");
      fetchTasks();
    } catch {
      addToast("error", "Failed to create task");
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
    if (!chatInput.trim()) return;
    const text = chatInput.trim();
    setChatInput("");
    let task = activeTask;
    if (!task) {
      task = { id: "new-" + Date.now(), title: text.slice(0, 40), status: "todo", priority: "medium" };
      setActiveTask(task);
    }
    setChatMessages((m) => [...m, { role: "user", text }]);
    setChatMessages((m) => [...m, { role: "assistant", text: "Thinking..." }]);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: task.title }),
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
    } catch {
      addToast("error", "Chat failed. Check server connection.");
    }
  };

  const sortedTasks = [...tasks].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99),
  );
  const hasWorkspace = !!workspace?.activeWorkspacePath;
  const canvasSteps: CanvasStep[] = workflowDef.steps;
  const canvasEdges: CanvasEdge[] = workflowDef.edges;

  const filteredWorkflows = workflows.filter((wf) =>
    !searchQuery || wf.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  const filteredTasks = sortedTasks.filter((task) =>
    !searchQuery || task.title.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <>
      <PageHeader>
        {t("nav.workspace")}
        {activeTask && (
          <span className="ws-header-task">— {activeTask.title}</span>
        )}
      </PageHeader>

      <div className="ws-toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`ws-toast ws-toast-${toast.type}`}>
            <span className="ws-toast-icon">
              {toast.type === "success" ? <CheckCircle size={16} color="var(--success)" /> :
               toast.type === "error" ? <XCircle size={16} color="var(--error)" /> :
               <AlertCircle size={16} color="var(--accent)" />}
            </span>
            <span className="ws-toast-message">{toast.message}</span>
          </div>
        ))}
      </div>

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
                      <Folder size={14} style={{ marginRight: 4, verticalAlign: "middle", flexShrink: 0 }} />
                      {p.name}
                    </div>
                  ))}
                </div>
              )}
              <div className="ws-sidebar-tabs">
                <button
                  className={`ws-sidebar-tab${sidebarTab === "tasks" ? " active" : ""}`}
                  onClick={() => { setSidebarTab("tasks"); setSearchQuery(""); }}
                >
                  <List size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />
                  Tasks
                </button>
                <button
                  className={`ws-sidebar-tab${sidebarTab === "workflows" ? " active" : ""}`}
                  onClick={() => { setSidebarTab("workflows"); setSearchQuery(""); fetchWorkflows(); }}
                >
                  <Workflow size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />
                  Workflows
                </button>
              </div>

              <div className="ws-sidebar-search">
                <input
                  type="text"
                  placeholder={`Search ${sidebarTab}...`}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>

              {sidebarTab === "tasks" ? (
                <div className="ws-task-list">
                  <button className="ws-new-task-btn" onClick={() => setShowNewTask(true)}>
                    <Plus size={14} /> New Task
                  </button>
                  {tasksLoading ? (
                    <>
                      <div className="ws-skeleton ws-skeleton-item" />
                      <div className="ws-skeleton ws-skeleton-item" />
                      <div className="ws-skeleton ws-skeleton-item" />
                    </>
                  ) : filteredTasks.length === 0 ? (
                    <div className="ws-task-empty">
                      {searchQuery ? "No tasks match your search" : t("workspace.noTasks")}
                    </div>
                  ) : (
                    filteredTasks.map((task) => (
                      <button
                        key={task.id}
                        className={`ws-task-item${activeTask?.id === task.id ? " active" : ""}`}
                        onClick={() => { selectTask(task); setSidebarTab("tasks"); }}
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
              ) : (
                <div className="ws-task-list">
                  {workflowsLoading ? (
                    <>
                      <div className="ws-skeleton ws-skeleton-item" />
                      <div className="ws-skeleton ws-skeleton-item" />
                      <div className="ws-skeleton ws-skeleton-item" />
                    </>
                  ) : filteredWorkflows.length === 0 ? (
                    <div className="ws-task-empty">
                      {searchQuery ? "No workflows match your search" : "No workflows found. Create one in the editor."}
                    </div>
                  ) : (
                    filteredWorkflows.map((wf) => (
                      <button
                        key={wf.name}
                        className={`ws-task-item${activeWorkflow?.name === wf.name ? " active" : ""}`}
                        onClick={() => selectWorkflow(wf)}
                      >
                        <div className="ws-task-item-top">
                          <span className="ws-task-item-title">
                            <FileText size={14} style={{ marginRight: 4, verticalAlign: "middle", flexShrink: 0 }} />
                            {wf.name}
                          </span>
                        </div>
                        <div className="ws-task-item-desc">
                          {wf.steps?.length || 0} steps
                          {wf.edges?.length ? `, ${wf.edges.length} edges` : ""}
                        </div>
                        {wf.steps && (
                          <div className="ws-task-item-meta">
                            {[...new Set(wf.steps.map((s: any) => s.type).filter(Boolean))].map((t: any) => (
                              <span key={t} className="ws-task-source">{t}</span>
                            ))}
                          </div>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </aside>

            <main className="ws-main">
              {!activeTask && !activeWorkflow ? (
                <div className="ws-welcome">
                  <Terminal size={48} className="ws-welcome-icon" />
                  <h2>{t("nav.workspace")}</h2>
                  <p>Select a task or workflow from the sidebar, or type a message below to get started.</p>
                </div>
              ) : (
                <>
                  <div className="ws-mode-bar">
                    <button
                      className={`ws-mode-btn${viewMode === "execute" ? " active" : ""}`}
                      onClick={() => setViewMode("execute")}
                    >
                      <Play size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />
                      Execute
                    </button>
                    <button
                      className={`ws-mode-btn${viewMode === "edit" ? " active" : ""}`}
                      onClick={() => setViewMode("edit")}
                    >
                      <Layout size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />
                      Edit
                    </button>
                    <span className="ws-mode-label">
                      {activeWorkflow ? `Workflow: ${activeWorkflow.name}` : activeTask ? activeTask.title : ""}
                    </span>
                    {activeWorkflow && (
                      <div className="ws-mode-actions">
                        <button
                          className="ws-action-btn run"
                          onClick={handleRunWorkflow}
                          disabled={running}
                        >
                          <Play size={12} /> {running ? "Running..." : "Run"}
                        </button>
                        <button
                          className="ws-action-btn save"
                          onClick={handleSaveWorkflow}
                          disabled={saving}
                        >
                          <Save size={12} /> {saving ? "Saving..." : "Save"}
                        </button>
                        <button
                          className="ws-action-btn delete"
                          onClick={() => setShowConfirmDelete(true)}
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    )}
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
                </>
              )}

              <div className="ws-chat">
                <div className="ws-chat-messages">
                  {chatMessages.length === 0 ? (
                    <div className="ws-chat-placeholder">
                      {activeWorkflow
                        ? `Ask the agent to modify "${activeWorkflow.name}" or describe changes.`
                        : activeTask
                          ? "Describe the workflow you want to create, or ask the agent to modify it."
                          : "Ask the agent to create a workflow for you. Type a description and press Enter."}
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
                    {activeTask ? "Send" : "Create"}
                  </button>
                </div>
              </div>
            </main>

            {(activeTask || activeWorkflow) && (
              <aside className="ws-preview">
                <div className="ws-preview-header">
                  <span className="ws-preview-title">{t("chat.preview") || "Inspect"}</span>
                  {activeTask && (
                    <div className="ws-preview-header-actions">
                      <button className="ws-preview-close" onClick={() => setActiveTask(null)}>
                        <X size={14} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="ws-preview-body">
                  {activeTask ? (
                    <>
                      <div className="ws-preview-section">
                        <div className="ws-preview-section-title">Details</div>
                        <div className="ws-preview-detail-row">
                          <span className="ws-preview-detail-label">Status</span>
                          <span className={`ws-task-status ws-task-status-${activeTask.status}`}>
                            {STATUS_LABELS[activeTask.status] ?? activeTask.status}
                          </span>
                        </div>
                        <div className="ws-preview-detail-row">
                          <span className="ws-preview-detail-label">Priority</span>
                          <span className={`ws-task-priority ws-priority-${activeTask.priority}`}>
                            {activeTask.priority}
                          </span>
                        </div>
                        {activeTask.description && (
                          <div className="ws-preview-detail-row">
                            <span className="ws-preview-detail-label">Description</span>
                            <span className="ws-preview-detail-value">{activeTask.description}</span>
                          </div>
                        )}
                      </div>
                      {activeTask.result && (
                        <div className="ws-preview-artifact-list">
                          <div className="ws-preview-section-title">Artifacts</div>
                          <button
                            className="ws-preview-artifact-item"
                            onClick={() => setPreviewUrl(`/preview/${encodeURIComponent(activeTask.result!)}`)}
                          >
                            <File size={14} style={{ marginRight: 6, verticalAlign: "middle" }} />
                            {activeTask.result}
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="ws-preview-empty">
                      {activeWorkflow ? `Workflow: ${activeWorkflow.name}` : "Select a file or artifact"}
                    </div>
                  )}
                  {previewUrl && (
                    <iframe
                      className="ws-preview-iframe"
                      src={previewUrl}
                      title="Preview"
                      sandbox="allow-scripts"
                    />
                  )}
                </div>
              </aside>
            )}
          </>
        ) : (
          <div className="ws-no-workspace">
            <Folder size={64} className="ws-no-workspace-icon" />
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
                      <span className="ws-existing-name">
                        <Folder size={14} style={{ marginRight: 6, verticalAlign: "middle" }} />
                        {ws.name}
                      </span>
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

      {/* Import modal */}
      {showImport && (
        <div className="ws-modal-overlay" onClick={() => setShowImport(false)}>
          <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
            <button className="ws-modal-close" onClick={() => setShowImport(false)}>
              <X size={18} />
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
                    <ChevronLeft size={14} />
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
                            <Folder size={14} style={{ marginRight: 6, verticalAlign: "middle" }} />
                            {root}
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
                                  <Folder size={14} style={{ marginRight: 6, verticalAlign: "middle" }} />
                                  {entry.name}
                                </button>
                                <button className="ws-browse-select" onClick={() => browseSelectDir(entry.path)}>
                                  {isSelected ? "Selected" : "Select"}
                                </button>
                              </>
                            ) : (
                              <span className="ws-browse-file">
                                <File size={14} style={{ marginRight: 6, verticalAlign: "middle" }} />
                                {entry.name}
                              </span>
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

      {/* New task modal */}
      {showNewTask && (
        <div className="ws-modal-overlay" onClick={() => setShowNewTask(false)}>
          <div className="ws-modal ws-new-task-modal" onClick={(e) => e.stopPropagation()}>
            <button className="ws-modal-close" onClick={() => setShowNewTask(false)}>
              <X size={18} />
            </button>
            <h3>New Task</h3>
            <div className="ws-new-task-form">
              <label>Title</label>
              <input
                type="text"
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                placeholder="Task title"
                onKeyDown={(e) => e.key === "Enter" && handleCreateTask()}
                autoFocus
              />
              <label>Description (optional)</label>
              <textarea
                value={newTaskDesc}
                onChange={(e) => setNewTaskDesc(e.target.value)}
                placeholder="Describe what this task should accomplish..."
              />
              <label>Priority</label>
              <select value={newTaskPriority} onChange={(e) => setNewTaskPriority(e.target.value)}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div className="ws-modal-actions">
              <button className="btn-secondary" onClick={() => setShowNewTask(false)}>Cancel</button>
              <button className="btn-primary" onClick={handleCreateTask} disabled={!newTaskTitle.trim()}>Create Task</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete dialog */}
      {showConfirmDelete && (
        <div className="ws-modal-overlay" onClick={() => setShowConfirmDelete(false)}>
          <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
            <button className="ws-modal-close" onClick={() => setShowConfirmDelete(false)}>
              <X size={18} />
            </button>
            <h3>Delete Workflow</h3>
            <p className="ws-confirm-text">
              Are you sure you want to delete <strong>{activeWorkflow?.name}</strong>? This action cannot be undone.
            </p>
            <div className="ws-modal-actions">
              <button className="btn-secondary" onClick={() => setShowConfirmDelete(false)}>Cancel</button>
              <button className="btn-danger" onClick={handleDeleteWorkflow}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
