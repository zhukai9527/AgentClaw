import { describe, expect, it } from "vitest";
import { scheduleTool } from "../builtin/schedule.js";
import type { ToolExecutionContext } from "@agentclaw/types";

function makeContext() {
  const tasks: Array<{
    id: string;
    name: string;
    cron: string;
    action: string;
    enabled: boolean;
    nextRunAt?: Date;
  }> = [];

  const context = {
    scheduler: {
      create(task: {
        name: string;
        cron: string;
        action: string;
        enabled: boolean;
      }) {
        const saved = {
          id: `task-${tasks.length + 1}`,
          ...task,
          nextRunAt: new Date("2026-05-09T09:00:00+08:00"),
        };
        tasks.push(saved);
        return saved;
      },
      list() {
        return tasks;
      },
      delete(id: string) {
        const index = tasks.findIndex((task) => task.id === id);
        if (index === -1) return false;
        tasks.splice(index, 1);
        return true;
      },
    },
  } satisfies Partial<ToolExecutionContext>;

  return { context: context as ToolExecutionContext, tasks };
}

describe("scheduleTool", () => {
  it("create 只接受 prompt 作为任务内容参数", async () => {
    const { context, tasks } = makeContext();

    const result = await scheduleTool.execute(
      {
        op: "create",
        cron: "0 9 * * *",
        message: "生成日报",
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("'prompt'");
    expect(tasks).toHaveLength(0);
  });

  it("只接受 op 作为操作参数", async () => {
    const { context, tasks } = makeContext();

    const result = await scheduleTool.execute(
      {
        action: "create",
        cron: "0 9 * * *",
        prompt: "生成日报",
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown op");
    expect(tasks).toHaveLength(0);
  });
});
