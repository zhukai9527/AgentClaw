import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileReadTool } from "../builtin/file-read.js";
import { sendFileTool } from "../builtin/send-file.js";
import { webFetchTool } from "../builtin/web-fetch.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentclaw-tools-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("trace efficiency tool behavior", () => {
  it("returns only a bounded preview when reading an overflow file without a range", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "overflow_execute_code_123.txt");
    await writeFile(path, "a".repeat(12_000), "utf-8");

    const result = await fileReadTool.execute({ path });

    expect(result.isError).toBe(false);
    expect(result.content.length).toBeLessThan(2_500);
    expect(result.content).toContain("overflow file preview");
    expect(result.metadata).toMatchObject({
      overflowPreview: true,
      originalLength: 12_000,
    });
  });

  it("supports bounded range reads for overflow files", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "overflow_execute_code_456.txt");
    await writeFile(path, `${"a".repeat(100)}TARGET${"b".repeat(100)}`, "utf-8");

    const result = await fileReadTool.execute({ path, offset: 95, length: 20 });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("TARGET");
    expect(result.content.length).toBeLessThan(400);
    expect(result.metadata).toMatchObject({
      overflowRange: true,
      offset: 95,
      length: 20,
    });
  });

  it("reports original and effective paths when send_file relocates a file", async () => {
    const sourceDir = await makeTmpDir();
    const workDir = await makeTmpDir();
    const sourcePath = join(sourceDir, "daily.md");
    await writeFile(sourcePath, "# daily", "utf-8");
    const sendFile = vi.fn().mockResolvedValue(undefined);

    const result = await sendFileTool.execute(
      { path: sourcePath, caption: "daily" },
      { workDir, sendFile },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("original=");
    expect(result.content).toContain("effective=");
    expect(result.metadata).toMatchObject({
      originalPath: sourcePath,
      relocated: true,
    });
    expect(sendFile).toHaveBeenCalledWith(join(workDir, "daily.md"), "daily");
  });

  it("does not mark an absolute file inside workDir as relocated", async () => {
    const workDir = await makeTmpDir();
    const sourcePath = join(workDir, "already-there.md");
    await writeFile(sourcePath, "# daily", "utf-8");
    const sendFile = vi.fn().mockResolvedValue(undefined);

    const result = await sendFileTool.execute(
      { path: sourcePath, caption: "daily" },
      { workDir, sendFile },
    );

    expect(result.isError).toBe(false);
    expect(result.metadata).toMatchObject({
      originalPath: sourcePath,
      effectivePath: sourcePath,
      relocated: false,
    });
    expect(sendFile).toHaveBeenCalledWith(sourcePath, "daily");
  });

  it("does not append human guidance to JSON responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => '{"ok":true}',
    } as Response);

    const result = await webFetchTool.execute({ url: "https://example.com/data.json" });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ ok: true });
    expect(result.content).not.toContain("hint:");
  });
});
