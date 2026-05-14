import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../../..");
const skillPath = resolve(repoRoot, "skills/pptx/SKILL.md");

describe("pptx skill production workflow", () => {
  const skill = readFileSync(skillPath, "utf8");

  it("documents a design-first workflow instead of only python-pptx snippets", () => {
    const requiredSections = [
      "## Choose the production path",
      "## Design intake",
      "## HTML-first deck workflow",
      "## Editable PPTX constraints",
      "## Python-pptx fallback",
      "## Verification",
    ];

    for (const section of requiredSections) {
      expect(skill).toContain(section);
    }
  });

  it("keeps the high-leverage quality gates explicit", () => {
    const requiredPhrases = [
      "two-slide showcase",
      "brand-spec.md",
      "anti-slop",
      "960pt × 540pt",
      "text must be wrapped",
      "render PNG previews",
      "LibreOffice",
    ];

    for (const phrase of requiredPhrases) {
      expect(skill).toContain(phrase);
    }
  });

  it("does not preserve stale environment or delivery instructions", () => {
    expect(skill).not.toContain("ALWAYS use bash shell");
    expect(skill).not.toContain("send_file");
  });
});
