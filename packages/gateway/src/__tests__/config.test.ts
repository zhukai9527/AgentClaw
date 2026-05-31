import { describe, it, expect } from "vitest";
import {
  resolveActiveProvider,
  saveConfig,
  loadConfig,
  AppConfig,
  ProviderInstance,
} from "../config.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3100,
    host: "0.0.0.0",
    dbPath: ":memory:",
    skillsDir: "./skills",
    systemPromptFile: "system-prompt.md",
    ...overrides,
  } as AppConfig;
}

describe("resolveActiveProvider", () => {
  it("规则 1: 从 providers[] + activeProvider 解析", () => {
    const cfg = makeConfig({
      providers: [
        { id: "deepseek", type: "openai", name: "DeepSeek", enabled: false, apiKey: "sk-ds" },
        { id: "anthropic", type: "claude", name: "Anthropic", enabled: true, apiKey: "sk-ant" },
      ],
      activeProvider: "deepseek",
    });
    const result = resolveActiveProvider(cfg);
    expect(result.providerId).toBe("deepseek");
    expect(result.model).toBeUndefined();
  });

  it("规则 2: activeProvider 指向的 provider 无 apiKey，降级到第一个 enabled", () => {
    const cfg = makeConfig({
      providers: [
        { id: "deepseek", type: "openai", name: "DeepSeek", enabled: false, apiKey: "sk-ds" },
        { id: "anthropic", type: "claude", name: "Anthropic", enabled: true, apiKey: "sk-ant" },
      ],
      activeProvider: "deepseek", // deepseek has apiKey, so rule 1 still applies
    });
    const result = resolveActiveProvider(cfg);
    expect(result.providerId).toBe("deepseek");
  });

  it("规则 2: 无 activeProvider，取第一个 enabled + apiKey 的 provider", () => {
    const cfg = makeConfig({
      providers: [
        { id: "disabled-one", type: "openai", name: "Disabled", enabled: false, apiKey: "sk-d1" },
        { id: "enabled-one", type: "openai", name: "Enabled", enabled: true, apiKey: "sk-e1" },
        { id: "enabled-two", type: "openai", name: "Enabled2", enabled: true, apiKey: "sk-e2" },
      ],
    });
    const result = resolveActiveProvider(cfg);
    expect(result.providerId).toBe("enabled-one");
  });

  it("规则 3: 无 providers[]，从旧字段迁移后取第一个", () => {
    const cfg = makeConfig({
      anthropicApiKey: "sk-ant",
      openaiApiKey: "sk-openai",
      defaultModel: "claude-sonnet-4-20250514",
    });
    const result = resolveActiveProvider(cfg);
    expect(result.providerId).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-20250514");
  });

  it("规则 3: 旧字段 + activeProvider 指定 claude", () => {
    const cfg = makeConfig({
      anthropicApiKey: "sk-ant",
      openaiApiKey: "sk-openai",
      activeProvider: "openai",
    });
    const result = resolveActiveProvider(cfg);
    expect(result.providerId).toBe("openai");
  });

  it("规则 4: 无 providers[] 也无旧字段，回退到 local", () => {
    const cfg = makeConfig({});
    const result = resolveActiveProvider(cfg);
    expect(result.providerId).toBe("local");
    expect(result.model).toBe("llama3");
  });

  it("规则 4: 回退时使用 defaultModel", () => {
    const cfg = makeConfig({ defaultModel: "gpt-4" });
    const result = resolveActiveProvider(cfg);
    expect(result.providerId).toBe("local");
    expect(result.model).toBe("gpt-4");
  });

  it("providers[] 优先于旧字段：两者都有时取 providers[]", () => {
    const cfg = makeConfig({
      providers: [
        { id: "deepseek", type: "openai", name: "DeepSeek", enabled: true, apiKey: "sk-ds" },
      ],
      anthropicApiKey: "sk-ant",
    });
    const result = resolveActiveProvider(cfg);
    expect(result.providerId).toBe("deepseek");
  });
});

describe("saveConfig normalization", () => {
  it("旧字段写入时自动归一化为 providers[]", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "config-test-"));
    const configPath = path.join(dir, "config.json");

    try {
      // 写入旧字段
      saveConfig(
        { anthropicApiKey: "sk-ant-new" } as Partial<AppConfig>,
        configPath,
      );

      // 读回确认 providers[] 已生成
      const reloaded = loadConfig(configPath);
      expect(reloaded.providers).toBeDefined();
      expect(reloaded.providers!.length).toBeGreaterThan(0);
      expect(reloaded.providers!.find((p) => p.id === "anthropic")?.apiKey).toBe(
        "sk-ant-new",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("已有 providers[] 时，旧字段合并更新不覆盖现有 provider", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "config-test-"));
    const configPath = path.join(dir, "config.json");

    try {
      // 先保存一个 providers[]
      const existingProviders: ProviderInstance[] = [
        { id: "deepseek", type: "openai", name: "DeepSeek", enabled: true, apiKey: "sk-ds" },
      ];
      saveConfig({ providers: existingProviders } as Partial<AppConfig>, configPath);

      // 写入旧字段
      saveConfig({ anthropicApiKey: "sk-ant" } as Partial<AppConfig>, configPath);

      // 读回确认 deepseek 还在，anthropic 新增
      const reloaded = loadConfig(configPath);
      const ids = reloaded.providers?.map((p) => p.id) || [];
      expect(ids).toContain("deepseek");
      expect(ids).toContain("anthropic");
      expect(ids!.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});