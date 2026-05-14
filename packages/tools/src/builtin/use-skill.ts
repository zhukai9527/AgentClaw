import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import type { Tool, ToolResult, ToolExecutionContext } from "@agentclaw/types";
import { shellInfo } from "./shell.js";

/**
 * Whitelist check: only allow simple package install commands.
 * Rejects commands with pipes, chains, subshells, redirects, etc.
 */
function isAllowedInstallCommand(cmd: string): boolean {
  if (!/^\s*(pip|pip3|npm)\s+install\b/.test(cmd)) return false;
  if (/[|;&`$()]|>>?|<</.test(cmd)) return false;
  if (/--index-url|--extra-index-url|-i\s/.test(cmd)) return false;
  return true;
}

/**
 * Extract install commands from skill instructions (Step 0 JSON code blocks).
 * Security: only allows simple `pip install <packages>` or `npm install <packages>`.
 */
function extractInstallCommands(
  instructions: string,
): Array<{ command: string; timeout: number }> {
  const results: Array<{ command: string; timeout: number }> = [];
  const jsonBlockRe = /```json\s*\n\s*(\{[^}]+\})\s*\n\s*```/g;
  let match: RegExpExecArray | null;
  while ((match = jsonBlockRe.exec(instructions)) !== null) {
    try {
      const obj = JSON.parse(match[1]) as Record<string, unknown>;
      const cmd = String(obj.command ?? "").trim();
      if (!isAllowedInstallCommand(cmd)) continue;
      results.push({
        command: cmd,
        timeout: Number(obj.timeout) || 120_000,
      });
    } catch {
      // not valid JSON, skip
    }
  }
  return results;
}

/** Run a shell command and return stdout/stderr. */
function runCommand(
  command: string,
  timeout: number,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      shellInfo.shell,
      ["-c", command],
      {
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      },
      (error, stdout, stderr) => {
        const output = [String(stdout || ""), String(stderr || "")]
          .filter(Boolean)
          .join("\n")
          .trim();
        resolve({ ok: !error, output: output.slice(0, 500) });
      },
    );
  });
}

function toInstructionPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export const useSkillTool: Tool = {
  name: "use_skill",
  description:
    "Load a skill's detailed instructions by name. Call this BEFORE executing a skill-related task so you know the exact commands and rules.",
  category: "builtin",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The skill name from the Available Skills list",
      },
    },
    required: ["name"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const name = String(input.name ?? "").trim();
    if (!name) {
      return { content: "Error: skill name is required", isError: true };
    }

    const registry = context?.skillRegistry;
    if (!registry) {
      await recordSkillUsage(
        context,
        name,
        false,
        "skill registry not available",
      );
      return { content: "Error: skill registry not available", isError: true };
    }

    // Check per-agent skill blacklist
    if (context?.disabledSkills?.includes(name)) {
      await recordSkillUsage(context, name, false, "skill disabled");
      return {
        content: `Skill "${name}" is disabled for this agent.`,
        isError: true,
      };
    }

    const skill = registry.get(name);
    if (!skill) {
      await recordSkillUsage(context, name, false, "skill not found");
      const available = registry
        .list()
        .filter((s) => s.enabled)
        .map((s) => s.name)
        .join(", ");
      return {
        content: `Skill "${name}" not found. Available: ${available}`,
        isError: true,
      };
    }

    // Auto-execute install steps (Step 0) so dependencies are ready
    const installCmds = extractInstallCommands(skill.instructions);
    const installResults: string[] = [];
    for (const cmd of installCmds) {
      const { ok, output } = await runCommand(cmd.command, cmd.timeout);
      installResults.push(
        ok ? `✅ ${cmd.command} — installed` : `⚠️ ${cmd.command} — ${output}`,
      );
    }

    const prefix =
      "⚠️ IMPORTANT: Follow these instructions exactly. Use ONLY the libraries and methods shown below. Do NOT use alternative libraries.\n\n";
    const installStatus =
      installResults.length > 0
        ? `Dependencies:\n${installResults.join("\n")}\n\n`
        : "";

    let instructions = skill.instructions;
    const skillsDir = resolve(context?.skillsDir ?? "skills");
    const repoRoot = process.cwd();
    const verifierPath = join(
      skillsDir,
      "pptx",
      "scripts",
      "verify_pptx.py",
    );
    instructions = instructions
      .replaceAll("{REPO_ROOT}", toInstructionPath(repoRoot))
      .replaceAll("{SKILLS_DIR}", toInstructionPath(skillsDir))
      .replaceAll("{VERIFY_PPTX}", toInstructionPath(verifierPath));
    // Replace {WORKDIR} placeholder with actual per-trace working directory
    if (context?.workDir) {
      instructions = instructions.replaceAll("{WORKDIR}", context.workDir);
    }

    await recordSkillUsage(
      context,
      skill.id ?? name,
      true,
      undefined,
      skill.name,
    );

    return { content: prefix + installStatus + instructions };
  },
};

async function recordSkillUsage(
  context: ToolExecutionContext | undefined,
  skillId: string,
  success: boolean,
  error?: string,
  skillName?: string,
): Promise<void> {
  if (!context?.recordSkillUsage) return;
  await context.recordSkillUsage({
    skillId,
    skillName,
    success,
    error,
    agentId: context.agentId,
    metadata: { source: "use_skill" },
  });
}
