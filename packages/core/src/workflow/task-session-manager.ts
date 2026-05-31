import { generateId } from "@agentclaw/providers";
import type {
  ToolExecutionContext,
  WorkflowDefinition,
  AgentEvent,
} from "@agentclaw/types";
import type {
  LLMProvider,
  MemoryStore,
  AgentConfig,
} from "@agentclaw/types";
import { ToolRegistryImpl } from "@agentclaw/tools";
import { SimpleAgentLoop, IterationBudget } from "../agent-loop.js";
import { SimpleContextManager } from "../context-manager.js";
import type { SkillRegistryImpl } from "../skills/registry.js";

export type TaskSessionStatus = "idle" | "running" | "completed" | "failed" | "stopped";

export interface TaskSessionInfo {
  taskId: string;
  sessionId: string;
  conversationId: string;
  status: TaskSessionStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  currentStepId?: string;
}

export interface TaskSessionManagerOptions {
  provider: LLMProvider;
  toolRegistry: ToolRegistryImpl;
  memoryStore: MemoryStore;
  agentConfig?: Partial<AgentConfig>;
  skillRegistry?: SkillRegistryImpl;
  skillsDir?: string;
  systemPrompt?: string;
  onProgress?: (taskId: string, event: AgentEvent) => void;
  onStatusChange?: (taskId: string, status: TaskSessionStatus) => void;
}

interface TaskSessionEntry {
  info: TaskSessionInfo;
  abort: () => void;
}

/**
 * Manages multiple task execution sessions running in parallel.
 * Each task gets its own conversation and agent loop.
 */
export class TaskSessionManager {
  private sessions = new Map<string, TaskSessionEntry>();
  private options: TaskSessionManagerOptions;

  constructor(options: TaskSessionManagerOptions) {
    this.options = options;
  }

  /** Start execution of a task with a given initial prompt */
  async startTask(
    taskId: string,
    taskTitle: string,
    taskDescription: string,
    workflow?: WorkflowDefinition,
    context?: ToolExecutionContext,
  ): Promise<TaskSessionInfo> {
    const existing = this.sessions.get(taskId);
    if (existing && existing.info.status === "running") {
      throw new Error(`Task ${taskId} is already running`);
    }

    const sessionId = generateId();
    const conversationId = generateId();

    let initialPrompt = taskDescription;
    if (workflow) {
      const stepsDesc = workflow.steps
        .map((s) => `- ${s.name} (${s.type})${s.skill ? ` via ${s.skill}` : ""}`)
        .join("\n");
      initialPrompt = `Task: ${taskTitle}\n\n${taskDescription}\n\nWorkflow steps:\n${stepsDesc}\n\nStart with the first step.`;
    }

    const session: import("@agentclaw/types").SessionData = {
      id: sessionId,
      conversationId,
      status: "active",
      createdAt: new Date(),
      lastActiveAt: new Date(),
    };

    this.options.memoryStore.saveSession(session).catch(() => {});

    const maxIterations = this.options.agentConfig?.maxIterations ?? 25;
    const iterationBudget = new IterationBudget(maxIterations);
    const contextManager = new SimpleContextManager({
      memoryStore: this.options.memoryStore,
      provider: this.options.provider,
      skillRegistry: this.options.skillRegistry,
      systemPrompt: this.options.systemPrompt,
    });

    const agentLoop = new SimpleAgentLoop({
      provider: this.options.provider,
      contextManager,
      toolRegistry: this.options.toolRegistry,
      memoryStore: this.options.memoryStore,
      config: {
        ...this.options.agentConfig,
        maxIterations,
      },
      iterationBudget,
    });

    let aborted = false;
    const entry: TaskSessionEntry = {
      info: {
        taskId,
        sessionId,
        conversationId,
        status: "running",
        startedAt: Date.now(),
      },
      abort: () => {
        aborted = true;
        agentLoop.stop();
      },
    };

    this.sessions.set(taskId, entry);
    this.options.onStatusChange?.(taskId, "running");

    this.runLoop(taskId, agentLoop, conversationId, sessionId, initialPrompt, context, () => aborted)
      .catch((err) => {
        const e = this.sessions.get(taskId);
        if (e) {
          e.info.status = "failed";
          e.info.error = err instanceof Error ? err.message : String(err);
          e.info.completedAt = Date.now();
          this.options.onStatusChange?.(taskId, "failed");
        }
      });

    return entry.info;
  }

  getTask(taskId: string): TaskSessionInfo | undefined {
    return this.sessions.get(taskId)?.info;
  }

  listTasks(): TaskSessionInfo[] {
    return Array.from(this.sessions.values()).map((e) => e.info);
  }

  stopTask(taskId: string): boolean {
    const entry = this.sessions.get(taskId);
    if (!entry || entry.info.status !== "running") return false;
    entry.abort();
    entry.info.status = "stopped";
    entry.info.completedAt = Date.now();
    this.options.onStatusChange?.(taskId, "stopped");
    return true;
  }

  private async runLoop(
    taskId: string,
    loop: SimpleAgentLoop,
    conversationId: string,
    sessionId: string,
    initialPrompt: string,
    context?: ToolExecutionContext,
    isAborted?: () => boolean,
  ): Promise<void> {
    const mergedContext: ToolExecutionContext = {
      ...context,
    };

    const eventStream = loop.runStream(initialPrompt, conversationId, mergedContext);

    for await (const event of eventStream) {
      this.options.onProgress?.(taskId, event);
      if (isAborted?.()) {
        loop.stop();
        break;
      }
    }

    const entry = this.sessions.get(taskId);
    if (entry && entry.info.status === "running") {
      entry.info.status = "completed";
      entry.info.completedAt = Date.now();
      this.options.onStatusChange?.(taskId, "completed");
    }
  }
}
