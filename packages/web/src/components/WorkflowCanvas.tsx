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
}

export interface CanvasEdge {
  from: string;
  to: string | null;
  label?: string;
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
      <Handle type="target" position={Position.Top} />
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
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const nodeTypes = { stepNode: StepNode };

export function WorkflowCanvas({ steps, edges, fitView = true }: WorkflowCanvasProps) {
  const { nodes, flowEdges } = useMemo(() => {
    const nodes: Node[] = steps.map((step, i) => ({
      id: step.id,
      type: "stepNode",
      position: { x: 0, y: i * 120 },
      data: {
        name: step.name,
        type: step.type,
        status: step.status,
        skill: step.skill,
        skillSource: step.skillSource,
      },
    }));

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
