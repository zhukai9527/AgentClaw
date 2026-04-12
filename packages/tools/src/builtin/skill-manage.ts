import { readFile, writeFile, copyFile } from "node:fs/promises";
import type { Tool, ToolResult, ToolExecutionContext } from "@agentclaw/types";

export const skillManageTool: Tool = {
  name: "skill_manage",
  description:
    "Patch an existing skill's instructions when you discover errors or better approaches. " +
    "Use this to fix incorrect commands, add missing steps, or update outdated information in a skill. " +
    "The skill file reloads automatically after patching.",
  category: "builtin",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["patch", "view", "rollback"],
        description:
          "patch: apply a find/replace fix (creates .bak backup); view: show current content; rollback: restore from .bak backup",
      },
      name: {
        type: "string",
        description: "The skill name (from Available Skills list)",
      },
      find: {
        type: "string",
        description: "(patch only) Exact text to find in the skill file",
      },
      replace: {
        type: "string",
        description: "(patch only) Replacement text",
      },
    },
    required: ["action", "name"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const action = String(input.action ?? "")
      .trim()
      .replace(/^["']|["']$/g, "");
    const name = String(input.name ?? "")
      .trim()
      .replace(/^["']|["']$/g, "");

    if (!name) {
      return { content: "Error: skill name is required", isError: true };
    }

    const registry = context?.skillRegistry;
    if (!registry) {
      return { content: "Error: skill registry not available", isError: true };
    }

    const skill = registry.get(name);
    if (!skill) {
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

    const skillPath = skill.path;
    if (!skillPath) {
      return {
        content: `Skill "${name}" has no file path — cannot ${action}.`,
        isError: true,
      };
    }

    if (action === "view") {
      return {
        content: `## ${skill.name} (${skillPath})\n\n${skill.instructions}`,
        isError: false,
      };
    }

    if (action === "patch") {
      const find = input.find as string | undefined;
      const replace = input.replace as string | undefined;

      if (!find) {
        return {
          content: 'Error: "find" parameter is required for patch action',
          isError: true,
        };
      }
      if (replace === undefined || replace === null) {
        return {
          content: 'Error: "replace" parameter is required for patch action',
          isError: true,
        };
      }

      try {
        const content = await readFile(skillPath, "utf-8");

        if (!content.includes(find)) {
          return {
            content: `Error: text not found in ${skillPath}:\n"${find.slice(0, 200)}"`,
            isError: true,
          };
        }

        // Safety: create .bak backup before patching
        const backupPath = skillPath + ".bak";
        await copyFile(skillPath, backupPath);

        const occurrences = content.split(find).length - 1;
        const updated = content.replace(find, replace);
        await writeFile(skillPath, updated, "utf-8");

        // fs.watch will auto-reload the skill; no manual registry update needed
        return {
          content:
            `Patched ${skill.name}: replaced ${occurrences} occurrence(s) in ${skillPath}\n` +
            `- Old: ${find.slice(0, 150)}\n` +
            `+ New: ${replace.slice(0, 150)}\n` +
            `Backup: ${backupPath} (restore with skill_manage action="rollback" if the patch causes issues)`,
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Failed to patch skill: ${message}`,
          isError: true,
        };
      }
    }

    if (action === "rollback") {
      const backupPath = skillPath + ".bak";
      try {
        await copyFile(backupPath, skillPath);
        return {
          content: `Rolled back ${skill.name} from ${backupPath}. Skill restored to pre-patch state.`,
          isError: false,
        };
      } catch {
        return {
          content: `No backup found at ${backupPath}. Nothing to rollback.`,
          isError: true,
        };
      }
    }

    return {
      content: `Unknown action: ${action}. Use "patch", "view", or "rollback".`,
      isError: true,
    };
  },
};
