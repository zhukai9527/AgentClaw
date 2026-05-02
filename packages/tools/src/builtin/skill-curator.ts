import { existsSync, readFileSync } from "node:fs";
import type {
  SkillChangeInput,
  SkillUsageStats,
  Tool,
  ToolExecutionContext,
  ToolResult,
} from "@agentclaw/types";
import {
  archiveSkillDirectory,
  backupDirectory,
  fileMtime,
  getArchiveDir,
  getBackupDir,
  getSkillsDir,
  hashText,
  readTextIfExists,
  skillDirFor,
  skillMarkdownPath,
  validateSkillId,
} from "./skill-lifecycle.js";

interface CuratorRecommendation {
  skillId: string;
  type: "stale" | "missing_sections" | "duplicate_description";
  reason: string;
  suggestedAction: "archive" | "patch" | "review";
}

export const skillCuratorTool: Tool = {
  name: "skill_curator",
  description:
    "Analyze skill quality and usage, run dry-run reviews, back up skills, and archive stale skills.",
  category: "builtin",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["analyze", "status", "backup", "archive"],
        description: "Curator action",
      },
      skillId: {
        type: "string",
        description: "Optional target skill id",
      },
      staleDays: {
        type: "number",
        description: "Days without successful usage before a skill is stale",
      },
      dryRun: {
        type: "boolean",
        description: "When true, report changes without mutating files",
      },
      limit: { type: "number", description: "Status row limit" },
    },
    required: ["action"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const action = String(input.action ?? "").trim();
    try {
      if (action === "status") return await status(context, input);
      if (action === "backup") return await backup(context, input);
      if (action === "archive") return await archive(context, input);
      if (action === "analyze") return await analyze(context, input);
      return fail(`Unsupported skill_curator action: ${action}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
};

async function analyze(
  context: ToolExecutionContext | undefined,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const registry = context?.skillRegistry;
  if (!registry) return fail("skill registry not available");

  const staleDays = numberInput(input.staleDays, 90);
  const dryRun = input.dryRun !== false;
  const stats = await context?.listSkillUsageStats?.(500);
  const statsById = new Map((stats ?? []).map((stat) => [stat.skillId, stat]));
  const skills = registry.list().filter((skill) => skill.enabled);
  const recommendations: CuratorRecommendation[] = [];
  const descriptions = new Map<string, string>();

  for (const skill of skills) {
    const loaded = registry.get(skill.id);
    const skillPath = loaded?.path;
    const content =
      loaded?.instructions ??
      (skillPath && existsSync(skillPath)
        ? readFileSync(skillPath, "utf-8")
        : "");

    if (!hasSecondLevelHeading(content)) {
      recommendations.push({
        skillId: skill.id,
        type: "missing_sections",
        reason: "SKILL.md has no second-level markdown sections",
        suggestedAction: "patch",
      });
    }

    const stat = statsById.get(skill.id);
    if (isStale(skill.id, stat, skillPath, staleDays)) {
      recommendations.push({
        skillId: skill.id,
        type: "stale",
        reason: `No successful use within ${staleDays} days`,
        suggestedAction: "archive",
      });
    }

    const normalizedDescription = skill.description.trim().toLowerCase();
    if (normalizedDescription) {
      const previous = descriptions.get(normalizedDescription);
      if (previous) {
        recommendations.push({
          skillId: skill.id,
          type: "duplicate_description",
          reason: `Description duplicates ${previous}`,
          suggestedAction: "review",
        });
      } else {
        descriptions.set(normalizedDescription, skill.id);
      }
    }
  }

  const archived: Array<{ skillId: string; archivePath: string }> = [];
  if (!dryRun) {
    for (const recommendation of recommendations) {
      if (recommendation.type !== "stale") continue;
      const archiveResult = await archiveOne(context, recommendation.skillId, {
        reason: recommendation.reason,
      });
      archived.push(archiveResult);
    }
  }

  await recordChange(context, {
    skillId: "skill_curator",
    skillName: "skill_curator",
    action: "curate",
    success: true,
    reason: dryRun ? "dry-run analyze" : "analyze and apply",
    metadata: { recommendationCount: recommendations.length, archived },
  });

  return ok({
    dryRun,
    staleDays,
    checked: skills.length,
    recommendations,
    archived,
  });
}

async function status(
  context: ToolExecutionContext | undefined,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const limit = numberInput(input.limit, 20);
  const stats = await context?.listSkillUsageStats?.(limit);
  const changes = await context?.listSkillChangeHistory?.({ limit });
  return ok({ stats: stats ?? [], changes: changes ?? [] });
}

async function backup(
  context: ToolExecutionContext | undefined,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const skillId = stringInput(input.skillId);
  if (!skillId) return fail("skillId is required for backup");
  const idError = validateSkillId(skillId);
  if (idError) return fail(idError);

  const skillDir = skillDirFor(getSkillsDir(context), skillId);
  const backupPath = backupDirectory(skillDir, getBackupDir(context), skillId);
  await recordChange(context, {
    skillId,
    action: "backup",
    success: true,
    beforeHash: hashText(readTextIfExists(skillMarkdownPath(skillDir))),
    afterHash: null,
    path: backupPath,
  });
  return ok({ skillId, backupPath });
}

async function archive(
  context: ToolExecutionContext | undefined,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const skillId = stringInput(input.skillId);
  if (!skillId) return fail("skillId is required for archive");
  const idError = validateSkillId(skillId);
  if (idError) return fail(idError);
  const result = await archiveOne(context, skillId, {
    reason: stringInput(input.reason),
  });
  return ok(result);
}

async function archiveOne(
  context: ToolExecutionContext | undefined,
  skillId: string,
  options: { reason?: string },
): Promise<{ skillId: string; archivePath: string; backupPath?: string }> {
  const skillDir = skillDirFor(getSkillsDir(context), skillId);
  const before = readTextIfExists(skillMarkdownPath(skillDir));
  const backupPath = backupDirectory(skillDir, getBackupDir(context), skillId);
  const archivePath = archiveSkillDirectory(
    skillDir,
    getArchiveDir(context),
    skillId,
  );
  await recordChange(context, {
    skillId,
    action: "archive",
    success: true,
    reason: options.reason,
    beforeHash: hashText(before),
    afterHash: null,
    path: archivePath,
    metadata: { backupPath, source: "skill_curator" },
  });
  return { skillId, archivePath, backupPath };
}

function isStale(
  skillId: string,
  stat: SkillUsageStats | undefined,
  skillPath: string | undefined,
  staleDays: number,
): boolean {
  if (skillId === "skill_curator") return false;
  if (stat && stat.successCount > 0) return false;
  const lastActivity =
    stat?.lastUsedAt ?? (skillPath ? fileMtime(skillPath) : undefined);
  if (!lastActivity) return false;
  const ageMs = Date.now() - lastActivity.getTime();
  return ageMs >= staleDays * 86_400_000;
}

function hasSecondLevelHeading(content: string): boolean {
  return /^##\s+\S+/m.test(content);
}

async function recordChange(
  context: ToolExecutionContext | undefined,
  change: SkillChangeInput,
): Promise<void> {
  if (!context?.recordSkillChange) return;
  await context.recordSkillChange({
    ...change,
    agentId: change.agentId ?? context.agentId,
    traceId: change.traceId ?? context.traceId,
    conversationId: change.conversationId ?? context.conversationId,
  });
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
