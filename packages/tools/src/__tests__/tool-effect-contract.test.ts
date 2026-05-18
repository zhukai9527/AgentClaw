import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "@agentclaw/types";
import { fileWriteTool } from "../builtin/file-write.js";
import { rememberTool } from "../builtin/remember.js";
import { scheduleTool } from "../builtin/schedule.js";
import { sendFileTool } from "../builtin/send-file.js";
import { shellTool } from "../builtin/shell.js";

describe("Tool Effect Contract", () => {
  it("schedule create exposes a reversible schedule effect with cleanup id", async () => {
    const context = {
      scheduler: {
        create() {
          return {
            id: "task-effect-1",
            name: "每日检查",
            nextRunAt: new Date("2026-05-19T09:00:00+08:00"),
          };
        },
        list: () => [],
        delete: () => true,
      },
    } satisfies Partial<ToolExecutionContext>;

    const result = await scheduleTool.execute(
      {
        op: "create",
        cron: "0 9 * * *",
        prompt: "检查 trace 结果",
        name: "每日检查",
      },
      context as ToolExecutionContext,
    );

    expect((result as any).effect).toMatchObject({
      kind: "schedule",
      target: "task-effect-1",
      reversible: true,
      cleanupId: "task-effect-1",
      verified: true,
    });
  });

  it("file_write and send_file expose write and deliverable send effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentclaw-effect-"));
    const writeResult = await fileWriteTool.execute(
      { path: "report.md", content: "hello" },
      { workDir: root } as ToolExecutionContext,
    );

    expect((writeResult as any).effect).toMatchObject({
      kind: "write",
      target: join(root, "report.md"),
      reversible: true,
      verified: true,
    });

    const source = join(root, "report.md");
    writeFileSync(source, "hello", "utf-8");
    const sendFile = vi.fn().mockResolvedValue(undefined);
    const sendResult = await sendFileTool.execute(
      { path: "report.md" },
      { workDir: root, sendFile } as unknown as ToolExecutionContext,
    );

    expect((sendResult as any).effect).toMatchObject({
      kind: "send",
      target: source,
      deliverable: true,
      verified: true,
    });
  });

  it("remember exposes a memory effect", async () => {
    const saveMemory = vi.fn().mockResolvedValue(undefined);

    const result = await rememberTool.execute(
      {
        content: "用户偏好最终交付文件。",
        type: "preference",
      },
      { saveMemory } as unknown as ToolExecutionContext,
    );

    expect((result as any).effect).toMatchObject({
      kind: "memory",
      target: "preference",
      reversible: false,
      verified: true,
    });
  });

  it("bash exposes a read effect for non-mutating commands", async () => {
    const result = await shellTool.execute({ command: "echo hello" });

    expect((result as any).effect).toMatchObject({
      kind: "read",
      reversible: false,
      verified: true,
    });
  });
});
