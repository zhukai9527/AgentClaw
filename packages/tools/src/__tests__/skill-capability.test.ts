import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  SkillChangeInput,
  SkillUsageEvent,
  SkillUsageStats,
  ToolExecutionContext,
} from "@agentclaw/types";
import { skillCuratorTool } from "../builtin/skill-curator.js";
import { skillManageTool } from "../builtin/skill-manage.js";
import { useSkillTool } from "../builtin/use-skill.js";

let rootDir: string;
let skillsDir: string;
let archiveDir: string;
let backupDir: string;
let changes: SkillChangeInput[];
let usages: SkillUsageEvent[];
let usageStats: SkillUsageStats[];

function createContext(): ToolExecutionContext {
  return {
    skillsDir,
    skillArchiveDir: archiveDir,
    skillBackupDir: backupDir,
    recordSkillChange: async (change) => {
      changes.push(change);
      return {
        id: `change-${changes.length}`,
        ...change,
        skillName: change.skillName ?? change.skillId,
        createdAt: change.createdAt ?? new Date(),
      };
    },
    recordSkillUsage: async (event) => {
      usages.push(event);
      const now = event.usedAt ?? new Date();
      const existing = usageStats.find(
        (stat) => stat.skillId === event.skillId,
      );
      if (existing) {
        existing.useCount += 1;
        existing.successCount += event.success ? 1 : 0;
        existing.failureCount += event.success ? 0 : 1;
        existing.lastUsedAt = now;
        existing.updatedAt = now;
        existing.lastError = event.error ?? existing.lastError;
      } else {
        usageStats.push({
          skillId: event.skillId,
          skillName: event.skillName ?? event.skillId,
          useCount: 1,
          successCount: event.success ? 1 : 0,
          failureCount: event.success ? 0 : 1,
          lastUsedAt: now,
          lastError: event.error,
          agentId: event.agentId,
          createdAt: now,
          updatedAt: now,
          metadata: event.metadata,
        });
      }
    },
    listSkillUsageStats: async () => usageStats,
    listSkillChangeHistory: async () =>
      changes.map((change, index) => ({
        id: `change-${index + 1}`,
        ...change,
        skillName: change.skillName ?? change.skillId,
        createdAt: change.createdAt ?? new Date(),
      })),
    skillRegistry: {
      get: (id) => {
        const skillPath = path.join(skillsDir, id, "SKILL.md");
        if (!existsSync(skillPath)) return undefined;
        const content = readFileSync(skillPath, "utf-8");
        return {
          id,
          name: frontmatterValue(content, "name") ?? id,
          description: frontmatterValue(content, "description") ?? "",
          instructions: content,
          path: skillPath,
        };
      },
      list: () =>
        readdirSync(skillsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .flatMap((entry) => {
            const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
            if (!existsSync(skillPath)) return [];
            const content = readFileSync(skillPath, "utf-8");
            return [
              {
                id: entry.name,
                name: frontmatterValue(content, "name") ?? entry.name,
                description: frontmatterValue(content, "description") ?? "",
                enabled: true,
              },
            ];
          }),
    },
  };
}

describe("Skill P0 capability evolution", () => {
  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "agentclaw-skill-capability-"));
    skillsDir = path.join(rootDir, "skills");
    archiveDir = path.join(rootDir, "archive");
    backupDir = path.join(rootDir, "backups");
    mkdirSync(skillsDir, { recursive: true });
    changes = [];
    usages = [];
    usageStats = [];
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("detects a weak skill as improvable instead of silently accepting it", async () => {
    writeSkill(
      "weak-research",
      "Weak Research",
      "research helper",
      "Only prose.",
    );

    const result = await skillCuratorTool.execute(
      { action: "analyze", dryRun: true, staleDays: 9999 },
      createContext(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("weak-research");
    expect(result.content).toContain("missing_sections");
  });

  it("improves a weak skill by an objective quality score", async () => {
    writeSkill(
      "weak-research",
      "Weak Research",
      "research helper",
      "Only prose.",
    );
    const before = readSkill("weak-research");
    const beforeScore = skillQualityScore(before);

    const result = await skillManageTool.execute(
      {
        action: "patch",
        skillId: "weak-research",
        oldString: "Only prose.",
        newString: improvedResearchBody(),
        reason: "turn weak prose into reusable procedure",
      },
      createContext(),
    );

    const after = readSkill("weak-research");
    expect(result.isError).toBeUndefined();
    expect(skillQualityScore(after)).toBeGreaterThan(beforeScore + 3);
    expect(after).toContain("## Verification");
  });

  it("keeps the improved skill loadable through use_skill", async () => {
    writeSkill(
      "weak-research",
      "Weak Research",
      "research helper",
      "Only prose.",
    );
    await skillManageTool.execute(
      {
        action: "patch",
        skillId: "weak-research",
        oldString: "Only prose.",
        newString: improvedResearchBody(),
      },
      createContext(),
    );

    const result = await useSkillTool.execute(
      { name: "weak-research" },
      createContext(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("## Procedure");
    expect(result.content).toContain("## Verification");
    expect(usages.at(-1)).toMatchObject({
      skillId: "weak-research",
      success: true,
    });
  });

  it("records a real before/after hash change for the improvement", async () => {
    writeSkill(
      "weak-research",
      "Weak Research",
      "research helper",
      "Only prose.",
    );

    await skillManageTool.execute(
      {
        action: "patch",
        skillId: "weak-research",
        oldString: "Only prose.",
        newString: improvedResearchBody(),
        reason: "quality score improvement",
      },
      createContext(),
    );

    const patch = changes.find((change) => change.action === "patch");
    expect(patch?.success).toBe(true);
    expect(patch?.reason).toBe("quality score improvement");
    expect(patch?.beforeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(patch?.afterHash).toMatch(/^[a-f0-9]{64}$/);
    expect(patch?.beforeHash).not.toBe(patch?.afterHash);
  });

  it("does not mutate unrelated skills while improving one target skill", async () => {
    writeSkill(
      "weak-research",
      "Weak Research",
      "research helper",
      "Only prose.",
    );
    writeSkill(
      "stable-writer",
      "Stable Writer",
      "writing helper",
      goodWriterBody(),
    );
    const stableBefore = readSkill("stable-writer");

    await skillManageTool.execute(
      {
        action: "patch",
        skillId: "weak-research",
        oldString: "Only prose.",
        newString: improvedResearchBody(),
      },
      createContext(),
    );

    expect(readSkill("stable-writer")).toBe(stableBefore);
  });

  it("rejects a patch that would break SKILL.md structure and preserves quality", async () => {
    writeSkill(
      "stable-writer",
      "Stable Writer",
      "writing helper",
      goodWriterBody(),
    );
    const before = readSkill("stable-writer");
    const beforeScore = skillQualityScore(before);

    const result = await skillManageTool.execute(
      {
        action: "patch",
        skillId: "stable-writer",
        oldString: "---\n",
        newString: "",
      },
      createContext(),
    );

    expect(result.isError).toBe(true);
    expect(readSkill("stable-writer")).toBe(before);
    expect(skillQualityScore(readSkill("stable-writer"))).toBe(beforeScore);
  });

  it("rejects ambiguous patches without degrading the skill", async () => {
    writeSkill(
      "ambiguous",
      "Ambiguous",
      "ambiguous helper",
      "## Procedure\nrepeat\nrepeat\n\n## Verification\n- Check output.",
    );
    const before = readSkill("ambiguous");

    const result = await skillManageTool.execute(
      {
        action: "patch",
        skillId: "ambiguous",
        oldString: "repeat",
        newString: "changed",
      },
      createContext(),
    );

    expect(result.isError).toBe(true);
    expect(readSkill("ambiguous")).toBe(before);
  });

  it("curator dry-run reports actions without changing active skill files", async () => {
    writeSkill(
      "weak-research",
      "Weak Research",
      "research helper",
      "Only prose.",
    );
    const before = readSkill("weak-research");

    const result = await skillCuratorTool.execute(
      { action: "analyze", dryRun: true, staleDays: 9999 },
      createContext(),
    );

    expect(result.isError).toBeUndefined();
    expect(readSkill("weak-research")).toBe(before);
    expect(existsSync(path.join(archiveDir, "weak-research"))).toBe(false);
  });

  it("curator archives only stale skills and keeps successfully used skills active", async () => {
    writeSkill("stale-skill", "Stale Skill", "old helper", "Only prose.");
    writeSkill(
      "active-skill",
      "Active Skill",
      "active helper",
      goodWriterBody(),
    );
    usageStats = [
      makeUsageStat("stale-skill", 0, 0, "2025-01-01T00:00:00Z"),
      makeUsageStat("active-skill", 3, 3, "2026-05-01T00:00:00Z"),
    ];

    const result = await skillCuratorTool.execute(
      { action: "analyze", dryRun: false, staleDays: 30 },
      createContext(),
    );

    expect(result.isError).toBeUndefined();
    expect(existsSync(path.join(archiveDir, "stale-skill", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(path.join(skillsDir, "stale-skill", "SKILL.md"))).toBe(
      false,
    );
    expect(existsSync(path.join(skillsDir, "active-skill", "SKILL.md"))).toBe(
      true,
    );
  });

  it("curator creates a matching backup before archiving a stale skill", async () => {
    writeSkill("stale-skill", "Stale Skill", "old helper", "Only prose.");
    const original = readSkill("stale-skill");
    usageStats = [makeUsageStat("stale-skill", 0, 0, "2025-01-01T00:00:00Z")];

    await skillCuratorTool.execute(
      { action: "analyze", dryRun: false, staleDays: 30 },
      createContext(),
    );

    const backupSkillFiles = findSkillFiles(backupDir);
    expect(backupSkillFiles).toHaveLength(1);
    expect(readFileSync(backupSkillFiles[0], "utf-8")).toBe(original);
  });

  it("telemetry shows the loop moved from weak to successful use", async () => {
    writeSkill(
      "weak-research",
      "Weak Research",
      "research helper",
      "Only prose.",
    );
    await useSkillTool.execute({ name: "missing-skill" }, createContext());
    await skillManageTool.execute(
      {
        action: "patch",
        skillId: "weak-research",
        oldString: "Only prose.",
        newString: improvedResearchBody(),
      },
      createContext(),
    );
    await useSkillTool.execute({ name: "weak-research" }, createContext());

    expect(usages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skillId: "missing-skill", success: false }),
        expect.objectContaining({ skillId: "weak-research", success: true }),
      ]),
    );
    expect(changes.some((change) => change.action === "patch")).toBe(true);
  });
});

function writeSkill(
  id: string,
  name: string,
  description: string,
  body: string,
): void {
  const dir = path.join(skillsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    "utf-8",
  );
}

function readSkill(id: string): string {
  return readFileSync(path.join(skillsDir, id, "SKILL.md"), "utf-8");
}

function improvedResearchBody(): string {
  return [
    "## Procedure",
    "1. Collect at least two primary sources.",
    "2. Extract claims, dates, and concrete evidence.",
    "3. Compare conflicts before writing the answer.",
    "",
    "## Verification",
    "- Confirm every important claim has a source.",
    "- Confirm no unsupported conclusion remains.",
  ].join("\n");
}

function goodWriterBody(): string {
  return [
    "## Procedure",
    "1. Identify audience and desired outcome.",
    "2. Draft with concise structure.",
    "",
    "## Verification",
    "- Confirm the final text has a concrete next action.",
  ].join("\n");
}

function skillQualityScore(content: string): number {
  let score = 0;
  if (/^---\s*\n[\s\S]*?\n---/m.test(content)) score += 1;
  if (/^description:\s*\S+/m.test(content)) score += 1;
  if (/^##\s+Procedure/m.test(content)) score += 2;
  if (/^##\s+Verification/m.test(content)) score += 2;
  if (/\n1\.\s+\S+/.test(content)) score += 1;
  if (/source|evidence|claim/i.test(content)) score += 1;
  return score;
}

function frontmatterValue(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

function makeUsageStat(
  skillId: string,
  useCount: number,
  successCount: number,
  lastUsedAt: string,
): SkillUsageStats {
  const date = new Date(lastUsedAt);
  return {
    skillId,
    skillName: skillId,
    useCount,
    successCount,
    failureCount: useCount - successCount,
    lastUsedAt: date,
    createdAt: date,
    updatedAt: date,
  };
}

function findSkillFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((entry) => path.join(dir, String(entry)))
    .filter((entryPath) => path.basename(entryPath) === "SKILL.md");
}
