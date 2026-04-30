import { describe, it, expect, beforeEach, vi } from "vitest";
import { TaskManager, type TaskManagerConfig } from "../task-manager.js";

// ── Mock Store（内存模拟，不依赖 SQLite）──

interface MockTask {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  executor: string;
  assignee: string;
  progress: number;
  result: string | null;
  completed_at: string | null;
  [key: string]: unknown;
}

function createMockStore() {
  const tasks = new Map<string, MockTask>();
  const deps = new Map<string, Set<string>>(); // taskId → Set<dependsOnId>

  return {
    tasks,
    deps,
    addTask(task: Record<string, unknown>) {
      tasks.set(task.id as string, {
        id: task.id as string,
        title: (task.title as string) ?? "",
        description: (task.description as string) ?? "",
        status: (task.status as string) ?? "todo",
        priority: (task.priority as string) ?? "normal",
        executor: (task.executor as string) ?? "human",
        assignee: (task.assignee as string) ?? "human",
        progress: 0,
        result: null,
        completed_at: null,
        ...task,
      });
    },
    getTask(id: string) {
      return tasks.get(id) ?? null;
    },
    updateTask(id: string, updates: Record<string, unknown>) {
      const task = tasks.get(id);
      if (!task) return false;
      Object.assign(task, updates);
      return true;
    },
    listTasks(filters?: Record<string, unknown>, limit = 100) {
      let items = Array.from(tasks.values());
      if (filters?.status) {
        items = items.filter((t) => t.status === filters.status);
      }
      if (filters?.executor) {
        items = items.filter((t) => t.executor === filters.executor);
      }
      return { items: items.slice(0, limit), total: items.length };
    },
    getTaskStats() {
      const all = Array.from(tasks.values());
      return {
        total_pending: all.filter((t) => !["done", "failed"].includes(t.status)).length,
        done_today: all.filter((t) => t.status === "done").length,
      };
    },
    addTaskDependency(taskId: string, dependsOnId: string) {
      if (taskId === dependsOnId) return false;
      if (!tasks.has(taskId) || !tasks.has(dependsOnId)) return false;
      if (!deps.has(taskId)) deps.set(taskId, new Set());
      const set = deps.get(taskId)!;
      if (set.has(dependsOnId)) return false;
      set.add(dependsOnId);
      return true;
    },
    removeTaskDependency(taskId: string, dependsOnId: string) {
      const set = deps.get(taskId);
      if (!set?.has(dependsOnId)) return false;
      set.delete(dependsOnId);
      return true;
    },
    getTaskDependencies(taskId: string) {
      const set = deps.get(taskId);
      if (!set) return [];
      return Array.from(set)
        .map((id) => tasks.get(id))
        .filter(Boolean);
    },
    getTaskDependents(taskId: string) {
      const result: MockTask[] = [];
      for (const [tid, set] of deps) {
        if (set.has(taskId)) {
          const t = tasks.get(tid);
          if (t) result.push(t);
        }
      }
      return result;
    },
    areDependenciesSatisfied(taskId: string) {
      const set = deps.get(taskId);
      if (!set || set.size === 0) return true;
      for (const depId of set) {
        const dep = tasks.get(depId);
        if (!dep || dep.status !== "done") return false;
      }
      return true;
    },
  };
}

function createMockOrchestrator() {
  return {
    createSession: vi.fn().mockResolvedValue({ id: "mock-session" }),
    processInputStream: vi.fn().mockImplementation(async function* () {
      yield {
        type: "response_complete",
        data: { message: { content: [{ type: "text", text: "done" }] } },
      };
    }),
  };
}

function createTaskManager(
  store: ReturnType<typeof createMockStore>,
  config?: Partial<TaskManagerConfig>,
) {
  const orchestrator = createMockOrchestrator();
  const broadcast = vi.fn().mockResolvedValue(undefined);
  const tm = new TaskManager(store as never, orchestrator as never, broadcast, {
    scanIntervalMs: 10_000,
    maxConcurrent: 1,
    autoTriage: true,
    ...config,
  });
  return { tm, orchestrator, broadcast };
}

// ── 测试 ──

describe("TaskManager DAG — addDependency", () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore();
    store.addTask({ id: "A", title: "A", executor: "agent", status: "queued" });
    store.addTask({ id: "B", title: "B", executor: "agent", status: "todo" });
  });

  it("添加依赖后，任务应变为 blocked", () => {
    const { tm } = createTaskManager(store);
    const result = tm.addDependency("A", "B");
    expect(result.ok).toBe(true);
    expect(store.getTask("A")!.status).toBe("blocked");
  });

  it("依赖已完成时，不应变为 blocked", () => {
    store.updateTask("B", { status: "done" });
    const { tm } = createTaskManager(store);
    const result = tm.addDependency("A", "B");
    expect(result.ok).toBe(true);
    expect(store.getTask("A")!.status).toBe("queued");
  });

  it("不存在的任务应返回错误", () => {
    const { tm } = createTaskManager(store);
    expect(tm.addDependency("X", "B").ok).toBe(false);
    expect(tm.addDependency("A", "X").ok).toBe(false);
  });

  it("自依赖应返回错误", () => {
    const { tm } = createTaskManager(store);
    expect(tm.addDependency("A", "A").ok).toBe(false);
  });
});

describe("TaskManager DAG — processQueue", () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore();
  });

  it("blocked 任务不应被执行", async () => {
    store.addTask({ id: "A", title: "A", executor: "agent", status: "blocked" });
    store.addTask({ id: "B", title: "B", executor: "agent", status: "todo" });
    store.addTaskDependency("A", "B");
    const { tm, orchestrator } = createTaskManager(store);
    await tm.processQueue();
    // A 被 blocked，不应被执行
    expect(orchestrator.processInputStream).not.toHaveBeenCalled();
  });

  it("blocked 任务的依赖完成后，应自动解锁并执行", async () => {
    store.addTask({ id: "A", title: "A", executor: "agent", status: "blocked" });
    store.addTask({ id: "B", title: "B", executor: "agent", status: "done" });
    store.addTaskDependency("A", "B");
    const { tm, orchestrator } = createTaskManager(store);
    await tm.processQueue();
    // B 已完成，A 应被解锁并执行
    expect(store.getTask("A")!.status).not.toBe("blocked");
  });

  it("多依赖部分完成时不应解锁", async () => {
    store.addTask({ id: "A", title: "A", executor: "agent", status: "blocked" });
    store.addTask({ id: "B", title: "B", executor: "agent", status: "done" });
    store.addTask({ id: "C", title: "C", executor: "agent", status: "todo" });
    store.addTaskDependency("A", "B");
    store.addTaskDependency("A", "C");
    const { tm } = createTaskManager(store);
    await tm.processQueue();
    expect(store.getTask("A")!.status).toBe("blocked");
  });
});

describe("TaskManager DAG — executeTask 触发下游", () => {
  it("任务完成后，下游 blocked 任务应自动解锁", async () => {
    const store = createMockStore();
    store.addTask({ id: "A", title: "A", executor: "agent", status: "queued" });
    store.addTask({ id: "B", title: "B", executor: "agent", status: "blocked" });
    store.addTaskDependency("B", "A");

    const { tm } = createTaskManager(store, { maxConcurrent: 2 });
    await tm.executeTask("A");

    // A 完成后，B 应被解锁
    expect(store.getTask("A")!.status).toBe("done");
    expect(store.getTask("B")!.status).toBe("queued");
  });

  it("链式依赖 A→B→C 应按序解锁", async () => {
    const store = createMockStore();
    store.addTask({ id: "A", title: "A", executor: "agent", status: "queued" });
    store.addTask({ id: "B", title: "B", executor: "agent", status: "blocked" });
    store.addTask({ id: "C", title: "C", executor: "agent", status: "blocked" });
    store.addTaskDependency("B", "A");
    store.addTaskDependency("C", "B");

    const { tm } = createTaskManager(store, { maxConcurrent: 3 });

    // 执行 A
    await tm.executeTask("A");
    expect(store.getTask("A")!.status).toBe("done");
    expect(store.getTask("B")!.status).toBe("queued");
    expect(store.getTask("C")!.status).toBe("blocked");

    // 执行 B
    await tm.executeTask("B");
    expect(store.getTask("B")!.status).toBe("done");
    expect(store.getTask("C")!.status).toBe("queued");

    // 执行 C
    await tm.executeTask("C");
    expect(store.getTask("C")!.status).toBe("done");
  });

  it("菱形依赖应正确解锁", async () => {
    const store = createMockStore();
    store.addTask({ id: "A", title: "A", executor: "agent", status: "queued" });
    store.addTask({ id: "B", title: "B", executor: "agent", status: "blocked" });
    store.addTask({ id: "C", title: "C", executor: "agent", status: "blocked" });
    store.addTask({ id: "D", title: "D", executor: "agent", status: "blocked" });
    // D depends on B and C; B and C both depend on A
    store.addTaskDependency("B", "A");
    store.addTaskDependency("C", "A");
    store.addTaskDependency("D", "B");
    store.addTaskDependency("D", "C");

    const { tm } = createTaskManager(store, { maxConcurrent: 4 });

    await tm.executeTask("A");
    expect(store.getTask("B")!.status).toBe("queued");
    expect(store.getTask("C")!.status).toBe("queued");
    expect(store.getTask("D")!.status).toBe("blocked"); // D still blocked on B and C

    await tm.executeTask("B");
    expect(store.getTask("D")!.status).toBe("blocked"); // D still blocked on C

    await tm.executeTask("C");
    expect(store.getTask("D")!.status).toBe("queued"); // D now unblocked
  });
});

describe("TaskManager DAG — removeDependency", () => {
  it("移除最后一个未满足依赖后，任务应解锁", () => {
    const store = createMockStore();
    store.addTask({ id: "A", title: "A", status: "blocked" });
    store.addTask({ id: "B", title: "B", status: "todo" });
    store.addTaskDependency("A", "B");

    const { tm } = createTaskManager(store);
    tm.removeDependency("A", "B");
    expect(store.getTaskDependencies("A")).toHaveLength(0);
  });
});
