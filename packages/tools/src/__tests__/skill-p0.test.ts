import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  ToolExecutionContext,
} from "@agentclaw/types";
import { skillCuratorTool } from "../builtin/skill-curator.js";
import { skillManageTool } from "../builtin/skill-manage.js";
import { useSkillTool } from "../builtin/use-skill.js";

let skillsDir: string;
let archiveDir: string;
let backupDir: string;
let changes: SkillChangeInput[];
let usages: SkillUsageEvent[];

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
    },
    listSkillUsageStats: async () => [
      {
        skillId: "stale",
        skillName: "Stale",
        useCount: 0,
        successCount: 0,
        failureCount: 0,
        lastUsedAt: new Date("2025-01-01T00:00:00Z"),
        createdAt: new Date("2025-01-01T00:00:00Z"),
        updatedAt: new Date("2025-01-01T00:00:00Z"),
      },
    ],
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
        const instructions = readFileSync(skillPath, "utf-8");
        return {
          name: id,
          instructions,
          path: skillPath,
        };
      },
      list: () =>
        ["stale", "missing-sections"].flatMap((id) => {
          const skillPath = path.join(skillsDir, id, "SKILL.md");
          if (!existsSync(skillPath)) return [];
          return [
            {
              id,
              name: id === "stale" ? "Stale" : "Missing Sections",
              description: "test skill",
              enabled: true,
            },
          ];
        }),
    },
  };
}

function skillFile(id: string): string {
  return path.join(skillsDir, id, "SKILL.md");
}

function writeSkill(id: string, body: string): void {
  const dir = path.join(skillsDir, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    skillFile(id),
    `---\nname: ${id}\ndescription: test skill\n---\n${body}`,
    "utf-8",
  );
}

describe("P0 skill management tools", () => {
  beforeEach(() => {
    const root = mkdtempSync(path.join(tmpdir(), "agentclaw-skill-p0-"));
    skillsDir = path.join(root, "skills");
    archiveDir = path.join(root, "archive");
    backupDir = path.join(root, "backups");
    changes = [];
    usages = [];
  });

  afterEach(() => {
    rmSync(path.dirname(skillsDir), { recursive: true, force: true });
  });

  it("creates a skill from structured fields and records the change", async () => {
    const result = await skillManageTool.execute(
      {
        action: "create",
        skillId: "research-flow",
        name: "research-flow",
        description: "Reusable research flow",
        instructions: "## Procedure\n1. Gather sources.\n",
        reason: "capture a repeated research pattern",
      },
      createContext(),
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(skillFile("research-flow"), "utf-8")).toContain(
      "Reusable research flow",
    );
    expect(changes[0]).toMatchObject({
      skillId: "research-flow",
      action: "create",
      success: true,
      reason: "capture a repeated research pattern",
    });
    expect(changes[0].afterHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("normalizes created SKILL.md frontmatter name to the skill id", async () => {
    const result = await skillManageTool.execute(
      {
        action: "create",
        skillId: "online-gap-review",
        content:
          "---\nname: Pretty Gap Review\ndescription: reusable gap review\n---\n## Procedure\n1. Compare capabilities.\n",
      },
      createContext(),
    );

    expect(result.isError).toBeUndefined();
    const content = readFileSync(skillFile("online-gap-review"), "utf-8");
    expect(content).toContain("name: online-gap-review");
    expect(content).not.toContain("name: Pretty Gap Review");
  });

  it("create 必须使用 skillId，不能把 name 当作目录身份", async () => {
    const result = await skillManageTool.execute(
      {
        action: "create",
        name: "display-name",
        description: "Display name is not identity",
        instructions: "## Procedure\nUse canonical ids.\n",
      },
      createContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("skillId is required");
    expect(existsSync(skillFile("display-name"))).toBe(false);
  });

  it("rejects path traversal skill ids without creating files", async () => {
    const result = await skillManageTool.execute(
      {
        action: "create",
        skillId: "../escape",
        name: "escape",
        description: "bad",
        instructions: "body",
      },
      createContext(),
    );

    expect(result.isError).toBe(true);
    expect(existsSync(path.join(path.dirname(skillsDir), "escape"))).toBe(
      false,
    );
  });

  it("requires a unique oldString for patch and leaves content unchanged", async () => {
    writeSkill("patchy", "repeat\nrepeat\n");

    const result = await skillManageTool.execute(
      {
        action: "patch",
        skillId: "patchy",
        oldString: "repeat",
        newString: "changed",
      },
      createContext(),
    );

    expect(result.isError).toBe(true);
    expect(readFileSync(skillFile("patchy"), "utf-8")).toContain(
      "repeat\nrepeat",
    );
  });

  it("patches a skill and records before and after hashes", async () => {
    writeSkill("patchy", "## Procedure\nold step\n");

    const result = await skillManageTool.execute(
      {
        action: "patch",
        skillId: "patchy",
        oldString: "old step",
        newString: "new step",
        reason: "improve instructions",
      },
      createContext(),
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(skillFile("patchy"), "utf-8")).toContain("new step");
    expect(changes[0]).toMatchObject({
      skillId: "patchy",
      action: "patch",
      success: true,
      reason: "improve instructions",
    });
    expect(changes[0].beforeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(changes[0].afterHash).toMatch(/^[a-f0-9]{64}$/);
    expect(changes[0].beforeHash).not.toBe(changes[0].afterHash);
  });

  it("writes supporting files only inside the target skill directory", async () => {
    writeSkill("support", "## Procedure\nUse references.\n");

    const result = await skillManageTool.execute(
      {
        action: "write_file",
        skillId: "support",
        filePath: "references/example.md",
        content: "reference data",
      },
      createContext(),
    );

    expect(result.isError).toBeUndefined();
    expect(
      readFileSync(
        path.join(skillsDir, "support", "references", "example.md"),
        "utf-8",
      ),
    ).toBe("reference data");
  });

  it("write_file 只接受 content，不能接受隐藏 fileContent 参数", async () => {
    writeSkill("support", "## Procedure\nUse references.\n");

    const result = await skillManageTool.execute(
      {
        action: "write_file",
        skillId: "support",
        filePath: "references/legacy.md",
        fileContent: "legacy data",
      },
      createContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("content is required");
    expect(
      existsSync(path.join(skillsDir, "support", "references", "legacy.md")),
    ).toBe(false);
  });

  it("rejects supporting file path traversal", async () => {
    writeSkill("support", "## Procedure\nUse references.\n");

    const result = await skillManageTool.execute(
      {
        action: "write_file",
        skillId: "support",
        filePath: "../outside.md",
        content: "bad",
      },
      createContext(),
    );

    expect(result.isError).toBe(true);
    expect(existsSync(path.join(skillsDir, "outside.md"))).toBe(false);
  });

  it("requires confirmation before deleting a skill", async () => {
    writeSkill("delete-me", "## Procedure\nDelete after confirmation.\n");

    const result = await skillManageTool.execute(
      { action: "delete", skillId: "delete-me" },
      createContext(),
    );

    expect(result.isError).toBe(true);
    expect(existsSync(skillFile("delete-me"))).toBe(true);
  });

  it("archives a skill into the configured archive directory", async () => {
    writeSkill("archive-me", "## Procedure\nArchive me.\n");

    const result = await skillManageTool.execute(
      {
        action: "archive",
        skillId: "archive-me",
        reason: "stale skill",
      },
      createContext(),
    );

    expect(result.isError).toBeUndefined();
    expect(existsSync(skillFile("archive-me"))).toBe(false);
    const archived = readFileSync(
      path.join(archiveDir, "archive-me", "SKILL.md"),
      "utf-8",
    );
    expect(archived).toContain("Archive me");
    expect(changes[0]).toMatchObject({
      skillId: "archive-me",
      action: "archive",
      success: true,
      reason: "stale skill",
    });
  });

  it("records successful and failed use_skill attempts", async () => {
    writeSkill("stale", "## Procedure\nUse me.\n");
    const context = createContext();

    const ok = await useSkillTool.execute({ name: "stale" }, context);
    const missing = await useSkillTool.execute({ name: "unknown" }, context);

    expect(ok.isError).toBeUndefined();
    expect(missing.isError).toBe(true);
    expect(usages).toHaveLength(2);
    expect(usages[0]).toMatchObject({ skillId: "stale", success: true });
    expect(usages[1]).toMatchObject({ skillId: "unknown", success: false });
  });

  it("curator dry-run reports stale and structurally weak skills without moving files", async () => {
    writeSkill("stale", "No headings here.\n");
    writeSkill("missing-sections", "Only prose.\n");

    const result = await skillCuratorTool.execute(
      { action: "analyze", staleDays: 30, dryRun: true },
      createContext(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("stale");
    expect(result.content).toContain("missing_sections");
    expect(existsSync(skillFile("stale"))).toBe(true);
  });

  it("curator backup snapshots skills without archiving them", async () => {
    writeSkill("stale", "## Procedure\nBack me up.\n");

    const result = await skillCuratorTool.execute(
      { action: "backup", skillId: "stale" },
      createContext(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("backupPath");
    expect(existsSync(skillFile("stale"))).toBe(true);
    expect(changes[0]).toMatchObject({
      skillId: "stale",
      action: "backup",
      success: true,
    });
  });

  it("skill_curator archive 应在 schema 中声明 reason 参数", () => {
    const properties = skillCuratorTool.parameters.properties as Record<
      string,
      unknown
    >;

    expect(properties.reason).toBeDefined();
  });
});
