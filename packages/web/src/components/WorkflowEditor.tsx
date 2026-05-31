import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  SelectionMode,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type OnDragOver,
  type OnDrop,
  type NodeMouseHandler,
  Handle,
  Position,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { StepNode, computeLayout, type CanvasStep, type CanvasEdge } from "./WorkflowCanvas";
import "./WorkflowEditor.css";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface WorkflowDef {
  name: string;
  description?: string;
  steps: CanvasStep[];
  edges: CanvasEdge[];
  /** Codex-style phases (optional) */
  phases?: any[];
  applies_to?: string[];
  entry_condition?: string;
  exit_condition?: string;
}

interface WorkflowEditorProps {
  initial?: WorkflowDef;
  onChange?: (def: WorkflowDef) => void;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

let _idCounter = 0;
function nextId(prefix = "step"): string {
  _idCounter += 1;
  return `${prefix}-${_idCounter}`;
}

function defToFlow(def: WorkflowDef): { nodes: Node[]; edges: Edge[] } {
  const positions = computeLayout(
    def.steps.map((s) => s.id),
    def.edges,
  );
  const nodes: Node[] = def.steps.map((s) => ({
    id: s.id,
    type: "stepNode",
    position: positions.get(s.id) || { x: 0, y: 0 },
    data: {
      name: s.name,
      type: s.type,
      status: s.status,
      skill: s.skill,
      skillSource: s.skillSource,
      phaseId: s.phaseId,
      phaseName: s.phaseName,
      runMode: s.runMode,
      entryGate: s.entryGate,
      exitGate: s.exitGate,
      fallbackStep: s.fallbackStep,
      fallbackPhase: s.fallbackPhase,
    },
  }));
  const edges: Edge[] = def.edges
    .filter((e) => e.to)
    .map((e) => ({
      id: `${e.from}->${e.to}`,
      source: e.from,
      target: e.to!,
      label: e.label,
      animated: true,
      style: { stroke: "var(--border)", strokeWidth: 1.5 },
      labelStyle: { fontSize: 11, fill: "var(--text-muted)" },
    }));
  return { nodes, edges };
}

function flowToDef(name: string, nodes: Node[], edges: Edge[]): WorkflowDef {
  const steps: CanvasStep[] = nodes.map((n) => {
    const d = n.data as Record<string, unknown>;
    return {
      id: n.id,
      name: d.name as string,
      type: d.type as "task" | "condition",
      status: d.status as CanvasStep["status"],
      skill: d.skill as string | undefined,
      skillSource: d.skillSource as CanvasStep["skillSource"],
      phaseId: d.phaseId as string | undefined,
      phaseName: d.phaseName as string | undefined,
      runMode: d.runMode as CanvasStep["runMode"],
      entryGate: d.entryGate as string | undefined,
      exitGate: d.exitGate as string | undefined,
      fallbackStep: d.fallbackStep as string | undefined,
      fallbackPhase: d.fallbackPhase as string | undefined,
    };
  });
  const flowEdges: CanvasEdge[] = edges.map((e) => ({
    from: e.source,
    to: e.target,
    label: e.label as string | undefined,
  }));
  return { name, steps, edges: flowEdges };
}

function defToJson(def: WorkflowDef): string {
  return JSON.stringify(
    {
      name: def.name,
      description: def.description,
      steps: def.steps,
      edges: def.edges,
      phases: def.phases,
      applies_to: def.applies_to,
      entry_condition: def.entry_condition,
      exit_condition: def.exit_condition,
    },
    null,
    2,
  );
}

function jsonToDef(json: string): WorkflowDef {
  const parsed = JSON.parse(json);
  return {
    name: parsed.name || "untitled",
    description: parsed.description,
    steps: Array.isArray(parsed.steps) ? parsed.steps : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    phases: parsed.phases,
    applies_to: parsed.applies_to,
    entry_condition: parsed.entry_condition,
    exit_condition: parsed.exit_condition,
  };
}

/* ------------------------------------------------------------------ */
/*  Palette item                                                      */
/* ------------------------------------------------------------------ */

const PALETTE_ITEMS = [
  { type: "task", label: "Task Step", color: "var(--accent)" },
  { type: "condition", label: "Condition", color: "var(--warning)" },
] as const;

function PaletteItem({
  type,
  label,
  color,
}: {
  type: string;
  label: string;
  color: string;
}) {
  const onDragStart = (event: React.DragEvent) => {
    event.dataTransfer.setData("application/reactflow-type", type);
    event.dataTransfer.effectAllowed = "move";
  };
  return (
    <div
      className="wfe-palette-item"
      draggable
      onDragStart={onDragStart}
      style={{ borderLeftColor: color }}
    >
      {label}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Properties panel                                                  */
/* ------------------------------------------------------------------ */

interface PropertiesPanelProps {
  node: Node;
  onUpdate: (id: string, data: Partial<Record<string, unknown>>) => void;
  onClose: () => void;
}

function PropertiesPanel({ node, onUpdate, onClose }: PropertiesPanelProps) {
  const data = node.data as Record<string, unknown>;
  const [name, setName] = useState((data.name as string) || "");
  const [skill, setSkill] = useState((data.skill as string) || "");
  const [prompt, setPrompt] = useState((data.prompt as string) || "");
  const [phaseName, setPhaseName] = useState((data.phaseName as string) || "");
  const [runMode, setRunMode] = useState((data.runMode as string) || "serial");
  const [entryGate, setEntryGate] = useState((data.entryGate as string) || "");
  const [exitGate, setExitGate] = useState((data.exitGate as string) || "");
  const [fallbackStep, setFallbackStep] = useState((data.fallbackStep as string) || "");
  const [fallbackPhase, setFallbackPhase] = useState((data.fallbackPhase as string) || "");

  useEffect(() => {
    setName((data.name as string) || "");
    setSkill((data.skill as string) || "");
    setPrompt((data.prompt as string) || "");
    setPhaseName((data.phaseName as string) || "");
    setRunMode((data.runMode as string) || "serial");
    setEntryGate((data.entryGate as string) || "");
    setExitGate((data.exitGate as string) || "");
    setFallbackStep((data.fallbackStep as string) || "");
    setFallbackPhase((data.fallbackPhase as string) || "");
  }, [data]);

  const handleApply = () => {
    onUpdate(node.id, { name, skill, prompt, phaseName, runMode, entryGate, exitGate, fallbackStep, fallbackPhase });
    onClose();
  };

  return (
    <div className="wfe-props">
      <div className="wfe-props-header">
        <span>Node Properties</span>
        <button className="wfe-props-close" onClick={onClose}>
          &times;
        </button>
      </div>
      <div className="wfe-props-body">
        <label className="wfe-props-label">Name</label>
        <input
          className="wfe-props-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="wfe-props-label">Type</label>
        <div className="wfe-props-value">{data.type as string}</div>
        <label className="wfe-props-label">Skill</label>
        <input
          className="wfe-props-input"
          value={skill}
          onChange={(e) => setSkill(e.target.value)}
          placeholder="skill-name"
        />

        <div className="wfe-props-separator" />

        <label className="wfe-props-label">Phase</label>
        <input
          className="wfe-props-input"
          value={phaseName}
          onChange={(e) => setPhaseName(e.target.value)}
          placeholder="phase-name"
        />
        <label className="wfe-props-label">Run Mode</label>
        <select className="wfe-props-input" value={runMode} onChange={(e) => setRunMode(e.target.value)}>
          <option value="serial">Serial</option>
          <option value="parallel">Parallel</option>
          <option value="join">Join</option>
        </select>
        <label className="wfe-props-label">Entry Gate</label>
        <input
          className="wfe-props-input"
          value={entryGate}
          onChange={(e) => setEntryGate(e.target.value)}
          placeholder="gate-name"
        />
        <label className="wfe-props-label">Exit Gate</label>
        <input
          className="wfe-props-input"
          value={exitGate}
          onChange={(e) => setExitGate(e.target.value)}
          placeholder="gate-name"
        />
        {data.fallbackStep !== undefined && (
          <>
            <label className="wfe-props-label">Fallback Step</label>
            <input
              className="wfe-props-input"
              value={fallbackStep}
              onChange={(e) => setFallbackStep(e.target.value)}
              placeholder="step-id"
            />
            <label className="wfe-props-label">Fallback Phase</label>
            <input
              className="wfe-props-input"
              value={fallbackPhase}
              onChange={(e) => setFallbackPhase(e.target.value)}
              placeholder="phase-id"
            />
          </>
        )}

        {(data.type as string) === "condition" && (
          <>
            <div className="wfe-props-separator" />
            <label className="wfe-props-label">Prompt</label>
            <textarea
              className="wfe-props-textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Question to ask the user..."
              rows={3}
            />
          </>
        )}
      </div>
      <div className="wfe-props-footer">
        <button className="btn-primary" onClick={handleApply}>
          Apply
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  YAML modal                                                        */
/* ------------------------------------------------------------------ */

interface YamlModalProps {
  initialValue: string;
  onSave: (value: string) => void;
  onClose: () => void;
  title?: string;
}

function YamlModal({ initialValue, onSave, onClose, title }: YamlModalProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState("");

  const handleSave = () => {
    try {
      jsonToDef(value);
      setError("");
      onSave(value);
    } catch {
      setError("Invalid JSON format");
    }
  };

  return (
    <div className="wfe-modal-overlay" onClick={onClose}>
      <div className="wfe-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wfe-modal-header">
          <span>{title || "Export / Import"}</span>
          <button className="wfe-props-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <textarea
          className="wfe-modal-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={20}
          spellCheck={false}
        />
        {error && <p className="wfe-modal-error">{error}</p>}
        <div className="wfe-modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  WorkflowEditor                                                    */
/* ------------------------------------------------------------------ */

function EditorFlow({
  initial,
  onChange,
}: WorkflowEditorProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<ReturnType<typeof useReactFlow> | null>(null);
  const flowUtils = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [editMode, setEditMode] = useState(false);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [workflowName, setWorkflowName] = useState(initial?.name || "untitled");

  useEffect(() => {
    if (initial) {
      const { nodes: fn, edges: fe } = defToFlow(initial);
      setNodes(fn);
      setEdges(fe);
      setWorkflowName(initial.name || "untitled");
    }
  }, [initial]);

  const notifyChange = useCallback(
    (ns: Node[], es: Edge[]) => {
      if (onChange) {
        onChange(flowToDef(workflowName, ns, es));
      }
    },
    [onChange, workflowName],
  );

  const handleNodesChange = useCallback(
    (changes: any) => {
      onNodesChange(changes);
      // debounced notification could go here
    },
    [onNodesChange],
  );

  const handleEdgesChange = useCallback(
    (changes: any) => {
      onEdgesChange(changes);
    },
    [onEdgesChange],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!editMode) return;
      setEdges((eds) => addEdge(connection, eds));
    },
    [editMode, setEdges],
  );

  const onDragOver: OnDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop: OnDrop = useCallback(
    (event) => {
      if (!editMode) return;
      event.preventDefault();
      const type = event.dataTransfer.getData("application/reactflow-type");
      if (!type) return;
      const position = flowUtils.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const newId = nextId();
      const newNode: Node = {
        id: newId,
        type: "stepNode",
        position,
        data: {
          name: type === "condition" ? "New Condition" : "New Step",
          type,
          skill: "",
        },
      };
      setNodes((nds) => nds.concat(newNode));
    },
    [editMode, flowUtils, setNodes],
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (!editMode) return;
      setSelectedNode(node);
    },
    [editMode],
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (!editMode) return;
      setSelectedNode(node);
    },
    [editMode],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!editMode) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        const selected = nodes.filter((n) => n.selected);
        if (selected.length > 0) {
          const ids = new Set(selected.map((n) => n.id));
          setNodes((nds) => nds.filter((n) => !ids.has(n.id)));
          setEdges((eds) =>
            eds.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
          );
          setSelectedNode(null);
        }
      }
    },
    [editMode, nodes, setNodes, setEdges],
  );

  const updateNodeData = useCallback(
    (id: string, data: Partial<Record<string, unknown>>) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...data } } : n,
        ),
      );
    },
    [setNodes],
  );

  const addStep = useCallback(
    (type: "task" | "condition") => {
      if (!editMode) return;
      const position = { x: 40 + _idCounter * 220, y: 40 };
      const newId = nextId();
      const newNode: Node = {
        id: newId,
        type: "stepNode",
        position,
        data: {
          name: type === "condition" ? "New Condition" : "New Step",
          type,
          skill: "",
        },
      };
      setNodes((nds) => nds.concat(newNode));
    },
    [editMode, setNodes],
  );

  const exportDef = useCallback(() => {
    const def = flowToDef(workflowName, nodes, edges);
    setShowExport(true);
    return defToJson(def);
  }, [workflowName, nodes, edges]);

  const importDef = useCallback(
    (json: string) => {
      try {
        const def = jsonToDef(json);
        const { nodes: fn, edges: fe } = defToFlow(def);
        setNodes(fn);
        setEdges(fe);
        setWorkflowName(def.name || "untitled");
        setShowExport(false);
      } catch {
        // handled in modal
      }
    },
    [setNodes, setEdges],
  );

  const exportJson = useMemo(
    () => (nodes.length > 0 ? defToJson(flowToDef(workflowName, nodes, edges)) : ""),
    [workflowName, nodes, edges],
  );

  return (
    <div className="wfe-root" onKeyDown={handleKeyDown} tabIndex={0}>
      {/* Toolbar */}
      <div className="wfe-toolbar">
        <div className="wfe-toolbar-left">
          <input
            className="wfe-name-input"
            value={workflowName}
            onChange={(e) => {
              setWorkflowName(e.target.value);
            }}
            placeholder="Workflow name"
            disabled={!editMode}
          />
        </div>
        <div className="wfe-toolbar-center">
          <div className="wfe-toggle-group">
            <button
              className={`wfe-toggle-btn${!editMode ? " active" : ""}`}
              onClick={() => setEditMode(false)}
            >
              View
            </button>
            <button
              className={`wfe-toggle-btn${editMode ? " active" : ""}`}
              onClick={() => setEditMode(true)}
            >
              Edit
            </button>
          </div>
        </div>
        <div className="wfe-toolbar-right">
          {editMode && (
            <>
              <button
                className="btn-secondary wfe-tb-btn"
                onClick={() => addStep("task")}
                title="Add task step"
              >
                +Step
              </button>
              <button
                className="btn-secondary wfe-tb-btn"
                onClick={() => addStep("condition")}
                title="Add condition node"
              >
                +Cond
              </button>
            </>
          )}
          <button className="btn-secondary wfe-tb-btn" onClick={exportDef}>
            Export
          </button>
        </div>
      </div>

      {/* Palette */}
      {editMode && (
        <div className="wfe-palette">
          <div className="wfe-palette-title">Drag to canvas</div>
          {PALETTE_ITEMS.map((item) => (
            <PaletteItem key={item.type} {...item} />
          ))}
        </div>
      )}

      {/* React Flow */}
      <div className="wfe-flow-wrapper" ref={reactFlowWrapper}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={editMode ? handleNodesChange : undefined}
          onEdgesChange={editMode ? handleEdgesChange : undefined}
          onConnect={editMode ? onConnect : undefined}
          onDragOver={editMode ? onDragOver : undefined}
          onDrop={editMode ? onDrop : undefined}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onPaneClick={onPaneClick}
          nodeTypes={{ stepNode: StepNode }}
          fitView
          attributionPosition="bottom-left"
          nodesDraggable={editMode}
          nodesConnectable={editMode}
          elementsSelectable={editMode}
          panOnDrag
          selectionMode={editMode ? SelectionMode.Partial : undefined}
          selectionOnDrag={editMode}
          panOnScroll
          deleteKeyCode={editMode ? ["Delete", "Backspace"] : []}
          multiSelectionKeyCode="Shift"
        >
          <Background color="var(--border)" gap={20} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeStrokeColor="var(--border)"
            nodeColor="var(--bg-secondary)"
            maskColor="rgba(0,0,0,0.3)"
          />
        </ReactFlow>
      </div>

      {/* Properties panel */}
      {editMode && selectedNode && (
        <div className="wfe-props-overlay">
          <PropertiesPanel
            node={selectedNode}
            onUpdate={updateNodeData}
            onClose={() => setSelectedNode(null)}
          />
        </div>
      )}

      {/* Export modal */}
      {showExport && (
        <YamlModal
          title="Export Workflow (JSON)"
          initialValue={exportJson}
          onSave={() => setShowExport(false)}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}

export function WorkflowEditor(props: WorkflowEditorProps) {
  return (
    <ReactFlowProvider>
      <EditorFlow {...props} />
    </ReactFlowProvider>
  );
}
