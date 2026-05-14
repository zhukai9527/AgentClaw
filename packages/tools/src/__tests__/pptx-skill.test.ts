import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../../..");
const skillPath = resolve(repoRoot, "skills/pptx/SKILL.md");
const verifierPath = resolve(repoRoot, "skills/pptx/scripts/verify_pptx.py");

describe("pptx skill production workflow", () => {
  const skill = readFileSync(skillPath, "utf8");

  it("documents a design-first workflow instead of only python-pptx snippets", () => {
    const requiredSections = [
      "## Default fast path",
      "## Short prompt in an existing session",
      "## Production paths",
      "## Editable PPTX constraints",
      "## Hard stop rules",
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
      'python "{VERIFY_PPTX}"',
      "claude_code",
      "Do not send the PPTX",
    ];

    for (const phrase of requiredPhrases) {
      expect(skill).toContain(phrase);
    }
  });

  it("does not preserve stale environment or delivery instructions", () => {
    expect(skill).not.toContain("ALWAYS use bash shell");
    expect(skill).not.toContain("send_file");
  });

  it("keeps executable details in the verifier script instead of a huge inline generator", () => {
    expect(existsSync(verifierPath)).toBe(true);
    expect(skill).not.toContain("def add_text(");
    expect(skill).not.toContain('prs.save("output.pptx")');
    expect(skill.length).toBeLessThan(8000);

    const verifier = readFileSync(verifierPath, "utf8");
    expect(verifier).toContain("verify_report.json");
    expect(verifier).toContain("require_preview");
    expect(verifier).toContain("python-pptx");
  });
});
