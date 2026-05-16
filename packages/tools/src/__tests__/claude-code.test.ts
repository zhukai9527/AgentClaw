import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const execFileSyncMock = vi.fn();
const realpathNativeMock = vi.hoisted(() => vi.fn((path: string) => path));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFileSync: execFileSyncMock,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const realpathSync = Object.assign(vi.fn((path: string) => path), {
    native: realpathNativeMock,
  });
  return { ...actual, realpathSync };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    throw new Error("spawn claude ENOENT");
  }),
}));

function createChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 1234;
  child.kill = vi.fn();
  return child;
}

describe("claude_code 外部委托", () => {
  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    execFileSyncMock.mockReset();
    realpathNativeMock.mockReset();
    realpathNativeMock.mockImplementation((path: string) => path);
  });

  it("Claude 不可用时应快速改用 Codex", async () => {
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      const isLocator = command === "where" || command === "which";
      if (isLocator && args[0] === "claude") {
        throw new Error("INFO: Could not find files");
      }
      if (isLocator && args[0] === "codex") {
        return "C:\\Users\\voroj\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe\r\n";
      }
      return "";
    });

    spawnMock.mockImplementation((command: string) => {
      const child = createChildProcess();
      if (command.toLowerCase().includes("codex")) {
        child.stdin.on("finish", () => {
          child.stdout.write(
            JSON.stringify({
              type: "agent_message",
              message: "Codex 已完成任务。",
            }) + "\n",
          );
          child.stdout.end();
          child.emit("close", 0);
        });
      } else {
        queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      }
      return child;
    });

    const { claudeCodeTool } = await import("../builtin/claude-code.js");
    const result = await claudeCodeTool.execute({
      prompt: "创建一个 HTML 文件",
      cwd: "D:/tmp/work",
      timeout: 10_000,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Codex completed");
    expect(result.content).toContain("Codex 已完成任务");
    expect(result.metadata?.transport).toBe("codex");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(String(spawnMock.mock.calls[0][0]).toLowerCase()).toContain("codex");
  });

  it("Windows Store/Codex 杞帴璺緞搴旇В鏋愪负 Node 鍙?spawn 鐨勭湡瀹炶矾寰?", async () => {
    const aliasPath =
      "C:\\Users\\voroj\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";
    const realPath =
      "C:\\Users\\voroj\\AppData\\Local\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local\\OpenAI\\Codex\\bin\\codex.exe";

    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      const isLocator = command === "where" || command === "which";
      if (isLocator && args[0] === "claude") {
        throw new Error("INFO: Could not find files");
      }
      if (isLocator && args[0] === "codex") {
        return `${aliasPath}\r\n`;
      }
      return "";
    });
    realpathNativeMock.mockImplementation((path: string) =>
      path === aliasPath ? realPath : path,
    );

    spawnMock.mockImplementation((command: string) => {
      const child = createChildProcess();
      if (command === realPath) {
        child.stdin.on("finish", () => {
          child.stdout.write(
            JSON.stringify({
              type: "agent_message",
              message: "Codex completed",
            }) + "\n",
          );
          child.stdout.end();
          child.emit("close", 0);
        });
      } else {
        queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      }
      return child;
    });

    const { claudeCodeTool } = await import("../builtin/claude-code.js");
    const result = await claudeCodeTool.execute({
      prompt: "test",
      cwd: "D:/tmp/work",
      timeout: 10_000,
    });

    expect(result.isError).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe(realPath);
  });
});
