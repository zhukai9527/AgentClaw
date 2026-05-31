/** Task status */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/** Task priority */
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

/** Task — a work item from an external source (TAPD, Jira, etc.) */
export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Provider name this task came from (e.g. "tapd", "jira") */
  source: string;
  /** Link back to the source system */
  sourceUrl?: string;
  priority?: TaskPriority;
  /** Associated target project (e.g. "project-a") */
  targetRepo?: string;
  assignedTo?: string;
  /** Free-form metadata from the source provider */
  metadata?: Record<string, unknown>;
}

/** Task provider — abstracts fetching/syncing tasks from external systems */
export interface TaskProvider {
  /** Unique provider name */
  name: string;
  /** Fetch current task list from source */
  fetchTasks(): Promise<Task[]>;
  /** Push status change back to source */
  syncStatus(taskId: string, status: TaskStatus): Promise<void>;
}

/** Task provider registry — manages available providers */
export interface TaskProviderRegistry {
  register(provider: TaskProvider): void;
  get(name: string): TaskProvider | undefined;
  list(): TaskProvider[];
}
