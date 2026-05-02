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
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('skill_usage', 'skill_changes') ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual([
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
});
