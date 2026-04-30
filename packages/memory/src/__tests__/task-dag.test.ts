import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../database.js";
import type { DbAdapter } from "../db-adapter.js";
import { SQLiteMemoryStore } from "../store.js";

function createStore(): { db: DbAdapter; store: SQLiteMemoryStore } {
  const db = initDatabase(":memory:");
  const store = new SQLiteMemoryStore(db);
  return { db, store };
}

function addTask(
  store: SQLiteMemoryStore,
  id: string,
  overrides: Record<string, unknown> = {},
) {
  store.addTask({
    id,
    title: `Task ${id}`,
    ...overrides,
  });
}

// ── task_dependencies 表 ──

describe("task_dependencies 表", () => {
  it("应随数据库初始化自动创建", () => {
    const { db } = createStore();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='task_dependencies'",
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("应有正确的索引", () => {
    const { db } = createStore();
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_task_deps%'",
      )
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_task_deps_task");
    expect(names).toContain("idx_task_deps_depends");
  });
});

// ── addTaskDependency ──

describe("addTaskDependency", () => {
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
    addTask(store, "A");
    addTask(store, "B");
    addTask(store, "C");
  });

  it("应成功添加依赖", () => {
    const result = store.addTaskDependency("A", "B");
    expect(result).toBe(true);
    const deps = store.getTaskDependencies("A");
    expect(deps).toHaveLength(1);
    expect(deps[0].id).toBe("B");
  });

  it("应拒绝重复依赖", () => {
    store.addTaskDependency("A", "B");
    const result = store.addTaskDependency("A", "B");
    expect(result).toBe(false);
  });

  it("应拒绝自依赖", () => {
    const result = store.addTaskDependency("A", "A");
    expect(result).toBe(false);
  });

  it("应拒绝不存在的任务", () => {
    expect(store.addTaskDependency("X", "B")).toBe(false);
    expect(store.addTaskDependency("A", "X")).toBe(false);
  });

  it("应支持多依赖", () => {
    store.addTaskDependency("A", "B");
    store.addTaskDependency("A", "C");
    const deps = store.getTaskDependencies("A");
    expect(deps).toHaveLength(2);
    const ids = deps.map((d) => d.id).sort();
    expect(ids).toEqual(["B", "C"]);
  });
});

// ── 循环检测 ──

describe("循环检测", () => {
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
    addTask(store, "A");
    addTask(store, "B");
    addTask(store, "C");
  });

  it("应拒绝直接循环 A→B, B→A", () => {
    store.addTaskDependency("A", "B");
    const result = store.addTaskDependency("B", "A");
    expect(result).toBe(false);
  });

  it("应拒绝间接循环 A→B→C, C→A", () => {
    store.addTaskDependency("A", "B");
    store.addTaskDependency("B", "C");
    const result = store.addTaskDependency("C", "A");
    expect(result).toBe(false);
  });

  it("应允许非循环的链式依赖 A→B→C", () => {
    expect(store.addTaskDependency("A", "B")).toBe(true);
    expect(store.addTaskDependency("B", "C")).toBe(true);
    const depsA = store.getTaskDependencies("A");
    const depsB = store.getTaskDependencies("B");
    expect(depsA).toHaveLength(1);
    expect(depsB).toHaveLength(1);
  });

  it("应允许菱形依赖 A→B, A→C, B→D, C→D", () => {
    addTask(store, "D");
    expect(store.addTaskDependency("A", "B")).toBe(true);
    expect(store.addTaskDependency("A", "C")).toBe(true);
    expect(store.addTaskDependency("B", "D")).toBe(true);
    expect(store.addTaskDependency("C", "D")).toBe(true);
    expect(store.getTaskDependencies("A")).toHaveLength(2);
  });
});

// ── removeTaskDependency ──

describe("removeTaskDependency", () => {
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
    addTask(store, "A");
    addTask(store, "B");
  });

  it("应成功移除依赖", () => {
    store.addTaskDependency("A", "B");
    const result = store.removeTaskDependency("A", "B");
    expect(result).toBe(true);
    expect(store.getTaskDependencies("A")).toHaveLength(0);
  });

  it("移除不存在的依赖应返回 false", () => {
    expect(store.removeTaskDependency("A", "B")).toBe(false);
  });
});

// ── getTaskDependencies / getTaskDependents ──

describe("getTaskDependencies / getTaskDependents", () => {
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
    addTask(store, "A");
    addTask(store, "B");
    addTask(store, "C");
    addTask(store, "D");
    // A depends on B, C; D depends on A
    store.addTaskDependency("A", "B");
    store.addTaskDependency("A", "C");
    store.addTaskDependency("D", "A");
  });

  it("getTaskDependencies 应返回任务依赖的所有上游", () => {
    const deps = store.getTaskDependencies("A");
    expect(deps).toHaveLength(2);
    const ids = deps.map((d) => d.id).sort();
    expect(ids).toEqual(["B", "C"]);
  });

  it("getTaskDependents 应返回依赖此任务的下游", () => {
    const dependents = store.getTaskDependents("A");
    expect(dependents).toHaveLength(1);
    expect(dependents[0].id).toBe("D");
  });

  it("无依赖时应返回空数组", () => {
    expect(store.getTaskDependencies("B")).toHaveLength(0);
    expect(store.getTaskDependents("D")).toHaveLength(0);
  });
});

// ── areDependenciesSatisfied ──

describe("areDependenciesSatisfied", () => {
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    ({ store } = createStore());
    addTask(store, "A");
    addTask(store, "B");
    addTask(store, "C");
  });

  it("无依赖时应返回 true", () => {
    expect(store.areDependenciesSatisfied("A")).toBe(true);
  });

  it("依赖未完成时应返回 false", () => {
    store.addTaskDependency("A", "B");
    expect(store.areDependenciesSatisfied("A")).toBe(false);
  });

  it("依赖已完成时应返回 true", () => {
    store.addTaskDependency("A", "B");
    store.updateTask("B", { status: "done" });
    expect(store.areDependenciesSatisfied("A")).toBe(true);
  });

  it("部分依赖完成时应返回 false", () => {
    store.addTaskDependency("A", "B");
    store.addTaskDependency("A", "C");
    store.updateTask("B", { status: "done" });
    expect(store.areDependenciesSatisfied("A")).toBe(false);
  });

  it("全部依赖完成时应返回 true", () => {
    store.addTaskDependency("A", "B");
    store.addTaskDependency("A", "C");
    store.updateTask("B", { status: "done" });
    store.updateTask("C", { status: "done" });
    expect(store.areDependenciesSatisfied("A")).toBe(true);
  });

  it("依赖任务被删除后应视为满足", () => {
    store.addTaskDependency("A", "B");
    store.deleteTask("B");
    // 删除触发 CASCADE，依赖关系也被删除
    expect(store.areDependenciesSatisfied("A")).toBe(true);
  });
});

// ── 级联删除 ──

describe("级联删除", () => {
  it("删除任务时应自动清理依赖关系", () => {
    const { store } = createStore();
    addTask(store, "A");
    addTask(store, "B");
    store.addTaskDependency("A", "B");

    store.deleteTask("B");
    expect(store.getTaskDependencies("A")).toHaveLength(0);
  });
});
