import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ToolExecutionContext } from "@agentclaw/types";

const VALID_SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function validateSkillId(skillId: string): string | null {
  if (!skillId) return "skillId is required";
  if (!VALID_SKILL_ID_RE.test(skillId)) {
    return (
      "skillId must use lowercase letters, numbers, hyphens, underscores, " +
      "or dots, and must start with a letter or number"
    );
  }
  return null;
}

export function getSkillsDir(context?: ToolExecutionContext): string {
  return path.resolve(context?.skillsDir ?? path.join(process.cwd(), "skills"));
}

export function getArchiveDir(context?: ToolExecutionContext): string {
  return path.resolve(
    context?.skillArchiveDir ??
      path.join(process.cwd(), "data", "skills-archive"),
  );
}

export function getBackupDir(context?: ToolExecutionContext): string {
  return path.resolve(
    context?.skillBackupDir ??
      path.join(process.cwd(), "data", "skills-backup"),
  );
}

export function skillDirFor(skillsDir: string, skillId: string): string {
  const target = path.resolve(skillsDir, skillId);
  assertInside(skillsDir, target);
  return target;
}

export function skillMarkdownPath(skillDir: string): string {
  return path.join(skillDir, "SKILL.md");
}

function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return;
  throw new Error(`Path escapes allowed root: ${resolvedTarget}`);
}

export function resolveSkillTarget(
  skillDir: string,
  filePath?: string,
): string {
  if (!filePath) return skillMarkdownPath(skillDir);
  const trimmed = filePath.trim();
  if (!trimmed) throw new Error("filePath cannot be empty");
  if (path.isAbsolute(trimmed)) throw new Error("filePath must be relative");
  const target = path.resolve(skillDir, trimmed);
  assertInside(skillDir, target);
  return target;
}

export function readTextIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

export function hashText(content: string | null): string | null {
  if (content === null) return null;
  return createHash("sha256").update(content).digest("hex");
}

export function buildSkillMarkdown(input: {
  name: string;
  description: string;
  instructions: string;
}): string {
  return [
    "---",
    `name: ${input.name}`,
    `description: ${input.description}`,
    "---",
    input.instructions.trim(),
    "",
  ].join("\n");
}

export function normalizeSkillMarkdownName(
  content: string,
  skillId: string,
): string {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return content;
  const frontmatter = match[1];
  const body = match[2];
  const normalizedFrontmatter = /^name:\s*.*$/m.test(frontmatter)
    ? frontmatter.replace(/^name:\s*.*$/m, `name: ${skillId}`)
    : `name: ${skillId}\n${frontmatter}`;
  return `---\n${normalizedFrontmatter}\n---\n${body}`;
}

export function validateSkillMarkdown(content: string): string | null {
  if (!content.trim()) return "SKILL.md content cannot be empty";
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return "SKILL.md must start with YAML frontmatter";
  const frontmatter = match[1];
  const body = match[2].trim();
  if (!/^name:\s*\S+/m.test(frontmatter)) {
    return "SKILL.md frontmatter must include name";
  }
  if (!/^description:\s*\S+/m.test(frontmatter)) {
    return "SKILL.md frontmatter must include description";
  }
  if (!body) return "SKILL.md must include instructions after frontmatter";
  return null;
}

export function writeTextAtomic(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

export function backupDirectory(
  sourceDir: string,
  backupRoot: string,
  label: string,
): string {
  if (!existsSync(sourceDir)) {
    throw new Error(`Directory not found: ${sourceDir}`);
  }
  const backupPath = path.join(backupRoot, `${safeTimestamp()}-${label}`);
  mkdirSync(path.dirname(backupPath), { recursive: true });
  cpSync(sourceDir, backupPath, { recursive: true });
  return backupPath;
}

export function archiveSkillDirectory(
  skillDir: string,
  archiveRoot: string,
  skillId: string,
): string {
  if (!existsSync(skillDir)) {
    throw new Error(`Skill not found: ${skillId}`);
  }
  mkdirSync(archiveRoot, { recursive: true });
  let dest = path.join(archiveRoot, skillId);
  if (existsSync(dest)) {
    dest = path.join(archiveRoot, `${skillId}-${safeTimestamp()}`);
  }
  try {
    renameSync(skillDir, dest);
  } catch {
    cpSync(skillDir, dest, { recursive: true });
    rmSync(skillDir, { recursive: true, force: true });
  }
  return dest;
}

export function fileMtime(filePath: string): Date | undefined {
  if (!existsSync(filePath)) return undefined;
  return statSync(filePath).mtime;
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
