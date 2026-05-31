import type { TaskProvider, TaskProviderRegistry } from "@agentclaw/types";

export class DefaultTaskProviderRegistry implements TaskProviderRegistry {
  private providers: Map<string, TaskProvider> = new Map();

  register(provider: TaskProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): TaskProvider | undefined {
    return this.providers.get(name);
  }

  list(): TaskProvider[] {
    return Array.from(this.providers.values());
  }
}
