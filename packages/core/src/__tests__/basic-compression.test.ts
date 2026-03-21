import { describe, it, expect } from "vitest";
import { SimpleContextManager } from "../context-manager.js";

describe("compressBasic", () => {
  it("should minify JSON content", () => {
    const json = JSON.stringify(
      { id: 1, name: "test", data: [1, 2, 3] },
      null,
      2,
    );
    // Pad to exceed 200 char threshold
    const padded = json + "\n".repeat(50);
    const result = SimpleContextManager.compressBasic(padded);
    expect(result.length).toBeLessThan(padded.length);
    // Should still be valid JSON (or close to it)
    expect(result).toContain('"id"');
  });

  it("should normalize excessive whitespace", () => {
    const content =
      "line 1\n\n\n\n\nline 2\n\tindented\n        deep indent\ntrailing   \nend";
    // Pad to exceed 100 char threshold
    const padded = content + " ".repeat(60);
    const result = SimpleContextManager.compressBasic(padded);
    // Max 2 consecutive newlines
    expect(result).not.toContain("\n\n\n");
    // Tabs converted to spaces
    expect(result).not.toContain("\t");
    // Deep indentation collapsed
    expect(result).not.toMatch(/ {4,}/);
  });

  it("should not modify content below 100 chars", () => {
    const short = "  short  \n\n\n  text  ";
    expect(SimpleContextManager.compressBasic(short)).toBe(short);
  });

  it("should achieve measurable savings on verbose JSON output", () => {
    // Simulate a typical pretty-printed JSON API response
    const apiResponse = JSON.stringify(
      {
        results: Array(50).fill({
          id: "abc-123",
          name: "test-item",
          status: "active",
          metadata: { key: "value", count: 42 },
        }),
      },
      null,
      2,
    );
    const result = SimpleContextManager.compressBasic(apiResponse);
    const savings = 1 - result.length / apiResponse.length;
    expect(savings).toBeGreaterThan(0.3); // JSON minification saves 30%+
  });
});

describe("applyBasicCompression", () => {
  it("should compress tool_result blocks in messages", () => {
    const jsonContent = JSON.stringify(
      { results: Array(20).fill({ id: 1, status: "ok" }) },
      null,
      2,
    );
    const messages = [
      {
        id: "1",
        role: "tool" as const,
        content: [
          {
            type: "tool_result" as const,
            toolUseId: "t1",
            content: jsonContent,
          },
        ],
        createdAt: new Date(),
      },
    ];

    const compressed = SimpleContextManager.applyBasicCompression(messages);
    const block = (compressed[0].content as Array<{ content: string }>)[0];
    expect(block.content.length).toBeLessThan(jsonContent.length);
  });

  it("should not modify user or assistant messages", () => {
    const messages = [
      {
        id: "1",
        role: "user" as const,
        content: "hello\n\n\n\nworld",
        createdAt: new Date(),
      },
      {
        id: "2",
        role: "assistant" as const,
        content: "response\n\n\n\nhere",
        createdAt: new Date(),
      },
    ];

    const compressed = SimpleContextManager.applyBasicCompression(messages);
    expect(compressed[0].content).toBe("hello\n\n\n\nworld");
    expect(compressed[1].content).toBe("response\n\n\n\nhere");
  });
});
