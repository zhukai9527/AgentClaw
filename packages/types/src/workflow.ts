/** Workflow step type */
export type StepType = "task" | "condition";

/** Step status during execution */
export type StepStatus = "pending" | "running" | "done" | "failed" | "waiting";

/** Skill source label */
export type SkillSource = "workspace" | "system";

/** Phase-level gate check */
export interface PhaseGate {
  name: string;
  document?: string;
  required_terms?: string[];
  pass_summary?: string;
  block_summary?: string;
  check?: string;
}

/** Run mode for a step within a phase */
export type PhaseStepRunMode = "serial" | "parallel" | "join";

/** A step within a workflow phase (Codex-style) */
export interface WorkflowPhaseStep {
  id: string;
  name: string;
  /** Skill responsible for executing this step */
  owner_skill?: string;
  /** Execution mode relative to sibling steps */
  run_mode?: PhaseStepRunMode;
  /** Group name for parallel execution grouping */
  parallel_group?: string;
  /** Whether this step can be skipped */
  optional?: boolean;
  /** Dependency references to other step IDs within the same phase */
  depends_on?: string[];
  required_inputs?: string[];
  outputs?: string[];
  artifacts?: string[];
  verification_outputs?: string[];
  entry_gate?: string;
  exit_gate?: string;
  gate_checks?: PhaseGate[];
  /** Step to fall back to on failure */
  fallback_step?: string;
  /** Phase to fall back to on failure */
  fallback_phase?: string;
  /** For condition steps: prompt shown to user */
  prompt?: string;
  /** Whether this step requires human intervention */
  human?: boolean;
}

/** A phase grouping multiple steps */
export interface WorkflowPhase {
  id: string;
  name: string;
  entry_gate?: string;
  exit_gate?: string;
  steps: WorkflowPhaseStep[];
  optional?: boolean;
  skip_when?: string[];
  outputs?: string[];
  gate_checks?: PhaseGate[];
  completion_status?: string;
  completion_actions?: string[];
}

/** A single step in a workflow DAG */
export interface WorkflowStep {
  id: string;
  name: string;
  type: StepType;
  /** Skill reference — resolved via SkillResolver (workspace → system fallback) */
  skill?: string;
  /** Skill source (populated at resolution time) */
  skillSource?: SkillSource;
  /** For condition steps: prompt shown to user */
  prompt?: string;
  /** Whether this step requires human intervention */
  human?: boolean;
  /** Free-form metadata */
  meta?: Record<string, unknown>;
  /** Codex-style: phase grouping */
  phaseId?: string;
  phaseName?: string;
  /** Codex-style: execution mode */
  runMode?: PhaseStepRunMode;
  parallelGroup?: string;
  /** Codex-style: gate references */
  entryGate?: string;
  exitGate?: string;
  /** Codex-style: fallback references */
  fallbackStep?: string;
  fallbackPhase?: string;
  /** Artifact/output declarations */
  outputs?: string[];
  artifacts?: string[];
  requiredInputs?: string[];
}

/** A directed edge between workflow steps */
export interface WorkflowEdge {
  from: string;
  to: string | null;
  /** Label for the edge (e.g. condition branch text) */
  label?: string;
}

/** A complete workflow definition */
export interface WorkflowDefinition {
  name: string;
  description?: string;
  /** Flat DAG steps (legacy format) */
  steps: WorkflowStep[];
  /** Flat DAG edges (legacy format) */
  edges: WorkflowEdge[];
  /** Codex-style: phases grouping */
  phases?: WorkflowPhase[];
  /** Codex-style: entry/exit conditions */
  applies_to?: string[];
  entry_condition?: string;
  exit_condition?: string;
  /** Codex-style: task type routing */
  task_types?: string[];
  /** Index-file relative path (if loaded from workflow-pool.yaml) */
  path?: string;
}

/** Runtime state of a single step during execution */
export interface StepRuntimeState {
  stepId: string;
  status: StepStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  /** Artifact file paths produced by this step */
  artifacts?: string[];
  /** Duration in ms */
  durationMs?: number;
}

/** A workflow-pool.yaml entry — maps task_types to a workflow file */
export interface WorkflowPoolEntry {
  id: string;
  name: string;
  path: string;
  task_types: string[];
}

/** A workflow-pool.yaml file — the routing index */
export interface WorkflowPool {
  version: number;
  source?: string;
  workflows: WorkflowPoolEntry[];
}

/** A skill-pool.yaml file — centralized skill catalog */
export interface SkillPool {
  version: number;
  source?: string;
  skills: Record<string, string>;
}

/** Workflow registry — manages YAML-based workflow definitions */
export interface WorkflowRegistry {
  /** Scan a directory for .yaml workflow files (legacy flat scan) */
  scanDirectory(dirPath: string): Promise<void>;
  /** Scan a directory structure with indexes/ (Codex-style) */
  scanIndexDirectory(indexesDir: string): Promise<void>;
  /** Find a workflow by task type (uses index) */
  findByTaskType(taskType: string): WorkflowDefinition | undefined;
  /** Get a workflow by name */
  get(name: string): WorkflowDefinition | undefined;
  /** List all registered workflows */
  list(): WorkflowDefinition[];
  /** Register a workflow definition */
  register(def: WorkflowDefinition): void;
}
