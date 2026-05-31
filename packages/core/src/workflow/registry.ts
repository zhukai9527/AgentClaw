import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkflowDefinition, WorkflowRegistry } from "@agentclaw/types";

export class WorkflowRegistryImpl implements WorkflowRegistry {
  private workflows: Map<string, WorkflowDefinition> = new Map();

  async scanDirectory(dirPath: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      const filePath = path.join(dirPath, entry);
      try {
        const content = await readFile(filePath, "utf-8");
        const doc = parseYaml(content) as WorkflowDefinition;
        if (doc && doc.name && Array.isArray(doc.steps)) {
          this.register(doc);
        }
      } catch {
        // skip invalid files
      }
    }
  }

  register(def: WorkflowDefinition): void {
    this.workflows.set(def.name, def);
  }

  get(name: string): WorkflowDefinition | undefined {
    return this.workflows.get(name);
  }

  list(): WorkflowDefinition[] {
    return Array.from(this.workflows.values());
  }
}
