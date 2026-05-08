import { describe, expect, it } from "vitest";
import { renderSystemPromptTemplate } from "../bootstrap.js";

describe("系统提示词模板", () => {
  it("启动时不应固化每次请求都需要更新的时间变量", () => {
    const rendered = renderSystemPromptTemplate(
      "{{datetime}}|{{timezone}}|{{os}}|{{#if isWindows}}WIN{{/if}}|{{#if platformHint}}P{{/if}}|{{soul}}",
      {
        datetime: "旧时间",
        timezone: "旧时区",
        os: "Windows",
        isWindows: "true",
        platformHint: "",
        soul: "人格",
      },
    );

    expect(rendered).toContain("{{datetime}}");
    expect(rendered).toContain("{{timezone}}");
    expect(rendered).toContain("Windows");
    expect(rendered).toContain("WIN");
    expect(rendered).toContain("{{#if platformHint}}P{{/if}}");
    expect(rendered).toContain("{{soul}}");
    expect(rendered).not.toContain("旧时间");
  });
});
