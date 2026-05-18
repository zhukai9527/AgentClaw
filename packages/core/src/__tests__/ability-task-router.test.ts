import { describe, expect, it } from "vitest";
import {
  buildTaskToolProfile,
  filterToolDefinitionsForTask,
} from "../ability/task-router.js";

describe("ability task router", () => {
  it("纯文本延续追问不暴露任何工具", () => {
    const profile = buildTaskToolProfile(
      "继续第 3 项，展开为可执行验收步骤。",
      false,
      false,
    );

    expect(profile.kind).toBe("text_only_followup");
    expect(profile.allowedTools?.size).toBe(0);
    expect(profile.webResearchToolLimit).toBe(0);
  });

  it("自动化请求优先 schedule，即使同时包含新闻语义", () => {
    const profile = buildTaskToolProfile(
      "每天早上 9 点检查 Hacker News 是否有 Agent 相关热门新闻并通知我。",
      true,
      true,
    );

    expect(profile.kind).toBe("automation_schedule");
    expect(profile.allowedTools).toEqual(new Set(["schedule"]));
    expect(profile.toolTotalLimits.schedule).toBe(2);
  });

  it("按任务 profile 过滤工具定义", () => {
    const profile = buildTaskToolProfile("继续第 3 项。", false, false);
    const filtered = filterToolDefinitionsForTask(
      [{ name: "bash" }, { name: "web_search" }],
      profile,
    );

    expect(filtered).toEqual([]);
  });
});
