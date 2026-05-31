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
import { StepNode, PhaseNode, computeLayout, PHASE_COLORS, type CanvasStep, type CanvasEdge } from "./WorkflowCanvas";
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
  // ── Phase mode ──
  if (def.phases && def.phases.length > 0) {
    const stepMap = new Map(def.steps.map((s) => [s.id, s]));
    const phaseStepGroups = new Map<string, any[]>();
    for (const ph of def.phases) phaseStepGroups.set(ph.id, []);
    for (const s of def.steps) {
      const group = phaseStepGroups.get(s.phaseId || "");
      if (group) group.push(s);
    }
    const incomingEdges = new Map<string, string[]>();
    for (const e of def.edges) {
      if (e.to) {
        if (!incomingEdges.has(e.to)) incomingEdges.set(e.to, []);
        if (!incomingEdges.get(e.to)!.includes(e.from)) {
          incomingEdges.get(e.to)!.push(e.from);
        }
      }
    }
    const stepNameMap = new Map(def.steps.map((s) => [s.id, s.name]));
    const phaseNodes: Node[] = [];
    const edPhaseGap = 120;
    let edCurX = 20;
    for (let idx = 0; idx < (def.phases || []).length; idx++) {
      const ph = def.phases[idx];
      const phaseSteps = phaseStepGroups.get(ph.id) || [];
      const innerSteps = phaseSteps.map((s: CanvasStep) => {
        const deps = incomingEdges.get(s.id) || [];
        return { id: s.id, name: s.name, skill: s.skill, type: s.type, runMode: s.runMode, exitGate: s.exitGate, dependsOn: deps, dependsOnNames: deps.map((d: string) => stepNameMap.get(d) || d) };
      });
      // Estimate phase node width based on max parallel steps in any rank
      const estPad = 20;
      const estGap = 50;
      const stepIds = new Set(innerSteps.map((s: any) => s.id));
      const rankMap2 = new Map<string, number>();
      const inDeg2 = new Map<string, number>();
      for (const s of innerSteps) {
        const deps = (s.dependsOn as string[] || []).filter((d: string) => stepIds.has(d));
        inDeg2.set(s.id, deps.length);
        if (deps.length === 0) rankMap2.set(s.id, 0);
      }
      const q2: string[] = innerSteps.filter((s: any) => inDeg2.get(s.id) === 0).map((s: any) => s.id);
      let qi2 = 0;
      while (qi2 < q2.length) {
        const cur = q2[qi2++];
        const cr = rankMap2.get(cur) ?? 0;
        for (const s of innerSteps) {
          const deps = (s.dependsOn as string[] || []).filter((d: string) => stepIds.has(d));
          if (deps.includes(cur)) {
            inDeg2.set(s.id, inDeg2.get(s.id)! - 1);
            if (!rankMap2.has(s.id) || rankMap2.get(s.id)! < cr + 1) rankMap2.set(s.id, cr + 1);
            if (inDeg2.get(s.id) === 0) q2.push(s.id);
          }
        }
      }
      // Join-aware rank compression (mirrors PhaseNode logic)
      const joins2 = innerSteps.filter((s: any) => (inDeg2.get(s.id) || 0) > 1);
      if (joins2.length > 0) {
        for (const join of joins2) {
          const anc = new Set<string>();
          const q = [...((join.dependsOn as string[] || []).filter((d: string) => stepIds.has(d)))];
          while (q.length) {
            const c = q.shift()!;
            if (anc.has(c)) continue;
            anc.add(c);
            const pd = (innerSteps.find((s: any) => s.id === c)?.dependsOn as string[] || []).filter((d: string) => stepIds.has(d));
            for (const d of pd) { if (!anc.has(d)) q.push(d); }
          }
          const jd = (join.dependsOn as string[] || []).filter((d: string) => stepIds.has(d));
          let mr = Infinity;
          for (const d of jd) { const r2 = rankMap2.get(d) ?? 0; if (r2 < mr) mr = r2; }
          if (mr === Infinity) continue;
          for (const aId of anc) { const cr = rankMap2.get(aId) ?? 0; if (cr > mr) rankMap2.set(aId, mr); }
          rankMap2.set(join.id, mr + 1);
        }
        const uniqueR = [...new Set(rankMap2.values())].sort((a, b) => a - b);
        const renumR = new Map<number, number>();
        uniqueR.forEach((r, i) => renumR.set(r, i));
        for (const [id, r] of rankMap2) rankMap2.set(id, renumR.get(r) ?? r);
      }

      const rankGrp2 = new Map<number, number>();
      for (const [id, r] of rankMap2) {
        rankGrp2.set(r, (rankGrp2.get(r) || 0) + 1);
      }
      const maxCols2 = rankGrp2.size > 0 ? Math.max(...rankGrp2.values()) : 0;
      const dynEstW = 180;
      const estimatedW = Math.max(320, maxCols2 * dynEstW + (maxCols2 - 1) * estGap + estPad + 28);
      phaseNodes.push({
        id: `phase-${ph.id}`,
        type: "phaseNode",
        position: { x: edCurX, y: 0 },
        width: estimatedW,
        data: { phaseId: ph.id, phaseName: ph.name, phaseIdx: idx, entryGate: ph.entry_gate, exitGate: ph.exit_gate, innerSteps, _nodeWidth: estimatedW },
      });
      edCurX += estimatedW + edPhaseGap;
    }
    const phaseEdges: Edge[] = [];
    for (let i = 0; i < (def.phases || []).length - 1; i++) {
      const fromId = `phase-${def.phases[i].id}`;
      const toId = `phase-${def.phases[i + 1].id}`;
      const c = PHASE_COLORS[i % PHASE_COLORS.length];
      phaseEdges.push({ id: `${fromId}->${toId}`, source: fromId, target: toId, animated: true, style: { stroke: c, strokeWidth: 2 } });
    }
    return { nodes: phaseNodes, edges: phaseEdges };
  }

  // ── Flat mode (step-level DAG) ──
  const phaseMap: Record<string, string> = {};
  const phaseIndex = new Map<string, number>();
  let nextIdx = 0;
  for (const s of def.steps) {
    if (s.phaseId) {
      phaseMap[s.id] = s.phaseId;
      if (!phaseIndex.has(s.phaseId)) phaseIndex.set(s.phaseId, nextIdx++);
    }
  }

  const positions = computeLayout(
    def.steps.map((s) => s.id),
    def.edges,
    phaseMap,
  );

  const stepNameMap = new Map(def.steps.map((s) => [s.id, s.name]));
  const dependencyMap = new Map<string, string[]>();
  for (const e of def.edges) {
    if (e.to) {
      if (!dependencyMap.has(e.to)) dependencyMap.set(e.to, []);
      const deps = dependencyMap.get(e.to)!;
      if (!deps.includes(e.from)) deps.push(e.from);
    }
  }

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
      phaseIdx: s.phaseId ? phaseIndex.get(s.phaseId) : undefined,
      runMode: s.runMode,
      entryGate: s.entryGate,
      exitGate: s.exitGate,
      fallbackStep: s.fallbackStep,
      fallbackPhase: s.fallbackPhase,
      dependencySteps: (dependencyMap.get(s.id) || [])
        .map((id) => stepNameMap.get(id) || id),
    },
  }));

  const edges: Edge[] = def.edges
    .filter((e) => e.to)
    .map((e) => {
      const srcPhase = phaseMap[e.from];
      const tgtPhase = phaseMap[e.to!];
      const samePhase = srcPhase && tgtPhase && srcPhase === tgtPhase;
      const idx = srcPhase ? phaseIndex.get(srcPhase) ?? 0 : 0;
      const phaseColor = PHASE_COLORS[idx % PHASE_COLORS.length];

      return {
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to!,
        label: e.label,
        animated: samePhase,
        style: {
          stroke: samePhase ? phaseColor : "var(--border)",
          strokeWidth: samePhase ? 2 : 1.5,
          strokeDasharray: samePhase ? undefined : "4 3",
        },
        labelStyle: { fontSize: 11, fill: "var(--text-muted)" },
      };
    });
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
      skill: d.skill as string | string[] | undefined,
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
  const [skillText, setSkillText] = useState(
    Array.isArray(data.skill) ? (data.skill as string[]).join(", ") : (data.skill as string) || "",
  );
  const [prompt, setPrompt] = useState((data.prompt as string) || "");
  const [phaseName, setPhaseName] = useState((data.phaseName as string) || "");
  const [runMode, setRunMode] = useState((data.runMode as string) || "serial");
  const [entryGate, setEntryGate] = useState((data.entryGate as string) || "");
  const [exitGate, setExitGate] = useState((data.exitGate as string) || "");
  const [fallbackStep, setFallbackStep] = useState((data.fallbackStep as string) || "");
  const [fallbackPhase, setFallbackPhase] = useState((data.fallbackPhase as string) || "");

  useEffect(() => {
    setName((data.name as string) || "");
    setSkillText(
      Array.isArray(data.skill) ? (data.skill as string[]).join(", ") : (data.skill as string) || "",
    );
    setPrompt((data.prompt as string) || "");
    setPhaseName((data.phaseName as string) || "");
    setRunMode((data.runMode as string) || "serial");
    setEntryGate((data.entryGate as string) || "");
    setExitGate((data.exitGate as string) || "");
    setFallbackStep((data.fallbackStep as string) || "");
    setFallbackPhase((data.fallbackPhase as string) || "");
  }, [data]);

  const handleApply = () => {
    const skills = skillText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const resolvedSkill = skills.length > 1 ? skills : (skills[0] || "");
    onUpdate(node.id, { name, skill: resolvedSkill, prompt, phaseName, runMode, entryGate, exitGate, fallbackStep, fallbackPhase });
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
        <label className="wfe-props-label">Skill(s)</label>
        <input
          className="wfe-props-input"
          value={skillText}
          onChange={(e) => setSkillText(e.target.value)}
          placeholder="skill-name (comma-separated for chain)"
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
          nodeTypes={{ stepNode: StepNode, phaseNode: PhaseNode }}
          defaultViewport={{ x: 20, y: 20, zoom: 1 }}
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
