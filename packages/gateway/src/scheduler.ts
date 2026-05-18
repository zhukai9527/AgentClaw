import { Cron } from "croner";
import { generateId } from "@agentclaw/providers";

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  action: string;
  enabled: boolean;
  oneShot?: boolean;
  status?: "idle" | "running";
  lastRunAt?: Date;
  nextRunAt?: Date;
}

/** Minimal persistence interface — implemented by SQLiteMemoryStore */
interface ScheduledTaskStore {
  listScheduledTasks(): ScheduledTask[];
  saveScheduledTask(task: Omit<ScheduledTask, "nextRunAt">): void;
  deleteScheduledTask(id: string): void;
  updateScheduledTaskLastRun(id: string, lastRunAt: Date): void;
}

interface InternalTask extends ScheduledTask {
  job?: Cron;
}

export class TaskScheduler {
  private tasks = new Map<string, InternalTask>();
  private store?: ScheduledTaskStore;
  private onTaskFire?: (task: ScheduledTask) => void | Promise<void>;

  constructor(store?: ScheduledTaskStore) {
    this.store = store;
    if (store) {
      this.loadFromStore(store);
    }
  }

  setOnTaskFire(callback: (task: ScheduledTask) => void | Promise<void>): void {
    this.onTaskFire = callback;
  }

  create(input: {
    name: string;
    cron: string;
    action: string;
    enabled: boolean;
    oneShot?: boolean;
  }): ScheduledTask {
    const id = generateId();
    const task: InternalTask = {
      id,
      name: input.name,
      cron: input.cron,
      action: input.action,
      enabled: input.enabled,
      oneShot: input.oneShot,
    };

    if (task.enabled) {
      this.startJob(task);
    }

    this.tasks.set(id, task);

    // Persist
    this.store?.saveScheduledTask({
      id: task.id,
      name: task.name,
      cron: task.cron,
      action: task.action,
      enabled: task.enabled,
      oneShot: task.oneShot,
      lastRunAt: task.lastRunAt,
    });

    return this.toPublic(task);
  }

  list(): ScheduledTask[] {
    return Array.from(this.tasks.values()).map((t) => this.toPublic(t));
  }

  get(id: string): ScheduledTask | undefined {
    const task = this.tasks.get(id);
    return task ? this.toPublic(task) : undefined;
  }

  update(
    id: string,
    input: { name?: string; cron?: string; action?: string; enabled?: boolean },
  ): ScheduledTask | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    if (input.name !== undefined) task.name = input.name;
    if (input.action !== undefined) task.action = input.action;

    // If cron or enabled changed, restart the job
    const cronChanged = input.cron !== undefined && input.cron !== task.cron;
    const enabledChanged =
      input.enabled !== undefined && input.enabled !== task.enabled;

    if (input.cron !== undefined) task.cron = input.cron;
    if (input.enabled !== undefined) task.enabled = input.enabled;

    if (cronChanged || enabledChanged) {
      task.job?.stop();
      task.job = undefined;
      task.nextRunAt = undefined;
      if (task.enabled) {
        this.startJob(task);
      }
    }

    // Persist
    this.store?.saveScheduledTask({
      id: task.id,
      name: task.name,
      cron: task.cron,
      action: task.action,
      enabled: task.enabled,
      oneShot: task.oneShot,
      lastRunAt: task.lastRunAt,
    });

    return this.toPublic(task);
  }

  async runNow(id: string): Promise<ScheduledTask | undefined> {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (task.status === "running") return this.toPublic(task); // already running

    task.status = "running";
    task.lastRunAt = new Date();
    console.log(
      `[scheduler] Task "${task.name}" (${task.id}) manually triggered at ${task.lastRunAt.toISOString()}`,
    );
    this.store?.updateScheduledTaskLastRun(task.id, task.lastRunAt);

    try {
      if (this.onTaskFire) {
        await this.onTaskFire(this.toPublic(task));
      }
    } finally {
      task.status = "idle";
    }

    return this.toPublic(task);
  }

  delete(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.job?.stop();
    this.tasks.delete(id);
    this.store?.deleteScheduledTask(id);
    return true;
  }

  stopAll(): void {
    for (const task of this.tasks.values()) {
      task.job?.stop();
    }
  }

  private loadFromStore(store: ScheduledTaskStore): void {
    const saved = store.listScheduledTasks();
    for (const t of saved) {
      // Cleanup orphaned one-shot tasks that already fired (crash recovery)
      if (t.oneShot && t.lastRunAt) {
        store.deleteScheduledTask(t.id);
        continue;
      }
      const task: InternalTask = { ...t };
      if (task.enabled && !task.oneShot) {
        this.startJob(task);
      }
      this.tasks.set(task.id, task);
    }
    if (saved.length > 0) {
      console.log(`[scheduler] Restored ${saved.length} tasks from database`);
    }
  }

  private startJob(task: InternalTask): void {
    task.job = new Cron(task.cron, async () => {
      task.status = "running";
      task.lastRunAt = new Date();
      console.log(
        `[scheduler] Task "${task.name}" (${task.id}) executed at ${task.lastRunAt.toISOString()}`,
      );

      // Persist last run time
      this.store?.updateScheduledTaskLastRun(task.id, task.lastRunAt);

      // Notify via callback if registered
      try {
        if (this.onTaskFire) {
          await this.onTaskFire(this.toPublic(task));
        }
      } finally {
        task.status = "idle";
        // One-shot tasks: stop and remove after firing
        if (task.oneShot) {
          task.job?.stop();
          this.tasks.delete(task.id);
          this.store?.deleteScheduledTask(task.id);
          console.log(
            `[scheduler] One-shot task "${task.name}" (${task.id}) auto-removed`,
          );
        }
      }
    });

    const nextRun = task.job.nextRun();
    task.nextRunAt = nextRun ?? undefined;
  }

  private toPublic(task: InternalTask): ScheduledTask {
    // Refresh nextRunAt from the cron job
    let nextRunAt = task.nextRunAt;
    if (task.job) {
      const next = task.job.nextRun();
      nextRunAt = next ?? undefined;
    }
    return {
      id: task.id,
      name: task.name,
      cron: task.cron,
      action: task.action,
      enabled: task.enabled,
      oneShot: task.oneShot,
      status: task.status || "idle",
      lastRunAt: task.lastRunAt,
      nextRunAt,
    };
  }
}
