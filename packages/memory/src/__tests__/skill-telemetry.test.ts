import { describe, expect, it } from "vitest";
import { initDatabase } from "../database.js";
import { SQLiteMemoryStore } from "../store.js";

function createStore(): SQLiteMemoryStore {
  return new SQLiteMemoryStore(initDatabase(":memory:"));
}

describe("SQLiteMemoryStore skill telemetry", () => {
  it("creates skill telemetry tables during database initialization", () => {
    const db = initDatabase(":memory:");
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('skill_usage', 'skill_changes', 'evolution_runs', 'evolution_events') ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual([
      "evolution_events",
      "evolution_runs",
      "skill_changes",
      "skill_usage",
    ]);
    db.close();
  });

  it("aggregates skill usage success and failure counters", async () => {
    const store = createStore();

    await store.recordSkillUsage({
      skillId: "research",
      skillName: "Research",
      success: true,
      agentId: "default",
      usedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await store.recordSkillUsage({
      skillId: "research",
      skillName: "Research",
      success: false,
      error: "missing reference",
      agentId: "default",
      usedAt: new Date("2026-01-02T00:00:00Z"),
    });
    await store.recordSkillUsage({
      skillId: "research",
      skillName: "Research",
      success: true,
      agentId: "default",
      usedAt: new Date("2026-01-03T00:00:00Z"),
    });

    const stats = await store.listSkillUsageStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      skillId: "research",
      skillName: "Research",
      useCount: 3,
      successCount: 2,
      failureCount: 1,
      lastError: "missing reference",
      agentId: "default",
    });
    expect(stats[0].lastUsedAt.toISOString()).toBe("2026-01-03T00:00:00.000Z");
  });

  it("sorts skill usage stats by latest activity", async () => {
    const store = createStore();

    await store.recordSkillUsage({
      skillId: "old",
      skillName: "Old",
      success: true,
      usedAt: new Date("2025-01-01T00:00:00Z"),
    });
    await store.recordSkillUsage({
      skillId: "new",
      skillName: "New",
      success: true,
      usedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const stats = await store.listSkillUsageStats();
    expect(stats.map((stat) => stat.skillId)).toEqual(["new", "old"]);
  });

  it("records skill change history with hashes and reasons", async () => {
    const store = createStore();

    const created = await store.recordSkillChange({
      skillId: "writer",
      skillName: "Writer",
      action: "create",
      success: true,
      beforeHash: null,
      afterHash: "hash-a",
      reason: "capture reusable writing flow",
      path: "skills/writer/SKILL.md",
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    const patched = await store.recordSkillChange({
      skillId: "writer",
      skillName: "Writer",
      action: "patch",
      success: true,
      beforeHash: "hash-a",
      afterHash: "hash-b",
      reason: "add verification step",
      path: "skills/writer/SKILL.md",
      createdAt: new Date("2026-02-02T00:00:00Z"),
    });

    const history = await store.listSkillChangeHistory({ skillId: "writer" });
    expect(history.map((change) => change.id)).toEqual([
      patched.id,
      created.id,
    ]);
    expect(history[0]).toMatchObject({
      skillId: "writer",
      action: "patch",
      beforeHash: "hash-a",
      afterHash: "hash-b",
      reason: "add verification step",
      path: "skills/writer/SKILL.md",
    });
  });

  it("filters skill change history by skill and limit", async () => {
    const store = createStore();

    await store.recordSkillChange({
      skillId: "alpha",
      skillName: "Alpha",
      action: "create",
      success: true,
      createdAt: new Date("2026-03-01T00:00:00Z"),
    });
    await store.recordSkillChange({
      skillId: "beta",
      skillName: "Beta",
      action: "create",
      success: true,
      createdAt: new Date("2026-03-02T00:00:00Z"),
    });
    await store.recordSkillChange({
      skillId: "alpha",
      skillName: "Alpha",
      action: "patch",
      success: false,
      error: "old_string not found",
      createdAt: new Date("2026-03-03T00:00:00Z"),
    });

    const history = await store.listSkillChangeHistory({
      skillId: "alpha",
      limit: 1,
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      skillId: "alpha",
      action: "patch",
      success: false,
      error: "old_string not found",
    });
  });

  it("记录显式 evolution run，并按顺序保存账本事件", async () => {
    const store = createStore();

    const run = await store.recordEvolutionRun({
      targetType: "skill",
      targetId: "writer",
      status: "proposed",
      reason: "add stronger verification",
      triggerTraceId: "trace-trigger",
      triggerConversationId: "conv-trigger",
      baselineScore: 3,
      agentId: "default",
      startedAt: new Date("2026-04-01T00:00:00Z"),
      metadata: { source: "online-regression" },
    });

    await store.recordEvolutionEvent({
      runId: run.id,
      eventType: "baseline_eval",
      message: "baseline scored before patch",
      traceId: "trace-baseline",
      scoreBefore: 3,
      success: true,
      createdAt: new Date("2026-04-01T00:01:00Z"),
    });
    await store.recordEvolutionEvent({
      runId: run.id,
      eventType: "online_regression",
      message: "online regression passed",
      traceId: "trace-regression",
      scoreAfter: 5,
      success: true,
      data: { passed: 5, total: 5 },
      createdAt: new Date("2026-04-01T00:02:00Z"),
    });

    const completed = await store.updateEvolutionRun(run.id, {
      status: "verified",
      result: "improved",
      afterScore: 5,
      evalReportPath: "reports/evolution.json",
      completedAt: new Date("2026-04-01T00:03:00Z"),
    });
    const runs = await store.listEvolutionRuns({
      targetType: "skill",
      targetId: "writer",
    });
    const traceRuns = await store.listEvolutionRuns({
      triggerTraceId: "trace-trigger",
    });
    const events = await store.listEvolutionEvents({ runId: run.id });
    const traceEvents = await store.listEvolutionEvents({
      traceId: "trace-regression",
    });

    expect(completed).toMatchObject({
      id: run.id,
      status: "verified",
      result: "improved",
      baselineScore: 3,
      afterScore: 5,
      evalReportPath: "reports/evolution.json",
    });
    expect(runs.map((item: { id: string }) => item.id)).toEqual([run.id]);
    expect(traceRuns.map((item) => item.id)).toEqual([run.id]);
    expect(events.map((event: { eventType: string }) => event.eventType)).toEqual(
      ["baseline_eval", "online_regression"],
    );
    expect(events[1]).toMatchObject({
      traceId: "trace-regression",
      scoreAfter: 5,
      success: true,
      data: { passed: 5, total: 5 },
    });
    expect(traceEvents.map((event) => event.id)).toEqual([events[1].id]);
  });

  it("把 skill change 自动关联到 evolution run 和 change event", async () => {
    const store = createStore();

    const change = await store.recordSkillChange({
      skillId: "writer",
      skillName: "Writer",
      action: "patch",
      success: true,
      beforeHash: "before",
      afterHash: "after",
      reason: "improve output rubric",
      traceId: "trace-change",
      conversationId: "conv-change",
      createdAt: new Date("2026-04-02T00:00:00Z"),
    });

    const runs = await store.listEvolutionRuns({
      targetType: "skill",
      targetId: "writer",
    });
    const events = await store.listEvolutionEvents({
      runId: change.evolutionRunId,
    });

    expect(change.evolutionRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runs[0]).toMatchObject({
      id: change.evolutionRunId,
      targetType: "skill",
      targetId: "writer",
      status: "applied",
      reason: "improve output rubric",
      triggerTraceId: "trace-change",
      triggerConversationId: "conv-change",
    });
    expect(events[0]).toMatchObject({
      runId: change.evolutionRunId,
      eventType: "change",
      changeId: change.id,
      beforeHash: "before",
      afterHash: "after",
      traceId: "trace-change",
      success: true,
      data: { action: "patch" },
    });
  });
});
