import { describe, expect, it } from "vitest";
import { initDatabase } from "../database.js";
import { SQLiteMemoryStore } from "../store.js";

function createStore(): SQLiteMemoryStore {
  return new SQLiteMemoryStore(initDatabase(":memory:"));
}

describe("SQLiteMemoryStore — Observation Store", () => {
  it("应保存并读取 observation，且 JSON facts/metadata 往返不丢", async () => {
    const store = createStore();

    const created = await store.addObservation({
      traceId: "trace-1",
      stepId: "step-2",
      toolName: "web.open",
      inputHash: "input-sha256-1",
      contentHash: "content-sha256-1",
      rawPath: "observations/trace-1/step-2.json",
      preview: "页面标题：AgentClaw",
      facts: [
        { kind: "title", value: "AgentClaw" },
        { kind: "status", value: 200 },
      ],
      metadata: {
        url: "https://example.test",
        tags: ["browser", "observation"],
        nested: { stable: true },
      },
      rawChars: 1200,
      promptChars: 180,
      savedChars: 1020,
    });

    const loaded = await store.getObservation(created.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(created.id);
    expect(loaded!.traceId).toBe("trace-1");
    expect(loaded!.stepId).toBe("step-2");
    expect(loaded!.toolName).toBe("web.open");
    expect(loaded!.inputHash).toBe("input-sha256-1");
    expect(loaded!.contentHash).toBe("content-sha256-1");
    expect(loaded!.rawPath).toBe("observations/trace-1/step-2.json");
    expect(loaded!.preview).toBe("页面标题：AgentClaw");
    expect(loaded!.facts).toEqual([
      { kind: "title", value: "AgentClaw" },
      { kind: "status", value: 200 },
    ]);
    expect(loaded!.metadata).toEqual({
      url: "https://example.test",
      tags: ["browser", "observation"],
      nested: { stable: true },
    });
    expect(loaded!.rawChars).toBe(1200);
    expect(loaded!.promptChars).toBe(180);
    expect(loaded!.savedChars).toBe(1020);
    expect(loaded!.createdAt).toBeInstanceOf(Date);
  });

  it("应能按 contentHash 查找去重 observation", async () => {
    const store = createStore();

    const created = await store.addObservation({
      traceId: "trace-dedup",
      stepId: "step-1",
      toolName: "tool.result",
      inputHash: "input-hash",
      contentHash: "same-content-hash",
      rawPath: "raw/result.json",
      preview: "同一份工具结果",
      facts: [],
      metadata: {},
      rawChars: 42,
      promptChars: 12,
      savedChars: 30,
    });

    const found = await store.findObservationByHash("same-content-hash");
    const missing = await store.findObservationByHash("missing-content-hash");

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.contentHash).toBe("same-content-hash");
    expect(missing).toBeNull();
  });

  it("应记录 observation read 并按时间查询", async () => {
    const store = createStore();
    const observation = await store.addObservation({
      traceId: "trace-read",
      stepId: "step-read",
      toolName: "filesystem.read",
      inputHash: "read-input",
      contentHash: "read-content",
      rawPath: "raw/read.txt",
      preview: "读取结果",
      facts: [{ path: "README.md" }],
      metadata: { source: "test" },
      rawChars: 100,
      promptChars: 40,
      savedChars: 60,
    });

    const first = await store.recordObservationRead({
      observationId: observation.id,
      traceId: "consumer-trace-1",
      stepId: "consumer-step-1",
      query: "README",
      returnedChars: 40,
    });
    const second = await store.recordObservationRead({
      observationId: observation.id,
      traceId: "consumer-trace-2",
      stepId: "consumer-step-2",
      offset: 10,
      length: 20,
      returnedChars: 15,
    });

    const reads = await store.listObservationReads(observation.id);

    expect(reads.map((read) => read.id)).toEqual([first.id, second.id]);
    expect(reads[0]).toMatchObject({
      observationId: observation.id,
      traceId: "consumer-trace-1",
      stepId: "consumer-step-1",
      query: "README",
      returnedChars: 40,
    });
    expect(reads[1]).toMatchObject({
      id: second.id,
      offset: 10,
      length: 20,
      returnedChars: 15,
    });
    expect(reads[0].readAt).toBeInstanceOf(Date);
  });
});
