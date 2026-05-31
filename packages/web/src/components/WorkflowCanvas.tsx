import { useMemo, Fragment } from "react";
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

/* ────────────────────────────────────────────── */
/*  computeLayout — ranked DAG (kept for flat mode) */
/* ────────────────────────────────────────────── */

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
    if (preds.length === 0) { ranks.set(id, 0); return 0; }
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
  // Global * { box-sizing:border-box } → maxWidth:320 IS the total box width
  const NODE_W = 320, RANK_GAP = 40, V_SPACING = 100, PHASE_GAP = 120;
  const positions = new Map<string, LayoutPos>();
  const sortedRanks = Array.from(rankGroups.keys()).sort((a, b) => a - b);

  // Compute cumulative x offset for each rank: sum of max widths of all previous ranks + gaps
  const rankXOffsets = new Map<number, number>();
  {
    let cx = 0;
    for (const rank of sortedRanks) {
      rankXOffsets.set(rank, cx);
      // Use estimated max node width per rank; currently all nodes share the same estimate
      // This can be replaced with per-rank max width measurement if node widths are known
      cx += NODE_W + RANK_GAP;
    }
  }

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
    const baseX = rankXOffsets.get(rank) ?? rank * (NODE_W + RANK_GAP);
    let yCursor = -((ids.length - 1) * V_SPACING) / 2;
    if (noPhase.length > 0) {
      const blockH = (noPhase.length - 1) * V_SPACING;
      noPhase.forEach((id, i) => { positions.set(id, { x: baseX, y: yCursor + i * V_SPACING }); });
      yCursor += blockH + V_SPACING;
    }
    for (const [ph, pids] of phaseGroups) {
      const yOff = phaseYOffsets.get(ph) || 0;
      const blockH = (pids.length - 1) * V_SPACING;
      pids.forEach((id, i) => { positions.set(id, { x: baseX, y: yCursor + yOff + i * V_SPACING }); });
      yCursor += blockH + V_SPACING;
    }
  }
  return positions;
}

/* ────────────────────────────────────────────── */
/*  Inner step card (used inside PhaseNode)       */
/* ────────────────────────────────────────────── */

const STEP_CARD_H = 80;
const STEP_CARD_W = 180;
const STEP_GAP = 50;

function InnerStepCard({
  name,
  skill,
  type,
  exitGate,
  phaseColor,
  width = STEP_CARD_W,
}: {
  name: string;
  skill: string | string[] | undefined;
  type: string;
  exitGate?: string;
  phaseColor: string;
  width?: number;
}) {
  const skills = skill ? (Array.isArray(skill) ? skill : [skill]) : [];
  return (
    <div
      style={{
        width,
        height: STEP_CARD_H,
        background: "var(--bg-tertiary, #1e293b)",
        border: `1px solid ${phaseColor}40`,
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 11,
        lineHeight: 1.3,
        display: "flex",
        flexDirection: "column" as const,
        justifyContent: "center",
        overflow: "hidden",
        boxSizing: "border-box" as const,
      }}
    >
      <div title={name} style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 2, fontSize: 12, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>
        {name}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 2 }}>
        {skills.map((s, i) => (
          <span
            key={i}
            title={s}
            style={{
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 3,
              background: `${phaseColor}18`,
              color: phaseColor,
              border: `1px solid ${phaseColor}30`,
              whiteSpace: "nowrap" as const,
              maxWidth: 160,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {s}
          </span>
        ))}
      </div>
      {type === "condition" && (
        <div style={{ fontSize: 10, color: "var(--warning)", marginTop: 2 }}>Condition</div>
      )}
      {exitGate && (
        <div title={exitGate} style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.2, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>
          🚪 {exitGate.length > 40 ? exitGate.slice(0, 40) + "…" : exitGate}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────── */
/*  PhaseNode — big container with embedded steps */
/* ────────────────────────────────────────────── */

export function PhaseNode({ data }: NodeProps) {
  const phaseColor = PHASE_COLORS[(data.phaseIdx as number) % PHASE_COLORS.length];
  const innerSteps = data.innerSteps as any[];
  const entryGate = data.entryGate as string | undefined;
  const exitGate = data.exitGate as string | undefined;

  // Compute intra-phase ranks (topological sort for grid layout)
  const CARD_GAP = 50;
  const contentPad = 20;
  const stepIds = new Set(innerSteps.map((s) => s.id));
  const rankMap = (() => {
    const ranks = new Map<string, number>();
    const inDegree = new Map<string, number>();
    for (const s of innerSteps) {
      const deps = (s.dependsOn as string[] || []).filter((d: string) => stepIds.has(d));
      inDegree.set(s.id, deps.length);
      if (deps.length === 0) ranks.set(s.id, 0);
    }
    const queue: string[] = [];
    for (const s of innerSteps) { if (inDegree.get(s.id) === 0) queue.push(s.id); }
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const curRank = ranks.get(cur) ?? 0;
      for (const s of innerSteps) {
        const deps = (s.dependsOn as string[] || []).filter((d: string) => stepIds.has(d));
        if (deps.includes(cur)) {
          const nr = curRank + 1;
          inDegree.set(s.id, inDegree.get(s.id)! - 1);
          if (!ranks.has(s.id) || ranks.get(s.id)! < nr) ranks.set(s.id, nr);
          if (inDegree.get(s.id) === 0) queue.push(s.id);
        }
      }
    }
    return ranks;
  })();

  // Compress ranks around join nodes: all predecessors of a join get pulled to the
  // same rank so the fan-in structure is visually clear.
  const compressedRankMap = (() => {
    // Build in-degree to identify joins
    const inDeg = new Map<string, number>();
    for (const s of innerSteps) {
      const deps = (s.dependsOn as string[] || []).filter((d: string) => stepIds.has(d));
      inDeg.set(s.id, deps.length);
    }
    const joins = innerSteps.filter(s => (inDeg.get(s.id) || 0) > 1);
    if (joins.length === 0) return rankMap;

    const result = new Map(rankMap);
    for (const join of joins) {
      // BFS backward to collect all ancestors
      const ancestors = new Set<string>();
      const queue = [...((join.dependsOn as string[] || []).filter((d: string) => stepIds.has(d)))];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (ancestors.has(cur)) continue;
        ancestors.add(cur);
        const s = innerSteps.find(s => s.id === cur);
        if (!s) continue;
        const deps = (s.dependsOn as string[] || []).filter((d: string) => stepIds.has(d));
        for (const d of deps) { if (!ancestors.has(d)) queue.push(d); }
      }

      // Find min rank among direct predecessors
      const joinDeps = (join.dependsOn as string[] || []).filter((d: string) => stepIds.has(d));
      let minRank = Infinity;
      for (const d of joinDeps) {
        const r = rankMap.get(d) ?? 0;
        if (r < minRank) minRank = r;
      }
      if (minRank === Infinity) continue;

      // Compress ancestors whose rank is deeper than minRank
      for (const aId of ancestors) {
        const cr = result.get(aId) ?? 0;
        if (cr > minRank) result.set(aId, minRank);
      }
      // Place join at next rank
      result.set(join.id, minRank + 1);
    }

    // Renumber to consecutive ranks
    const unique = [...new Set(result.values())].sort((a, b) => a - b);
    const renum = new Map<number, number>();
    unique.forEach((r, i) => renum.set(r, i));
    for (const [id, r] of result) result.set(id, renum.get(r) ?? r);
    return result;
  })();

  const rankGroups = new Map<number, typeof innerSteps>();
  for (const s of innerSteps) {
    const r = compressedRankMap.get(s.id) ?? 0;
    if (!rankGroups.has(r)) rankGroups.set(r, []);
    rankGroups.get(r)!.push(s);
  }
  const sortedRanks = Array.from(rankGroups.entries()).sort((a, b) => a[0] - b[0]);
  const maxCols = sortedRanks.length > 0 ? Math.max(...sortedRanks.map(([, g]) => g.length)) : 0;
  const numRanks = sortedRanks.length;
  const dynCardW = STEP_CARD_W;
  const contentW = maxCols > 0 ? maxCols * dynCardW + (maxCols - 1) * CARD_GAP + contentPad : dynCardW + contentPad;
  const contentH = numRanks > 0 ? numRanks * (STEP_CARD_H + STEP_GAP) - STEP_GAP : 0;
  const nodeMinH = 100 + (innerSteps.length > 0 ? contentH + contentPad : 0) + (exitGate ? 30 : 0);

  // Compute absolute positions for each step card
  interface CardPos { id: string; x: number; y: number; }
  const cardPositions = new Map<string, CardPos>();
  for (const [rank, group] of sortedRanks) {
    const rowW = group.length * dynCardW + (group.length - 1) * CARD_GAP;
    const startX = (contentW - rowW) / 2;
    group.forEach((s, col) => {
      cardPositions.set(s.id, {
        id: s.id,
        x: startX + col * (dynCardW + CARD_GAP),
        y: rank * (STEP_CARD_H + STEP_GAP),
      });
    });
  }

  // Build intra-phase edges
  const phEdges: { from: string; to: string }[] = [];
  for (const s of innerSteps) {
    const deps = (s.dependsOn as string[] || []).filter((d: string) => stepIds.has(d));
    for (const d of deps) phEdges.push({ from: d, to: s.id });
  }

  return (
    <div
      style={{
        border: `2px solid ${phaseColor}`,
        borderRadius: "var(--radius)",
        background: "var(--bg-secondary)",
        minWidth: 320,
        minHeight: nodeMinH,
        position: "relative",
        overflow: "hidden",
        fontSize: 13,
      }}
    >
      <Handle type="target" position={Position.Left} />

      {/* Phase color bar */}
      <div style={{ height: 5, background: phaseColor }} />

      {/* ── Phase header ── */}
      <div style={{ padding: "10px 14px 6px" }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: phaseColor,
            letterSpacing: "0.3px",
            marginBottom: 4,
          }}
        >
          {data.phaseName as string}
        </div>
        {entryGate && (
          <div style={{ fontSize: 10, color: "var(--warning)", marginBottom: 2, lineHeight: 1.3 }}>
            ⛩ {entryGate.length > 80 ? entryGate.slice(0, 80) + "…" : entryGate}
          </div>
        )}
      </div>

      {/* ── Inner step mini-flow (grid layout with SVG arrows) ── */}
      <div
        style={{
          padding: "8px 12px 12px",
          position: "relative",
          width: contentW,
          minHeight: contentH,
          margin: "0 auto",
        }}
      >
        {/* SVG arrow layer */}
        <svg
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            overflow: "visible",
          }}
        >
          {(() => {
            // Precompute fan-out offsets: spread edges across source/target card width
            const srcEdgesMap = new Map<string, string[]>();
            const tgtEdgesMap = new Map<string, string[]>();
            for (const e of phEdges) {
              if (!srcEdgesMap.has(e.from)) srcEdgesMap.set(e.from, []);
              if (!tgtEdgesMap.has(e.to)) tgtEdgesMap.set(e.to, []);
              srcEdgesMap.get(e.from)!.push(e.to);
              tgtEdgesMap.get(e.to)!.push(e.from);
            }
            return phEdges.map((edge, i) => {
              const from = cardPositions.get(edge.from);
              const to = cardPositions.get(edge.to);
              if (!from || !to) return null;
              const fanW = Math.min(dynCardW - 4, 120);
              const srcList = srcEdgesMap.get(edge.from) || [];
              const tgtList = tgtEdgesMap.get(edge.to) || [];
              const srcIdx = srcList.indexOf(edge.to);
              const tgtIdx = tgtList.indexOf(edge.from);
              const srcOffset = srcList.length > 1 ? (srcIdx + 1) / (srcList.length + 1) * fanW + (dynCardW - fanW) / 2 : dynCardW / 2;
              const tgtOffset = tgtList.length > 1 ? (tgtIdx + 1) / (tgtList.length + 1) * fanW + (dynCardW - fanW) / 2 : dynCardW / 2;
              const x1 = from.x + srcOffset;
              const y1 = from.y + STEP_CARD_H;
              const x2 = to.x + tgtOffset;
              const y2 = to.y;
              const midY = (y1 + y2) / 2;
              // Compute arrowhead direction: evaluate cubic Bezier near endpoint (t=0.9)
              // for curves, or use line direction for straight paths
              const isStraightArrow = Math.abs(x1 - x2) < 2;
              let adx: number, ady: number;
              if (isStraightArrow) {
                adx = 0;
                ady = y2 - y1;
              } else {
                const ppx = 0.028 * x1 + 0.972 * x2;
                const ppy = 0.001 * y1 + 0.27 * midY + 0.729 * y2;
                adx = x2 - ppx;
                ady = y2 - ppy;
              }
              const aLen = Math.sqrt(adx * adx + ady * ady) || 1;
              const aux = adx / aLen;
              const auy = ady / aLen;
              const apx = -auy;
              const apy = aux;
              const ahH = 8;
              const ahW = 5;
              const arrowPoints = `${x2},${y2} ${x2 - aux * ahH + apx * ahW},${y2 - auy * ahH + apy * ahW} ${x2 - aux * ahH - apx * ahW},${y2 - auy * ahH - apy * ahW}`;
              return (
                <g key={i}>
                  <path
                    d={isStraightArrow
                      ? `M${x1},${y1} L${x1},${y2}`
                      : `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`
                    }
                    stroke={phaseColor}
                    strokeWidth="1.5"
                    fill="none"
                  />
                  <polygon
                    points={arrowPoints}
                    fill={phaseColor}
                  />
                </g>
              );
            });
          })()}
        </svg>
        {/* Cards layer */}
        {sortedRanks.map(([rank, group]) => (
          <div
            key={rank}
            style={{
              position: "absolute",
              top: rank * (STEP_CARD_H + STEP_GAP),
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "center",
              gap: CARD_GAP,
            }}
          >
            {group.map((s: any) => (
              <InnerStepCard
                key={s.id}
                name={s.name}
                skill={s.skill}
                type={s.type}
                exitGate={s.exitGate}
                phaseColor={phaseColor}
                width={dynCardW}
              />
            ))}
          </div>
        ))}
      </div>

      {/* ── Phase footer: exit gate ── */}
      {exitGate && (
        <div
          style={{
            padding: "2px 14px 8px",
            fontSize: 10,
            color: "var(--text-muted)",
            lineHeight: 1.3,
          }}
        >
          🚪 {exitGate.length > 100 ? exitGate.slice(0, 100) + "…" : exitGate}
        </div>
      )}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/* ────────────────────────────────────────────── */
/*  StepNode — flat DAG node (kept for flat mode) */
/* ────────────────────────────────────────────── */

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
  const phaseIdx = data.phaseIdx as number | undefined;
  const phaseColor = phaseIdx !== undefined ? PHASE_COLORS[phaseIdx % PHASE_COLORS.length] : undefined;
  const rawSkill = data.skill;
  const skillList: string[] = rawSkill
    ? Array.isArray(rawSkill) ? rawSkill : [rawSkill]
    : [];
  const rawSource = data.skillSource;
  const sourceList: string[] = rawSource
    ? Array.isArray(rawSource) ? rawSource : [rawSource]
    : [];

  return (
    <div
      style={{
        border: `2px solid ${borderColor}`,
        borderRadius: "var(--radius)",
        background: "var(--bg-secondary)",
        minWidth: 180,
        maxWidth: 320,
        fontSize: 13,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <Handle type="target" position={Position.Left} />
      {phaseColor && <div style={{ height: 4, background: phaseColor }} />}
      <div style={{ padding: "8px 12px 4px" }}>
        {data.phaseName && phaseColor && (
          <div style={{ fontSize: 10, color: phaseColor, marginBottom: 4, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase" as const }}>
            {data.phaseName as string}
            {data.runMode && data.runMode !== "serial" && (
              <span style={{ marginLeft: 6, padding: "1px 5px", borderRadius: 3, background: `${phaseColor}20`, color: phaseColor, fontSize: 9, textTransform: "none" as const }}>
                {data.runMode as string}
              </span>
            )}
          </div>
        )}
        <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 2, lineHeight: 1.3, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>
          {data.name as string}
        </div>
        {isCondition && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Condition</div>}
        {data.entryGate && <div style={{ fontSize: 10, color: "var(--warning)", marginTop: 2 }}>⛩ {data.entryGate as string}</div>}
      </div>

      {skillList.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0 0", padding: "6px 12px 8px", display: "flex", flexDirection: "column" as const, gap: 2 }}>
          {skillList.map((name, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {i > 0 && <span style={{ color: "var(--text-muted)", fontSize: 10, width: 10, flexShrink: 0, textAlign: "center" }}>↓</span>}
              {i === 0 && <span style={{ width: 10, flexShrink: 0 }} />}
              <span style={{ fontSize: 11, fontWeight: 500, color: phaseColor || "var(--text-muted)", background: phaseColor ? `${phaseColor}12` : "transparent", padding: "2px 8px", borderRadius: 4, border: `1px solid ${phaseColor ? phaseColor + "30" : "var(--border)"}`, whiteSpace: "nowrap" as const, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                {name}
              </span>
              {sourceList[i] && (
                <span style={{ fontSize: 9, padding: "0 4px", borderRadius: 3, background: sourceList[i] === "workspace" ? "var(--accent)" : "var(--text-muted)", color: "#fff", lineHeight: "16px" }}>
                  {sourceList[i]}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {data.dependencySteps && (data.dependencySteps as string[]).length > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", padding: "2px 12px 6px", display: "flex", gap: 2, flexWrap: "wrap" as const, borderTop: skillList.length > 0 ? "1px solid var(--border)" : undefined }}>
          <span style={{ opacity: 0.6 }}>←</span>
          {(data.dependencySteps as string[]).slice(0, 3).join(", ")}
          {(data.dependencySteps as string[]).length > 3 && "…"}
        </div>
      )}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { stepNode: StepNode, phaseNode: PhaseNode };

/* ────────────────────────────────────────────── */
/*  WorkflowCanvas — dual mode                    */
/* ────────────────────────────────────────────── */

interface WorkflowCanvasProps {
  steps: CanvasStep[];
  edges: CanvasEdge[];
  /** When provided, renders phase-level nodes instead of flat steps */
  phases?: any[];
  fitView?: boolean;
}

export function WorkflowCanvas({ steps, edges, phases, fitView }: WorkflowCanvasProps) {
  const { nodes, flowEdges } = useMemo(() => {
    // ── Phase mode ──
    if (phases && phases.length > 0) {
      // Group steps by phaseId
      const stepMap = new Map(steps.map((s) => [s.id, s]));
      const phaseStepGroups = new Map<string, any[]>();
      for (const ph of phases) {
        phaseStepGroups.set(ph.id, []);
      }
      for (const s of steps) {
        const group = phaseStepGroups.get(s.phaseId || "");
        if (group) group.push(s);
      }

      // Build edge lookup for depends_on (deduplicated — serial + depends_on can create duplicates)
      const incomingEdges = new Map<string, string[]>();
      for (const e of edges) {
        if (e.to) {
          if (!incomingEdges.has(e.to)) incomingEdges.set(e.to, []);
          if (!incomingEdges.get(e.to)!.includes(e.from)) {
            incomingEdges.get(e.to)!.push(e.from);
          }
        }
      }
      const stepNameMap = new Map(steps.map((s) => [s.id, s.name]));

      const phaseNodes: Node[] = [];
      const phPhaseGap = 120;
      let curPhaseX = 20;
      for (let idx = 0; idx < phases.length; idx++) {
        const ph = phases[idx];
        const phaseSteps = phaseStepGroups.get(ph.id) || [];
        const innerSteps = phaseSteps.map((s: CanvasStep) => {
          const deps = incomingEdges.get(s.id) || [];
          return {
            id: s.id,
            name: s.name,
            skill: s.skill,
            type: s.type,
            runMode: s.runMode,
            exitGate: s.exitGate,
            dependsOn: deps,
            dependsOnNames: deps.map((d) => stepNameMap.get(d) || d),
          };
        });
        // Estimate PhaseNode width from rank-based layout
        const phEstIds = new Set(phaseSteps.map((s: any) => s.id));
        const phEstRankMap = new Map<string, number>();
        const phEstInDeg = new Map<string, number>();
        for (const s of phaseSteps) {
          const deps = (incomingEdges.get(s.id) || []).filter((d: string) => phEstIds.has(d));
          phEstInDeg.set(s.id, deps.length);
          if (deps.length === 0) phEstRankMap.set(s.id, 0);
        }
        const phQ: string[] = phaseSteps.filter((s: any) => phEstInDeg.get(s.id) === 0).map((s: any) => s.id);
        let phQi = 0;
        while (phQi < phQ.length) {
          const cur = phQ[phQi++];
          const cr = phEstRankMap.get(cur) ?? 0;
          for (const s of phaseSteps) {
            const deps = (incomingEdges.get(s.id) || []).filter((d: string) => phEstIds.has(d));
            if (deps.includes(cur)) {
              phEstInDeg.set(s.id, phEstInDeg.get(s.id)! - 1);
              if (!phEstRankMap.has(s.id) || phEstRankMap.get(s.id)! < cr + 1) phEstRankMap.set(s.id, cr + 1);
              if (phEstInDeg.get(s.id) === 0) phQ.push(s.id);
            }
          }
        }
        // Join-aware rank compression (mirrors PhaseNode logic)
        const phEstInDeg2 = new Map<string, number>();
        for (const s of phaseSteps) {
          const deps = (incomingEdges.get(s.id) || []).filter((d: string) => phEstIds.has(d));
          phEstInDeg2.set(s.id, deps.length);
        }
        const phEstJoins = phaseSteps.filter((s: any) => (phEstInDeg2.get(s.id) || 0) > 1);
        if (phEstJoins.length > 0) {
          for (const join of phEstJoins) {
            const anc = new Set<string>();
            const q = [...((incomingEdges.get(join.id) || []).filter((d: string) => phEstIds.has(d)))];
            while (q.length) {
              const c = q.shift()!;
              if (anc.has(c)) continue;
              anc.add(c);
              const pd = (incomingEdges.get(c) || []).filter((d: string) => phEstIds.has(d));
              for (const d of pd) { if (!anc.has(d)) q.push(d); }
            }
            const jd = (join.dependsOn || incomingEdges.get(join.id) || []).filter((d: string) => phEstIds.has(d));
            let mr = Infinity;
            for (const d of jd) { const r2 = phEstRankMap.get(d) ?? 0; if (r2 < mr) mr = r2; }
            if (mr === Infinity) continue;
            for (const aId of anc) { const cr = phEstRankMap.get(aId) ?? 0; if (cr > mr) phEstRankMap.set(aId, mr); }
            phEstRankMap.set(join.id, mr + 1);
          }
          const uniqueR = [...new Set(phEstRankMap.values())].sort((a, b) => a - b);
          const renumR = new Map<number, number>();
          uniqueR.forEach((r, i) => renumR.set(r, i));
          for (const [id, r] of phEstRankMap) phEstRankMap.set(id, renumR.get(r) ?? r);
        }

        const phEstRankGrp = new Map<number, number>();
        for (const [, r] of phEstRankMap) phEstRankGrp.set(r, (phEstRankGrp.get(r) || 0) + 1);
        const phMaxCols = phEstRankGrp.size > 0 ? Math.max(...phEstRankGrp.values()) : 0;
        const phEstPad = 20;
        const phDynW = 180;
        const phEstGap = 50;
        const estimatedW = Math.max(320, phMaxCols * phDynW + (phMaxCols - 1) * phEstGap + phEstPad + 28);

        phaseNodes.push({
          id: `phase-${ph.id}`,
          type: "phaseNode" as const,
          position: { x: curPhaseX, y: 0 },
          width: estimatedW,
          data: {
            phaseId: ph.id,
            phaseName: ph.name,
            phaseIdx: idx,
            entryGate: ph.entry_gate,
            exitGate: ph.exit_gate,
            innerSteps,
            _nodeWidth: estimatedW,
          },
        });
        curPhaseX += estimatedW + phPhaseGap;
      }

      const phaseEdges: Edge[] = [];
      for (let i = 0; i < phases.length - 1; i++) {
        const fromId = `phase-${phases[i].id}`;
        const toId = `phase-${phases[i + 1].id}`;
        const c = PHASE_COLORS[i % PHASE_COLORS.length];
        phaseEdges.push({
          id: `${fromId}->${toId}`,
          source: fromId,
          target: toId,
          animated: true,
          style: { stroke: c, strokeWidth: 2 },
        });
      }

      return { nodes: phaseNodes, flowEdges: phaseEdges };
    }

    // ── Flat mode (original) ──
    const phaseMap: Record<string, string> = {};
    const phaseIndex = new Map<string, number>();
    let nextPhaseIdx = 0;
    for (const s of steps) {
      if (s.phaseId) {
        phaseMap[s.id] = s.phaseId;
        if (!phaseIndex.has(s.phaseId)) phaseIndex.set(s.phaseId, nextPhaseIdx++);
      }
    }
    const positions = computeLayout(steps.map((s) => s.id), edges, phaseMap);
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
          dependencySteps: (dependencyMap.get(step.id) || []).map((id) => stepNameMap.get(id) || id),
        },
      };
    });
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
  }, [steps, edges, phases]);

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
