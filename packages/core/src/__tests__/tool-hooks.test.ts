import { describe, expect, it } from "vitest";
import { ToolHookManager } from "../tool-hooks.js";

describe("ToolHookManager preset hooks", () => {
  it("bash 命令非零退出码必须追加警告", async () => {
    const manager = new ToolHookManager();
    manager.registerPresetHooks();

    const result = await manager.runAfterHooks(
      { name: "bash", input: { command: "exit 1" } },
      {
        content: "stderr output",
        isError: true,
        metadata: { exitCode: 1 },
      },
    );

    expect(result.content).toContain("Command exited with code 1");
  });
});
