import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowEdge,
  StepRuntimeState,
  StepStatus,
} from "@agentclaw/types";

export interface WorkflowEngineOptions {
  onStepStatusChange?: (stepId: string, status: StepStatus) => void;
}

/**
 * DAG WorkflowEngine — executes workflow steps respecting edge topology.
 *
 * - Supports linear, parallel branches, and join nodes (wait for all upstream).
 * - Condition nodes delegate edge selection to a callback.
 */
export class WorkflowEngine {
  private options: WorkflowEngineOptions;

  constructor(options: WorkflowEngineOptions = {}) {
    this.options = options;
  }

  /**
   * Topologically sort steps given edges.
   * Throws if a cycle is detected.
   */
  topologicalSort(
    steps: WorkflowStep[],
    edges: WorkflowEdge[],
  ): WorkflowStep[] {
    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const step of steps) {
      inDegree.set(step.id, 0);
      adj.set(step.id, []);
    }

    for (const edge of edges) {
      if (!edge.to) continue;
      if (!stepMap.has(edge.from) || !stepMap.has(edge.to)) continue;
      adj.get(edge.from)!.push(edge.to);
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const sorted: WorkflowStep[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const step = stepMap.get(id);
      if (step) sorted.push(step);
      for (const neighbor of adj.get(id) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    if (sorted.length !== steps.length) {
      throw new Error("Cycle detected in workflow DAG");
    }

    return sorted;
  }

  /**
   * Execute a workflow with a step executor callback.
   *
   * @param workflow - The workflow definition.
   * @param executeStep - Called for each ready step; return artifacts array.
   * @param chooseEdge - Called for condition steps; return which edge to follow (to-node id).
   *
   * Returns final runtime state for all steps.
   */
  async execute(
    workflow: WorkflowDefinition,
    executeStep: (
      step: WorkflowStep,
    ) => Promise<string[]>,
    chooseEdge?: (
      step: WorkflowStep,
      edges: WorkflowEdge[],
    ) => Promise<string | null>,
  ): Promise<Map<string, StepRuntimeState>> {
    const state = new Map<string, StepRuntimeState>();
    const { steps, edges } = workflow;

    // Build upstream map
    const upstreamMap = new Map<string, string[]>();
    for (const step of steps) {
      upstreamMap.set(step.id, []);
      state.set(step.id, {
        stepId: step.id,
        status: "pending",
      });
    }
    for (const edge of edges) {
      if (!edge.to) continue;
      if (!upstreamMap.has(edge.to)) continue;
      upstreamMap.get(edge.to)!.push(edge.from);
    }

    // Track which incoming edges have completed
    const completedUpstream = new Map<string, Set<string>>();
    for (const step of steps) {
      completedUpstream.set(step.id, new Set());
    }

    // Find root steps (no incoming edges)
    const roots = steps.filter(
      (s) => (upstreamMap.get(s.id)?.length ?? 0) === 0,
    );

    const toRun = [...roots];
    const running = new Set<string>();

    // Condition step: track chosen edge
    const conditionChoices = new Map<string, Set<string>>();

    while (toRun.length > 0 || running.size > 0) {
      // Start all ready steps
      const ready = toRun.splice(0);
      for (const step of ready) {
        this.setStatus(state, step.id, "running");
        running.add(step.id);

        // Fire and forget — track when done via callback
        this.runStep(step, edges, executeStep, conditionChoices, chooseEdge)
          .then(({ stepId, artifacts, chosenTo }) => {
            running.delete(stepId);
            this.setStatus(state, stepId, "done", artifacts);

            // Propagate completion to downstream steps
            for (const downstream of steps) {
              const ups = upstreamMap.get(downstream.id)!;
              if (ups.includes(stepId)) {
                completedUpstream.get(downstream.id)!.add(stepId);

                const allUpstreamDone = ups.every((u) => {
                  if (downstream.type === "condition") return true;
                  const s = state.get(u);
                  return s?.status === "done" || s?.status === "failed";
                });

                if (allUpstreamDone && !running.has(downstream.id)) {
                  toRun.push(downstream);
                }
              }
            }

            // For condition steps, only propagate down chosen edge
            if (chosenTo) {
              const downstream = steps.find((s) => s.id === chosenTo);
              if (downstream && !running.has(downstream.id)) {
                toRun.push(downstream);
              }
            }
          })
          .catch((err) => {
            running.delete(step.id);
            this.setStatus(state, step.id, "failed");
            this.options.onStepStatusChange?.(step.id, "failed");
            console.error(`[workflow] Step ${step.id} failed:`, err);
          });
      }

      // Yield to event loop
      if (running.size > 0 || toRun.length > 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    return state;
  }

  private async runStep(
    step: WorkflowStep,
    edges: WorkflowEdge[],
    executeStep: (step: WorkflowStep) => Promise<string[]>,
    conditionChoices: Map<string, Set<string>>,
    chooseEdge?: (
      step: WorkflowStep,
      edges: WorkflowEdge[],
    ) => Promise<string | null>,
  ): Promise<{ stepId: string; artifacts?: string[]; chosenTo?: string }> {
    if (step.type === "condition") {
      if (chooseEdge) {
        const stepEdges = edges.filter((e) => e.from === step.id);
        const chosen = await chooseEdge(step, stepEdges);
        if (chosen) {
          conditionChoices.set(step.id, new Set([chosen]));
        }
        return { stepId: step.id, chosenTo: chosen ?? undefined };
      }
      return { stepId: step.id };
    }

    const artifacts = await executeStep(step);
    return { stepId: step.id, artifacts };
  }

  private setStatus(
    state: Map<string, StepRuntimeState>,
    stepId: string,
    status: StepStatus,
    artifacts?: string[],
  ): void {
    const s = state.get(stepId);
    if (!s) return;
    s.status = status;
    if (status === "running") s.startedAt = Date.now();
    if (status === "done" || status === "failed") {
      s.completedAt = Date.now();
      s.durationMs = s.startedAt ? Date.now() - s.startedAt : 0;
    }
    if (artifacts) s.artifacts = artifacts;
    this.options.onStepStatusChange?.(stepId, status);
  }
}
