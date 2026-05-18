import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "@agentclaw/types";
import { fileWriteTool } from "../builtin/file-write.js";
import { rememberTool } from "../builtin/remember.js";
import { rssTopTool } from "../builtin/rss-top.js";
import { scheduleTool } from "../builtin/schedule.js";
import { sendFileTool } from "../builtin/send-file.js";
import { shellTool } from "../builtin/shell.js";
import { webFetchTool } from "../builtin/web-fetch.js";

describe("Tool Effect Contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

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

  it("web_fetch save_as exposes write effect and auto_send exposes deliverable send effect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<main><h1>Title</h1><p>Body</p></main>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })),
    );
    const root = mkdtempSync(join(tmpdir(), "agentclaw-effect-fetch-"));
    const sendFile = vi.fn().mockResolvedValue(undefined);

    const saved = await webFetchTool.execute(
      { url: "https://example.com/a", save_as: "article.md" },
      { workDir: root } as ToolExecutionContext,
    );
    expect((saved as any).effect).toMatchObject({
      kind: "write",
      target: join(root, "article.md"),
      reversible: true,
      verified: true,
    });

    const sent = await webFetchTool.execute(
      {
        url: "https://example.com/a",
        save_as: "article.md",
        auto_send: true,
      },
      { workDir: root, sendFile } as unknown as ToolExecutionContext,
    );
    expect((sent as any).effect).toMatchObject({
      kind: "send",
      target: join(root, "article.md"),
      reversible: false,
      deliverable: true,
      verified: true,
    });
  });

  it("rss_top save_as exposes write effect and auto_send exposes deliverable send effect", async () => {
    const atom = `<?xml version="1.0"?><feed><entry><title>First</title><link href="https://example.com/1"/></entry></feed>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () => atom,
        headers: new Headers({ "content-type": "application/atom+xml" }),
      })),
    );
    const root = mkdtempSync(join(tmpdir(), "agentclaw-effect-rss-"));
    const sendFile = vi.fn().mockResolvedValue(undefined);

    const saved = await rssTopTool.execute(
      { feeds: ["technology"], topN: 1, save_as: "rss.md" },
      { workDir: root } as ToolExecutionContext,
    );
    expect((saved as any).effect).toMatchObject({
      kind: "write",
      target: join(root, "rss.md"),
      reversible: true,
      verified: true,
    });
    await expect(readFile(join(root, "rss.md"), "utf-8")).resolves.toContain(
      "First",
    );

    const sent = await rssTopTool.execute(
      {
        feeds: ["programming"],
        topN: 1,
        save_as: "rss-sent.md",
        auto_send: true,
      },
      { workDir: root, sendFile } as unknown as ToolExecutionContext,
    );
    expect((sent as any).effect).toMatchObject({
      kind: "send",
      target: join(root, "rss-sent.md"),
      reversible: false,
      deliverable: true,
      verified: true,
    });
  });
});
