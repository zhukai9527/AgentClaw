import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  WorkflowDefinition,
  WorkflowRegistry,
  WorkflowPool,
  WorkflowPoolEntry,
  WorkflowPhase,
  WorkflowPhaseStep,
  WorkflowStep,
  WorkflowEdge,
} from "@agentclaw/types";

export class WorkflowRegistryImpl implements WorkflowRegistry {
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private poolEntries: WorkflowPoolEntry[] = [];

  async scanDirectory(dirPath: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      const filePath = path.join(dirPath, entry);
      await this.loadWorkflowFile(filePath);
    }
  }

  async scanIndexDirectory(indexesDir: string): Promise<void> {
    const poolPath = path.join(indexesDir, "workflow-pool.yaml");
    if (!existsSync(poolPath)) return;

    try {
      const content = await readFile(poolPath, "utf-8");
      const pool = parseYaml(content) as WorkflowPool;
      if (!pool || !Array.isArray(pool.workflows)) return;

      this.poolEntries = pool.workflows;
      const baseDir = path.dirname(indexesDir);

      for (const entry of pool.workflows) {
        const wfPath = path.resolve(baseDir, entry.path);
        if (!existsSync(wfPath)) continue;
        const def = await this.loadWorkflowFile(wfPath);
        if (def) {
          def.task_types = entry.task_types;
          def.path = entry.path;
        }
      }
    } catch {
      // skip invalid pool file
    }
  }

  private async loadWorkflowFile(filePath: string): Promise<WorkflowDefinition | undefined> {
    try {
      const content = await readFile(filePath, "utf-8");
      const doc = parseYaml(content) as any;
      if (!doc) return;

      // Codex-style format: has phases
      if (doc.phases && Array.isArray(doc.phases)) {
        const def = this.codexToDefinition(doc);
        this.register(def);
        return def;
      }

      // Legacy flat DAG format
      if (doc.name && Array.isArray(doc.steps)) {
        this.register(doc as WorkflowDefinition);
        return doc as WorkflowDefinition;
      }
    } catch {
      // skip invalid files
    }
  }

  private codexToDefinition(doc: any): WorkflowDefinition {
    const def: WorkflowDefinition = {
      name: doc.id || doc.name || "unnamed",
      description: doc.description || doc.name || "",
      steps: [],
      edges: [],
      phases: [],
      applies_to: doc.applies_to,
      entry_condition: doc.entry_condition,
      exit_condition: doc.exit_condition,
    };

    const phases: WorkflowPhase[] = (doc.phases || []).map((p: any, pi: number) => ({
      id: p.id || `phase-${pi}`,
      name: p.name || `Phase ${pi + 1}`,
      entry_gate: p.entry_gate,
      exit_gate: p.exit_gate,
      optional: p.optional,
      skip_when: p.skip_when,
      outputs: p.outputs,
      gate_checks: p.gate_checks,
      completion_status: p.completion_status,
      completion_actions: p.completion_actions,
      steps: (p.steps || []).map((s: any, si: number) => ({
        id: s.id || `${p.id || `phase-${pi}`}-step-${si}`,
        name: s.name || `Step ${si + 1}`,
        owner_skill: s.owner_skill,
        run_mode: s.run_mode || "serial",
        parallel_group: s.parallel_group,
        optional: s.optional,
        depends_on: s.depends_on,
        required_inputs: s.required_inputs,
        outputs: s.outputs,
        artifacts: s.artifacts,
        verification_outputs: s.verification_outputs,
        entry_gate: s.entry_gate,
        exit_gate: s.exit_gate,
        gate_checks: s.gate_checks,
        fallback_step: s.fallback_step,
        fallback_phase: s.fallback_phase,
        prompt: s.prompt,
        human: s.human,
      })),
    }));

    def.phases = phases;

    // Flatten phases into steps + edges for DAG compatibility
    let prevPhaseStepId: string | null = null;
    for (const phase of phases) {
      const phaseSteps = phase.steps;
      let prevStepInPhase: string | null = null;

      for (const ps of phaseSteps) {
        const step: WorkflowStep = {
          id: ps.id,
          name: ps.name,
          type: ps.human ? "condition" : "task",
          skill: ps.owner_skill,
          prompt: ps.prompt,
          human: ps.human,
          phaseId: phase.id,
          phaseName: phase.name,
          runMode: ps.run_mode,
          parallelGroup: ps.parallel_group,
          entryGate: ps.entry_gate || phase.entry_gate,
          exitGate: ps.exit_gate || phase.exit_gate,
          fallbackStep: ps.fallback_step,
          fallbackPhase: ps.fallback_phase,
          outputs: ps.outputs,
          artifacts: ps.artifacts,
          requiredInputs: ps.required_inputs,
        };
        def.steps.push(step);

        // Connect phase-to-phase edge
        if (prevPhaseStepId) {
          def.edges.push({ from: prevPhaseStepId, to: ps.id });
        }

        // Connect intra-phase serial edge
        if (ps.run_mode === "serial" && prevStepInPhase) {
          def.edges.push({ from: prevStepInPhase, to: ps.id });
        }

        // Handle depends_on
        if (ps.depends_on) {
          for (const dep of ps.depends_on) {
            def.edges.push({ from: dep, to: ps.id });
          }
        }

        prevStepInPhase = ps.id;
      }

      if (phaseSteps.length > 0) {
        prevPhaseStepId = phaseSteps[phaseSteps.length - 1].id;
      }
    }

    return def;
  }

  findByTaskType(taskType: string): WorkflowDefinition | undefined {
    const entry = this.poolEntries.find((e) => e.task_types.includes(taskType));
    if (!entry) return;
    return this.workflows.get(entry.id);
  }

  register(def: WorkflowDefinition): void {
    this.workflows.set(def.name, def);
  }

  get(name: string): WorkflowDefinition | undefined {
    return this.workflows.get(name);
  }

  list(): WorkflowDefinition[] {
    return Array.from(this.workflows.values());
  }

  getPoolEntries(): WorkflowPoolEntry[] {
    return this.poolEntries;
  }
}
