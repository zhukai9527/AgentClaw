/** Workflow step type */
export type StepType = "task" | "condition";

/** Step status during execution */
export type StepStatus = "pending" | "running" | "done" | "failed" | "waiting";

/** Skill source label */
export type SkillSource = "workspace" | "system";

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
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
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

/** Workflow registry — manages YAML-based workflow definitions */
export interface WorkflowRegistry {
  /** Scan a directory for .yaml workflow files */
  scanDirectory(dirPath: string): Promise<void>;
  /** Get a workflow by name */
  get(name: string): WorkflowDefinition | undefined;
  /** List all registered workflows */
  list(): WorkflowDefinition[];
  /** Register a workflow definition */
  register(def: WorkflowDefinition): void;
}
