import { describe, expect, it } from "vitest";

describe("Evolution settings entry", () => {
  it("Settings 菜单包含进化日志入口", async () => {
    Object.defineProperty(globalThis, "window", {
      value: {
        location: { protocol: "http:", hostname: "localhost" },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        reload: () => undefined,
      },
      configurable: true,
    });

    const { SETTINGS_TABS } = await import("./SettingsPage");

    expect(SETTINGS_TABS.some((tab) => tab.id === "evolution")).toBe(true);
  });

  it("进化日志摘要区分改进、回退和未知结果", async () => {
    const { summarizeEvolutionRuns } = await import("./EvolutionPage");
    const runs = [
      {
        id: "run-1",
        targetType: "skill",
        targetId: "writer",
        status: "verified",
        result: "improved",
        regressionCount: 0,
        startedAt: "2026-05-02T00:00:00Z",
        createdAt: "2026-05-02T00:00:00Z",
        updatedAt: "2026-05-02T00:01:00Z",
      },
      {
        id: "run-2",
        targetType: "skill",
        targetId: "planner",
        status: "verified",
        result: "regressed",
        regressionCount: 1,
        startedAt: "2026-05-02T00:02:00Z",
        createdAt: "2026-05-02T00:02:00Z",
        updatedAt: "2026-05-02T00:03:00Z",
      },
      {
        id: "run-3",
        targetType: "skill",
        targetId: "curator",
        status: "applied",
        result: "unknown",
        regressionCount: 0,
        startedAt: "2026-05-02T00:04:00Z",
        createdAt: "2026-05-02T00:04:00Z",
        updatedAt: "2026-05-02T00:05:00Z",
      },
    ] as const;

    expect(summarizeEvolutionRuns(runs)).toEqual({
      total: 3,
      improved: 1,
      regressed: 1,
      verified: 2,
      regressions: 1,
    });
  });
});
