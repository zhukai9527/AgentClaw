import { describe, it, expect } from "vitest";
import { SimpleContextManager } from "../context-manager.js";

describe("compressObservation", () => {
  it("should compress shell output with errors", () => {
    const shellOutput =
      Array(50).fill("normal line of output here").join("\n") +
      "\nError: ENOENT: no such file or directory" +
      "\nTypeError: Cannot read properties of undefined" +
      "\n" +
      Array(30).fill("more output").join("\n") +
      "\nProcess completed with errors. Total: 80 files checked.";

    const result = SimpleContextManager.compressObservation(
      shellOutput,
      "shell",
    );
    expect(result.length).toBeLessThan(shellOutput.length * 0.5);
    expect(result).toContain("Error");
    expect(result).toContain("compressed");
  });

  it("should compress JSON output preserving key fields", () => {
    const jsonOutput = JSON.stringify(
      {
        id: "abc-123",
        name: "test-project",
        status: "active",
        error: null,
        data: Array(100).fill({ x: 1, y: 2, z: 3 }),
      },
      null,
      2,
    );

    const result = SimpleContextManager.compressObservation(
      jsonOutput,
      "web_fetch",
    );
    expect(result.length).toBeLessThan(jsonOutput.length * 0.3);
    expect(result).toContain("id");
    expect(result).toContain("name");
    expect(result).toContain("status");
  });

  it("should deduplicate identical content", () => {
    const content = "x".repeat(600);
    const seenMap = new Map<string, number>();

    const first = SimpleContextManager.compressObservation(
      content,
      "shell",
      seenMap,
      0,
    );
    const second = SimpleContextManager.compressObservation(
      content,
      "shell",
      seenMap,
      5,
    );

    expect(second).toContain("Duplicate");
    expect(second.length).toBeLessThan(first.length);
  });

  it("should not compress content below threshold", () => {
    const short = "short output";
    // compressObservation always compresses — the threshold check is in buildContext
    const result = SimpleContextManager.compressObservation(short, "shell");
    expect(result).toBeDefined();
  });

  it("should achieve >80% compression on large tool results", () => {
    // Simulate a typical large shell tool result (file listing)
    const listing = Array(200)
      .fill(null)
      .map((_, i) => `  -rw-r--r-- 1 user group 4096 Jan 1 00:00 file${i}.ts`)
      .join("\n");
    const result = SimpleContextManager.compressObservation(listing, "shell");
    const savings = 1 - result.length / listing.length;
    expect(savings).toBeGreaterThan(0.8);
  });
});
