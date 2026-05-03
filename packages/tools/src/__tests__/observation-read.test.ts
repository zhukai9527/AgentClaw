import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "@agentclaw/types";
import { createBuiltinTools } from "../builtin/index.js";
import { observationReadTool } from "../builtin/observation-read.js";

function createContext(raw: string): ToolExecutionContext {
  return {
    getObservation: vi.fn(async (id: string) => ({
      id,
      raw,
    })),
    recordObservationRead: vi.fn(async () => undefined),
  };
}

describe("observation_read", () => {
  it("可通过 builtin 工具工厂显式加载", () => {
    const tools = createBuiltinTools({ observationRead: true });

    expect(tools.map((tool) => tool.name)).toContain("observation_read");
  });

  it("禁止无 query 和无范围参数时全文读取", async () => {
    const raw = "x".repeat(5000);
    const context = createContext(raw);

    const result = await observationReadTool.execute({ id: "obs-1" }, context);

    expect(result.isError).toBe(false);
    expect(result.content.length).toBeLessThan(raw.length);
    expect(result.content.length).toBeLessThanOrEqual(1200);
    expect(result.content).not.toBe(raw);
    expect(context.recordObservationRead).toHaveBeenCalledWith({
      id: "obs-1",
      returnedChars: result.content.length,
      query: undefined,
      offset: undefined,
      length: undefined,
    });
  });

  it("按 offset/length 范围读取且最多返回 4000 chars", async () => {
    const raw = `${"a".repeat(100)}${"b".repeat(5000)}`;
    const context = createContext(raw);

    const result = await observationReadTool.execute(
      { id: "obs-2", offset: 100, length: 4500 },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("b".repeat(4000));
    expect(context.recordObservationRead).toHaveBeenCalledWith({
      id: "obs-2",
      returnedChars: 4000,
      query: undefined,
      offset: 100,
      length: 4500,
    });
  });

  it("query 返回命中行附近片段且整体最多 4000 chars", async () => {
    const raw = [
      "first line",
      "before target line",
      `target ${"z".repeat(5000)}`,
      "after target line",
      "last line",
    ].join("\n");
    const context = createContext(raw);

    const result = await observationReadTool.execute(
      { id: "obs-3", query: "target" },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.content.length).toBeLessThanOrEqual(4000);
    expect(result.content).toContain("before target line");
    expect(result.content).toContain("target");
    expect(result.content).toContain("after target line");
    expect(result.content).not.toContain("first line");
    expect(result.content).not.toContain("last line");
    expect(context.recordObservationRead).toHaveBeenCalledWith({
      id: "obs-3",
      returnedChars: result.content.length,
      query: "target",
      offset: undefined,
      length: undefined,
    });
  });

  it("query 命中行不会被超长相邻行挤出返回结果", async () => {
    const raw = [
      "x".repeat(9000),
      "NEEDLE_FACT: observation store closed loop works",
      "y".repeat(9000),
    ].join("\n");
    const context = createContext(raw);

    const result = await observationReadTool.execute(
      { id: "obs-needle", query: "NEEDLE_FACT" },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.content.length).toBeLessThanOrEqual(4000);
    expect(result.content).toContain("NEEDLE_FACT");
    expect(result.content).toContain("closed loop works");
  });

  it("接受 observation:// 前缀并记录 canonical id", async () => {
    const context = createContext("alpha\nNEEDLE_FACT: beta\nomega");

    const result = await observationReadTool.execute(
      { id: "observation://obs-1", query: "NEEDLE_FACT" },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("NEEDLE_FACT: beta");
    expect(context.recordObservationRead).toHaveBeenCalledWith({
      id: "obs-1",
      returnedChars: result.content.length,
      query: "NEEDLE_FACT",
      offset: undefined,
      length: undefined,
    });
  });

  it("缺少 context 回调时返回错误", async () => {
    const result = await observationReadTool.execute({ id: "obs-4" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Observation read context is not available");
  });
});
