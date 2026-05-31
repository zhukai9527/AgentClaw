import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

/** Phase color palette — distinct hues for up to 12 phases */
export const PHASE_COLORS = [
  "#22c55e", "#3b82f6", "#f59e0b", "#ef4444",
  "#8b5cf6", "#06b6d4", "#ec4899", "#14b8a6",
  "#f97316", "#6366f1", "#84cc16", "#a855f7",
];

export interface CanvasStep {
  id: string;
  name: string;
  type: "task" | "condition";
  status?: "pending" | "running" | "done" | "failed" | "waiting";
  skillSource?: "workspace" | "system";
  skill?: string;
  /** Phase grouping (Codex-style) */
  phaseId?: string;
  phaseName?: string;
  runMode?: "serial" | "parallel" | "join";
  entryGate?: string;
  exitGate?: string;
  fallbackStep?: string;
  fallbackPhase?: string;
}

export interface CanvasEdge {
  from: string;
  to: string | null;
  label?: string;
}

export interface LayoutPos {
  x: number;
  y: number;
}

/**
 * Compute a ranked DAG layout (left-to-right hierarchy) with phase awareness.
 * Nodes connected by edges are assigned ranks based on longest path from root.
 * Within each phase, nodes are grouped; extra spacing separates different phases.
 */
export function computeLayout(
  stepIds: string[],
  edges: CanvasEdge[],
  phaseMap?: Record<string, string>,
): Map<string, LayoutPos> {
  const predecessors = new Map<string, string[]>();
  const allNodes = new Set(stepIds);

  for (const e of edges) {
    if (e.from) allNodes.add(e.from);
    if (e.to) allNodes.add(e.to);
  }

  const nodeList = Array.from(allNodes);
  for (const id of nodeList) predecessors.set(id, []);

  for (const e of edges) {
    if (e.from && e.to) {
      const preds = predecessors.get(e.to);
      if (preds) preds.push(e.from);
    }
  }

  const ranks = new Map<string, number>();

  function getRank(id: string): number {
    const cached = ranks.get(id);
    if (cached !== undefined) return cached;
    const preds = predecessors.get(id) || [];
    if (preds.length === 0) {
      ranks.set(id, 0);
      return 0;
    }
    let maxRank = -1;
    for (const p of preds) maxRank = Math.max(maxRank, getRank(p));
    ranks.set(id, maxRank + 1);
    return maxRank + 1;
  }

  for (const id of nodeList) getRank(id);

  const rankGroups = new Map<number, string[]>();
  for (const [id, rank] of ranks) {
    if (!rankGroups.has(rank)) rankGroups.set(rank, []);
    rankGroups.get(rank)!.push(id);
  }

  const H_SPACING = 180;
  const V_SPACING = 70;
  const PHASE_GAP = 120;

  const positions = new Map<string, LayoutPos>();
  const sortedRanks = Array.from(rankGroups.keys()).sort((a, b) => a - b);

  // Compute phase y-offsets: track phase transitions across ranks
  const phaseYOffsets = new Map<string, number>();
  const visitedPhaseOrder: string[] = [];
  if (phaseMap) {
    for (const rank of sortedRanks) {
      for (const id of rankGroups.get(rank)!) {
        const ph = phaseMap[id];
        if (ph && !phaseYOffsets.has(ph)) {
          phaseYOffsets.set(ph, visitedPhaseOrder.length * PHASE_GAP);
          visitedPhaseOrder.push(ph);
        }
      }
    }
  }

  for (const rank of sortedRanks) {
    const ids = rankGroups.get(rank)!;
    // Group nodes in this rank by phase to compute per-phase y centers
    const phaseGroups = new Map<string, string[]>();
    const noPhase: string[] = [];
    for (const id of ids) {
      const ph = phaseMap?.[id];
      if (ph) {
        if (!phaseGroups.has(ph)) phaseGroups.set(ph, []);
        phaseGroups.get(ph)!.push(id);
      } else {
        noPhase.push(id);
      }
    }

    let yCursor = -((ids.length - 1) * V_SPACING) / 2;

    // Place non-phase nodes first
    if (noPhase.length > 0) {
      const blockH = (noPhase.length - 1) * V_SPACING;
      const startY = yCursor + (noPhase.length > 1 ? 0 : 0);
      noPhase.forEach((id, i) => {
        positions.set(id, { x: rank * H_SPACING, y: startY + i * V_SPACING });
      });
      yCursor += blockH + V_SPACING;
    }

    // Place phase-grouped nodes with phase offset
    let firstInRank = true;
    for (const [ph, pids] of phaseGroups) {
      const yOff = phaseYOffsets.get(ph) || 0;
      const blockH = (pids.length - 1) * V_SPACING;
      const startY = yCursor + yOff;
      pids.forEach((id, i) => {
        positions.set(id, { x: rank * H_SPACING, y: startY + i * V_SPACING });
      });
      yCursor += blockH + V_SPACING;
    }
  }

  return positions;
}

interface WorkflowCanvasProps {
  steps: CanvasStep[];
  edges: CanvasEdge[];
  fitView?: boolean;
}

export function StepNode({ data }: NodeProps) {
  const statusColors: Record<string, string> = {
    pending: "var(--text-muted)",
    running: "var(--accent)",
    done: "var(--success, #22c55e)",
    failed: "var(--danger, #ef4444)",
    waiting: "var(--text-secondary)",
  };

  const borderColor = statusColors[data.status ?? "pending"];
  const isCondition = data.type === "condition";
  const hasPhase = !!data.phaseId;
  const phaseIdx = data.phaseIdx as number | undefined;
  const phaseColor = phaseIdx !== undefined ? PHASE_COLORS[phaseIdx % PHASE_COLORS.length] : undefined;

  return (
    <div
      className="wf-node"
      style={{
        border: `2px solid ${borderColor}`,
        borderLeft: phaseColor ? `5px solid ${phaseColor}` : `2px solid ${borderColor}`,
        borderRadius: "var(--radius)",
        background: "var(--bg-secondary)",
        padding: "10px 16px",
        minWidth: 160,
        fontSize: 13,
        position: "relative",
      }}
    >
      <Handle type="target" position={Position.Left} />
      {data.phaseName && phaseColor && (
        <div
          style={{
            fontSize: 10,
            color: phaseColor,
            marginBottom: 6,
            fontWeight: 600,
            letterSpacing: "0.5px",
            textTransform: "uppercase" as const,
          }}
        >
          {data.phaseName}
          {data.runMode && data.runMode !== "serial" && (
            <span
              style={{
                marginLeft: 6,
                padding: "1px 5px",
                borderRadius: 3,
                background: `${phaseColor}20`,
                color: phaseColor,
                fontSize: 9,
                textTransform: "none" as const,
              }}
            >
              {data.runMode}
            </span>
          )}
        </div>
      )}
      <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 2 }}>
        {data.name}
      </div>
      {data.skill && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 4, alignItems: "center", marginTop: 4 }}>
          <span style={{ color: phaseColor || "var(--text-muted)", fontWeight: 500 }}>{data.skill}</span>
          {data.skillSource && (
            <span
              style={{
                fontSize: 10,
                padding: "0 4px",
                borderRadius: 3,
                background: data.skillSource === "workspace" ? "var(--accent)" : "var(--text-muted)",
                color: "#fff",
              }}
            >
              {data.skillSource}
            </span>
          )}
        </div>
      )}
      {data.dependencySteps && (data.dependencySteps as string[]).length > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3, display: "flex", gap: 2, flexWrap: "wrap" }}>
          <span style={{ opacity: 0.6 }}>←</span>
          {(data.dependencySteps as string[]).slice(0, 3).join(", ")}
          {(data.dependencySteps as string[]).length > 3 && "…"}
        </div>
      )}
      {isCondition && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Condition</div>}
      {data.entryGate && (
        <div style={{ fontSize: 10, color: "var(--warning)", marginTop: 2 }}>⛩ {data.entryGate}</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { stepNode: StepNode };

export function WorkflowCanvas({ steps, edges, fitView }: WorkflowCanvasProps) {
  const { nodes, flowEdges } = useMemo(() => {
    // Build phase map for layout
    const phaseMap: Record<string, string> = {};
    const phaseIndex = new Map<string, number>();
    let nextPhaseIdx = 0;
    for (const s of steps) {
      if (s.phaseId) {
        phaseMap[s.id] = s.phaseId;
        if (!phaseIndex.has(s.phaseId)) {
          phaseIndex.set(s.phaseId, nextPhaseIdx++);
        }
      }
    }

    const positions = computeLayout(
      steps.map((s) => s.id),
      edges,
      phaseMap,
    );

    // Compute dependency steps from edges for each node
    const stepNameMap = new Map(steps.map((s) => [s.id, s.name]));
    const dependencyMap = new Map<string, string[]>();
    for (const e of edges) {
      if (e.to) {
        if (!dependencyMap.has(e.to)) dependencyMap.set(e.to, []);
        const deps = dependencyMap.get(e.to)!;
        if (!deps.includes(e.from)) deps.push(e.from);
      }
    }

    const nodes: Node[] = steps.map((step) => {
      const pos = positions.get(step.id) || { x: 0, y: 0 };
      return {
        id: step.id,
        type: "stepNode",
        position: pos,
        data: {
          name: step.name,
          type: step.type,
          status: step.status,
          skill: step.skill,
          skillSource: step.skillSource,
          phaseId: step.phaseId,
          phaseName: step.phaseName,
          phaseIdx: step.phaseId ? phaseIndex.get(step.phaseId) : undefined,
          runMode: step.runMode,
          entryGate: step.entryGate,
          exitGate: step.exitGate,
          dependencySteps: (dependencyMap.get(step.id) || [])
            .map((id) => stepNameMap.get(id) || id),
        },
      };
    });

    // Deduplicate edges (same from→to may appear from serial + depends_on)
    const seenEdges = new Set<string>();
    const uniqueEdges = edges.filter((e) => {
      if (!e.to) return false;
      const key = `${e.from}->${e.to}`;
      if (seenEdges.has(key)) return false;
      seenEdges.add(key);
      return true;
    });

    const flowEdges: Edge[] = uniqueEdges.map((e) => {
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

    return { nodes, flowEdges };
  }, [steps, edges]);

  return (
    <div style={{ width: "100%", height: "100%", minHeight: 300 }}>
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView={fitView}
        defaultViewport={{ x: 20, y: 20, zoom: 1 }}
        attributionPosition="bottom-left"
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        minZoom={0.3}
        maxZoom={2}
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
  );
}
