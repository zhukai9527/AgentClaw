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
 * Compute a ranked DAG layout (left-to-right hierarchy).
 * Nodes connected by edges are assigned ranks based on longest path from root.
 * Within each rank, nodes are evenly spaced vertically.
 */
export function computeLayout(
  stepIds: string[],
  edges: CanvasEdge[],
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

  const H_SPACING = 240;
  const V_SPACING = 100;

  const positions = new Map<string, LayoutPos>();
  const sortedRanks = Array.from(rankGroups.keys()).sort((a, b) => a - b);

  for (const rank of sortedRanks) {
    const ids = rankGroups.get(rank)!;
    const totalHeight = (ids.length - 1) * V_SPACING;
    const startY = -totalHeight / 2;
    ids.forEach((id, i) => {
      positions.set(id, { x: rank * H_SPACING, y: startY + i * V_SPACING });
    });
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
  const hasPhase = data.phaseName || data.phaseId;

  return (
    <div
      className="wf-node"
      style={{
        border: `2px solid ${borderColor}`,
        borderRadius: "var(--radius)",
        background: "var(--bg-secondary)",
        padding: "10px 16px",
        minWidth: 140,
        fontSize: 13,
        position: "relative",
      }}
    >
      <Handle type="target" position={Position.Left} />
      {hasPhase && (
        <div style={{ fontSize: 10, color: "var(--accent)", marginBottom: 4, fontWeight: 500 }}>
          {data.phaseName || data.phaseId}
          {data.runMode && data.runMode !== "serial" && (
            <span style={{ marginLeft: 6, padding: "0 4px", borderRadius: 3, background: "var(--accent-subtle-bg)" }}>
              {data.runMode}
            </span>
          )}
        </div>
      )}
      <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 2 }}>
        {data.name}
      </div>
      {data.skill && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 4, alignItems: "center" }}>
          <span>{data.skill}</span>
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
      {isCondition && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Condition</div>}
      {data.entryGate && (
        <div style={{ fontSize: 10, color: "var(--warning)", marginTop: 2 }}>⛩ {data.entryGate}</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { stepNode: StepNode };

export function WorkflowCanvas({ steps, edges, fitView = true }: WorkflowCanvasProps) {
  const { nodes, flowEdges } = useMemo(() => {
    const positions = computeLayout(
      steps.map((s) => s.id),
      edges,
    );

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
        },
      };
    });

    const flowEdges: Edge[] = edges
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

    return { nodes, flowEdges };
  }, [steps, edges]);

  return (
    <div style={{ width: "100%", height: "100%", minHeight: 300 }}>
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView={fitView}
        attributionPosition="bottom-left"
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
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
