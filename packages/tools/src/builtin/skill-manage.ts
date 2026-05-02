import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type {
  SkillChangeAction,
  SkillChangeInput,
  Tool,
  ToolExecutionContext,
  ToolResult,
} from "@agentclaw/types";
import {
  archiveSkillDirectory,
  backupDirectory,
  buildSkillMarkdown,
  countOccurrences,
  getArchiveDir,
  getBackupDir,
  getSkillsDir,
  hashText,
  normalizeSkillMarkdownName,
  readTextIfExists,
  resolveSkillTarget,
  skillDirFor,
  skillMarkdownPath,
  validateSkillId,
  validateSkillMarkdown,
  writeTextAtomic,
} from "./skill-lifecycle.js";

type SkillManageAction =
  | "create"
  | "patch"
  | "write_file"
  | "archive"
  | "delete"
  | "backup"
  | "stats"
  | "history";

export const skillManageTool: Tool = {
  name: "skill_manage",
  description:
    "Create, patch, write supporting files, archive, delete, back up, and inspect local skills.",
  category: "builtin",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "create",
          "patch",
          "write_file",
          "archive",
          "delete",
          "backup",
          "stats",
          "history",
        ],
        description: "Lifecycle action to perform",
      },
      skillId: {
        type: "string",
        description: "Filesystem-safe skill id",
      },
      name: { type: "string", description: "Skill display name" },
      description: { type: "string", description: "Skill description" },
      instructions: {
        type: "string",
        description: "Skill body used when content is not supplied",
      },
      content: {
        type: "string",
        description: "Full SKILL.md content or supporting file content",
      },
      filePath: {
        type: "string",
        description: "Relative path inside the skill directory",
      },
      oldString: { type: "string", description: "Text to replace" },
      newString: { type: "string", description: "Replacement text" },
      reason: { type: "string", description: "Why this change is needed" },
      confirm: {
        type: "boolean",
        description: "Required for delete",
      },
      limit: { type: "number", description: "Stats/history row limit" },
    },
    required: ["action"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const action = String(input.action ?? "").trim() as SkillManageAction;
    const skillId = String(input.skillId ?? input.name ?? "").trim();

    try {
      if (action === "stats") {
        const stats = await context?.listSkillUsageStats?.(
          numberInput(input.limit, 100),
        );
        return ok({ stats: stats ?? [] });
      }

      if (action === "history") {
        const history = await context?.listSkillChangeHistory?.({
          skillId: skillId || undefined,
          limit: numberInput(input.limit, 100),
        });
        return ok({ history: history ?? [] });
      }

      const idError = validateSkillId(skillId);
      if (idError) {
        return fail(idError);
      }

      switch (action) {
        case "create":
          return await createSkill(input, context, skillId);
        case "patch":
          return await patchSkill(input, context, skillId);
        case "write_file":
          return await writeSupportingFile(input, context, skillId);
        case "archive":
          return await archiveSkill(input, context, skillId);
        case "delete":
          return await deleteSkill(input, context, skillId);
        case "backup":
          return await backupSkill(input, context, skillId);
        default:
          return fail(`Unsupported skill_manage action: ${action}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (skillId && validateSkillId(skillId) === null) {
        await recordChange(context, {
          skillId,
          action: actionToChangeAction(action),
          success: false,
          error: message,
          reason: stringInput(input.reason),
        });
      }
      return fail(message);
    }
  },
};

async function createSkill(
  input: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
  skillId: string,
): Promise<ToolResult> {
  const skillsDir = getSkillsDir(context);
  const skillDir = skillDirFor(skillsDir, skillId);
  if (existsSync(skillDir)) {
    return fail(`Skill already exists: ${skillId}`);
  }

  const fullContent = buildCreateContent(input, skillId);
  const validationError = validateSkillMarkdown(fullContent);
  if (validationError) return fail(validationError);

  const skillPath = skillMarkdownPath(skillDir);
  writeTextAtomic(skillPath, fullContent);
  const afterHash = hashText(fullContent);
  await recordChange(context, {
    skillId,
    skillName: stringInput(input.name) ?? skillId,
    action: "create",
    success: true,
    reason: stringInput(input.reason),
    beforeHash: null,
    afterHash,
    path: skillPath,
  });

  return ok({ skillId, path: skillPath, afterHash });
}

async function patchSkill(
  input: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
  skillId: string,
): Promise<ToolResult> {
  const skillDir = skillDirFor(getSkillsDir(context), skillId);
  const target = resolveSkillTarget(skillDir, stringInput(input.filePath));
  const before = readTextIfExists(target);
  if (before === null) return fail(`File not found: ${target}`);

  const oldString = stringInput(input.oldString);
  if (!oldString) return fail("oldString is required for patch");
  const newString = String(input.newString ?? "");
  const matchCount = countOccurrences(before, oldString);
  if (matchCount !== 1) {
    await recordChange(context, {
      skillId,
      action: "patch",
      success: false,
      reason: stringInput(input.reason),
      beforeHash: hashText(before),
      afterHash: hashText(before),
      path: target,
      error: `oldString matched ${matchCount} times; expected exactly 1`,
    });
    return fail(`oldString matched ${matchCount} times; expected exactly 1`);
  }

  const after = before.replace(oldString, newString);
  if (path.basename(target) === "SKILL.md") {
    const validationError = validateSkillMarkdown(after);
    if (validationError)
      return fail(`Patch would break SKILL.md: ${validationError}`);
  }

  writeTextAtomic(target, after);
  await recordChange(context, {
    skillId,
    action: "patch",
    success: true,
    reason: stringInput(input.reason),
    beforeHash: hashText(before),
    afterHash: hashText(after),
    path: target,
  });

  return ok({
    skillId,
    path: target,
    replacements: 1,
    beforeHash: hashText(before),
    afterHash: hashText(after),
  });
}

async function writeSupportingFile(
  input: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
  skillId: string,
): Promise<ToolResult> {
  const filePath = stringInput(input.filePath);
  if (!filePath) return fail("filePath is required for write_file");
  const skillDir = skillDirFor(getSkillsDir(context), skillId);
  if (!existsSync(skillDir)) return fail(`Skill not found: ${skillId}`);

  const target = resolveSkillTarget(skillDir, filePath);
  const before = readTextIfExists(target);
  const content = String(input.content ?? input.fileContent ?? "");
  writeTextAtomic(target, content);
  await recordChange(context, {
    skillId,
    action: "write_file",
    success: true,
    reason: stringInput(input.reason),
    beforeHash: hashText(before),
    afterHash: hashText(content),
    path: target,
  });

  return ok({ skillId, path: target, afterHash: hashText(content) });
}

async function archiveSkill(
  input: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
  skillId: string,
): Promise<ToolResult> {
  const skillsDir = getSkillsDir(context);
  const skillDir = skillDirFor(skillsDir, skillId);
  const before = readTextIfExists(skillMarkdownPath(skillDir));
  const backupPath = existsSync(skillDir)
    ? backupDirectory(skillDir, getBackupDir(context), skillId)
    : undefined;
  const archivePath = archiveSkillDirectory(
    skillDir,
    getArchiveDir(context),
    skillId,
  );

  await recordChange(context, {
    skillId,
    action: "archive",
    success: true,
    reason: stringInput(input.reason),
    beforeHash: hashText(before),
    afterHash: null,
    path: archivePath,
    metadata: backupPath ? { backupPath } : undefined,
  });

  return ok({ skillId, archivePath, backupPath });
}

async function deleteSkill(
  input: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
  skillId: string,
): Promise<ToolResult> {
  if (input.confirm !== true) {
    return fail("delete requires confirm=true");
  }

  const skillDir = skillDirFor(getSkillsDir(context), skillId);
  const before = readTextIfExists(skillMarkdownPath(skillDir));
  if (!existsSync(skillDir)) return fail(`Skill not found: ${skillId}`);
  const backupPath = backupDirectory(skillDir, getBackupDir(context), skillId);
  rmSync(skillDir, { recursive: true, force: true });

  await recordChange(context, {
    skillId,
    action: "delete",
    success: true,
    reason: stringInput(input.reason),
    beforeHash: hashText(before),
    afterHash: null,
    path: skillDir,
    metadata: { backupPath },
  });

  return ok({ skillId, deleted: true, backupPath });
}

async function backupSkill(
  input: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
  skillId: string,
): Promise<ToolResult> {
  const skillDir = skillDirFor(getSkillsDir(context), skillId);
  const backupPath = backupDirectory(skillDir, getBackupDir(context), skillId);
  await recordChange(context, {
    skillId,
    action: "backup",
    success: true,
    reason: stringInput(input.reason),
    beforeHash: hashText(readTextIfExists(skillMarkdownPath(skillDir))),
    afterHash: null,
    path: backupPath,
  });
  return ok({ skillId, backupPath });
}

function buildCreateContent(
  input: Record<string, unknown>,
  skillId: string,
): string {
  const content = stringInput(input.content);
  if (content) return normalizeSkillMarkdownName(content, skillId);
  const description = stringInput(input.description);
  if (!description) throw new Error("description is required for create");
  const instructions = stringInput(input.instructions);
  if (!instructions) throw new Error("instructions is required for create");
  return buildSkillMarkdown({ name: skillId, description, instructions });
}

async function recordChange(
  context: ToolExecutionContext | undefined,
  change: SkillChangeInput,
): Promise<void> {
  if (!context?.recordSkillChange) return;
  await context.recordSkillChange({
    ...change,
    agentId: change.agentId ?? context.agentId,
  });
}

function actionToChangeAction(action: string): SkillChangeAction {
  if (
    action === "create" ||
    action === "patch" ||
    action === "write_file" ||
    action === "archive" ||
    action === "delete" ||
    action === "backup" ||
    action === "curate"
  ) {
    return action;
  }
  return "curate";
}

function stringInput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function numberInput(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function ok(data: Record<string, unknown>): ToolResult {
  return {
    content: JSON.stringify(data, null, 2),
    metadata: data,
  };
}

function fail(message: string): ToolResult {
  return {
    content: `Error: ${message}`,
    isError: true,
  };
}
