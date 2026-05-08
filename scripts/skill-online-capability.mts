import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SimpleOrchestrator,
  SkillRegistryImpl,
} from "../packages/core/src/index.js";
import {
  initDatabase,
  SQLiteMemoryStore,
} from "../packages/memory/src/index.js";
import {
  ClaudeProvider,
  GeminiProvider,
  OpenAICompatibleProvider,
} from "../packages/providers/src/index.js";
import {
  createBuiltinTools,
  ToolRegistryImpl,
} from "../packages/tools/src/index.js";
import type {
  AgentEvent,
  LLMProvider,
  Message,
} from "../packages/types/src/index.js";

type ProviderConfig = {
  id: string;
  type?: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
};

type AppConfig = {
  activeProvider?: string;
  disableThinking?: boolean;
  providers?: ProviderConfig[];
};

type ToolCallRecord = {
  name: string;
  input: Record<string, unknown>;
};

type ToolResultRecord = {
  name: string;
  isError: boolean;
  content: string;
};

type AgentRun = {
  response: string;
  traceId?: string;
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
};

type CaseResult = {
  name: string;
  pass: boolean;
  score?: number;
  notes: string[];
  metrics?: Record<string, unknown>;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const targetTools = new Set(["use_skill", "skill_manage", "skill_curator"]);
const results: CaseResult[] = [];

function loadConfig(): AppConfig {
  const configPath = path.join(repoRoot, "data", "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`缺少配置文件: ${configPath}`);
  }
  return JSON.parse(readFileSync(configPath, "utf-8")) as AppConfig;
}

function selectProviderConfig(config: AppConfig): ProviderConfig {
  const providers = config.providers?.filter((item) => item.apiKey) ?? [];
  if (providers.length === 0) {
    throw new Error("没有可用的线上 provider 配置");
  }
  const active = providers.find(
    (item) => item.id === config.activeProvider && item.enabled,
  );
  return active ?? providers.find((item) => item.enabled) ?? providers[0];
}

function createProvider(
  config: AppConfig,
  providerConfig: ProviderConfig,
): LLMProvider {
  if (providerConfig.type === "claude") {
    return new ClaudeProvider({
      apiKey: providerConfig.apiKey,
      defaultModel: providerConfig.model,
    });
  }
  if (providerConfig.type === "gemini") {
    return new GeminiProvider({
      apiKey: providerConfig.apiKey,
      defaultModel: providerConfig.model,
    });
  }
  return new OpenAICompatibleProvider({
    apiKey: providerConfig.apiKey,
    baseURL: providerConfig.baseUrl,
    defaultModel: providerConfig.model,
    providerName: providerConfig.id,
    extraBody: config.disableThinking ? { think: false } : undefined,
  });
}

function extractText(content: Message["content"] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      return "";
    })
    .join("");
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toolResultJson(
  result: ToolResultRecord,
): Record<string, unknown> | undefined {
  return parseJsonObject(result.content);
}

function skillPath(skillsDir: string, id: string): string {
  return path.join(skillsDir, id, "SKILL.md");
}

function readSkill(skillsDir: string, id: string): string {
  return readFileSync(skillPath(skillsDir, id), "utf-8");
}

function fileHash(filePath: string): string {
  if (!existsSync(filePath)) return "missing";
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function scoreSkill(content: string): number {
  const checks: Array<[RegExp, number]> = [
    [/^## Procedure\b/m, 1],
    [/^## Rubric\b/m, 1],
    [/^## Output\b/m, 1],
    [/^## Verification\b/m, 1],
    [/P0|优先级|priority/i, 1],
    [/P1|backlog|后续/i, 1],
    [/证据|evidence|source/i, 1],
    [/能力|capability/i, 1],
    [/渠道|channel/i, 1],
    [/不要|忽略|exclude|不列/i, 1],
  ];
  return checks.reduce(
    (sum, [pattern, weight]) => sum + (pattern.test(content) ? weight : 0),
    0,
  );
}

function scoreEvolution(content: string): number {
  const checks = [
    /^## Failure Modes\b/m,
    /^## Regression Checks\b/m,
    /反例|counter/i,
    /验证清单|checklist|回归/i,
    /不能改坏|不改坏|regression/i,
  ];
  return (
    scoreSkill(content) +
    checks.filter((pattern) => pattern.test(content)).length
  );
}

function scoreGapReview(text: string): number {
  const checks = [
    /一致|已有|相同/,
    /欠缺|缺口|不足/,
    /P0/,
    /P1/,
    /验证|测试|回归/,
    /能力|capability/i,
    /证据|理由|因为/,
    /渠道|channel/i,
  ];
  let score = checks.filter((pattern) => pattern.test(text)).length;
  if (/QQ|Telegram/i.test(text)) score -= 2;
  return score;
}

function hasToolCall(
  run: AgentRun,
  name: string,
  action?: string,
  skillId?: string,
): boolean {
  return run.toolCalls.some((call) => {
    if (call.name !== name) return false;
    if (action && call.input.action !== action) return false;
    if (skillId && call.input.skillId !== skillId) return false;
    return true;
  });
}

function hasToolError(run: AgentRun): boolean {
  return run.toolResults.some((result) => result.isError);
}

function record(
  name: string,
  pass: boolean,
  notes: string[],
  metrics?: Record<string, unknown>,
  score?: number,
): void {
  results.push({ name, pass, notes, metrics, score });
  const status = pass ? "PASS" : "FAIL";
  console.log(
    `[${status}] ${name}${score === undefined ? "" : ` score=${score}`}`,
  );
  for (const note of notes) console.log(`  - ${note}`);
}

function createManualSkill(
  skillsDir: string,
  id: string,
  description: string,
  body: string,
): void {
  const dir = path.join(skillsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n${body.trim()}\n`,
    "utf-8",
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const providerConfig = selectProviderConfig(config);
  const provider = createProvider(config, providerConfig);
  const root = await mkdtemp(path.join(tmpdir(), "agentclaw-online-skill-"));
  const skillsDir = path.join(root, "skills");
  const archiveDir = path.join(root, "archive");
  const backupDir = path.join(root, "backup");
  const dbPath = path.join(root, "memory.sqlite");
  mkdirSync(skillsDir, { recursive: true });

  createManualSkill(
    skillsDir,
    "online-control-skill",
    "control skill that must never be changed during online regression",
    `
## Procedure
- Keep this file unchanged.

## Verification
- Its hash must stay identical after every online case.
`,
  );
  const controlPath = skillPath(skillsDir, "online-control-skill");
  const controlHashBefore = fileHash(controlPath);

  const db = initDatabase(dbPath);
  const memoryStore = new SQLiteMemoryStore(db);
  const skillRegistry = new SkillRegistryImpl();
  await skillRegistry.loadFromDirectory(skillsDir);

  const toolRegistry = new ToolRegistryImpl();
  for (const tool of createBuiltinTools({ skills: true })) {
    if (targetTools.has(tool.name)) toolRegistry.register(tool);
  }

  const orchestrator = new SimpleOrchestrator({
    provider,
    toolRegistry,
    memoryStore,
    skillRegistry,
    skillsDir,
    skillArchiveDir: archiveDir,
    skillBackupDir: backupDir,
    enableBackgroundLearning: false,
    agentConfig: {
      maxIterations: 8,
      streaming: true,
      systemPrompt: "",
      model: providerConfig.model,
      temperature: 0.1,
      maxTokens: 4096,
    },
    systemPrompt: [
      "你是 AgentClaw 线上能力回归测试执行器。",
      "每个用户任务都必须通过可用工具完成，不能用口头声明替代工具调用。",
      "只允许操作 skillId 以 online- 开头的测试 skill。",
      "除用户明确要求的目标 skill 外，不要修改其它 skill。",
      "最终回答用简短中文说明已经调用了哪些工具，以及结果。",
    ].join("\n"),
  });

  async function reloadSkills(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await skillRegistry.loadFromDirectory(skillsDir);
  }

  async function runAgent(prompt: string): Promise<AgentRun> {
    const session = await orchestrator.createSession({
      agentId: "online-skill-regression",
      channel: "online-skill-regression",
    });
    const events: AgentEvent[] = [];
    for await (const event of orchestrator.processInputStream(
      session.id,
      prompt,
      {
        agentId: "online-skill-regression",
        channel: "online-skill-regression",
      },
    )) {
      events.push(event);
    }
    const complete = events.find((event) => event.type === "response_complete");
    const message = (complete?.data as { message?: Message } | undefined)
      ?.message;
    const traces = await memoryStore.getTraces(
      1,
      0,
      undefined,
      session.conversationId,
    );
    return {
      response: extractText(message?.content),
      traceId: traces.items[0]?.id,
      toolCalls: events
        .filter((event) => event.type === "tool_call")
        .map((event) => {
          const data = event.data as {
            name?: string;
            input?: Record<string, unknown>;
          };
          return { name: data.name ?? "unknown", input: data.input ?? {} };
        }),
      toolResults: events
        .filter((event) => event.type === "tool_result")
        .map((event) => {
          const data = event.data as {
            name?: string;
            result?: { isError?: boolean; content?: string };
          };
          return {
            name: data.name ?? "unknown",
            isError: data.result?.isError ?? false,
            content: data.result?.content ?? "",
          };
        }),
      tokensIn: message?.tokensIn,
      tokensOut: message?.tokensOut,
      durationMs: message?.durationMs,
    };
  }

  console.log(
    JSON.stringify(
      {
        provider: providerConfig.id,
        model: providerConfig.model,
        root,
        tools: toolRegistry.list().map((tool) => tool.name),
      },
      null,
      2,
    ),
  );

  const createRun = await runAgent(`
请调用 skill_manage 创建 skillId 为 online-gap-review 的 skill。
目标：把“研究外部 agent 项目，列出 AgentClaw 一致能力、欠缺能力、P0/P1 建议，忽略 QQ/Telegram 等渠道差异”沉淀为可复用 skill。
要求：
- 必须是有效 SKILL.md。
- 如果使用 content 参数，content 第一行必须是 ---，并包含 name 与 description frontmatter。
- 必须包含二级标题 ## Procedure、## Rubric、## Output、## Verification。
- Rubric 要明确按能力评分，不把渠道接入列为差距。
- Output 要包含“一致能力 / 欠缺能力 / P0 / P1 / 验证办法”。
完成后简短说明。
`);
  await reloadSkills();
  const createdPath = skillPath(skillsDir, "online-gap-review");
  const createScore = existsSync(createdPath)
    ? scoreSkill(readSkill(skillsDir, "online-gap-review"))
    : 0;
  const createHistory = await memoryStore.listSkillChangeHistory({
    skillId: "online-gap-review",
    limit: 10,
  });
  const createEvolutionRuns = await memoryStore.listEvolutionRuns({
    targetType: "skill",
    targetId: "online-gap-review",
  });
  record(
    "线上创建 gap-review skill",
    hasToolCall(createRun, "skill_manage", "create", "online-gap-review") &&
      existsSync(createdPath) &&
      createScore >= 8 &&
      !hasToolError(createRun) &&
      createHistory.some((item) => item.action === "create" && item.success) &&
      createEvolutionRuns.some(
        (item) => item.status === "applied" && item.result === "unknown",
      ),
    [
      `skill_manage/create: ${hasToolCall(createRun, "skill_manage", "create", "online-gap-review")}`,
      `文件存在: ${existsSync(createdPath)}`,
      `变更记录: ${createHistory.length}`,
      `evolution run: ${createEvolutionRuns.length}`,
      `工具错误: ${hasToolError(createRun)}`,
    ],
    {
      traceId: createRun.traceId,
      toolCalls: createRun.toolCalls,
      tokensIn: createRun.tokensIn,
      tokensOut: createRun.tokensOut,
    },
    createScore,
  );

  const useRun = await runAgent(`
请先调用 use_skill 加载 online-gap-review，然后按这个 skill 分析下面的迷你项目对比。不要列 QQ、Telegram 等渠道差异。
请输出精简但完整的报告：保留“一致能力 / 欠缺能力 / P0 / P1 / 验证办法”五个部分，每部分最多 3 条，避免长篇解释。

迷你对比：
- Hermes: 有 skill lifecycle、usage telemetry、curator/dry-run、可归档备份。
- AgentClaw: 已有 use_skill、技能目录加载、工具执行框架、SQLite memory、gateway API。
- 目标: 找能力一致处、能力缺口、P0/P1 落地建议，并给出线上回归测试办法。
`);
  const useStats = await memoryStore.listSkillUsageStats(20);
  const gapScore = scoreGapReview(useRun.response);
  record(
    "线上使用 skill 产出能力差距报告",
    hasToolCall(useRun, "use_skill", undefined, "online-gap-review") &&
      gapScore >= 6 &&
      !hasToolError(useRun) &&
      useStats.some(
        (item) =>
          item.skillId === "online-gap-review" && item.successCount >= 1,
      ),
    [
      `use_skill: ${hasToolCall(useRun, "use_skill", undefined, "online-gap-review")}`,
      `输出长度: ${useRun.response.length}`,
      `usage telemetry: ${useStats.find((item) => item.skillId === "online-gap-review")?.successCount ?? 0}`,
      `工具错误: ${hasToolError(useRun)}`,
    ],
    {
      traceId: useRun.traceId,
      toolCalls: useRun.toolCalls,
      tokensIn: useRun.tokensIn,
      tokensOut: useRun.tokensOut,
    },
    gapScore,
  );

  const beforePatch = readSkill(skillsDir, "online-gap-review");
  const beforePatchHash = fileHash(createdPath);
  const beforeEvolutionScore = scoreEvolution(beforePatch);
  const patchRun = await runAgent(`
上一次 online-gap-review 的输出还缺少“失败模式”和“回归检查”。
请先调用 use_skill 查看 online-gap-review，再调用 skill_manage 的 patch 动作，只修改 online-gap-review。
要求新增：
- ## Failure Modes：列出会导致误判能力差距的反例。
- ## Regression Checks：列出怎么确认改进后没有改坏旧能力。
不要修改 online-control-skill。
`);
  await reloadSkills();
  const afterPatch = readSkill(skillsDir, "online-gap-review");
  const afterPatchHash = fileHash(createdPath);
  const afterEvolutionScore = scoreEvolution(afterPatch);
  const controlHashAfterPatch = fileHash(controlPath);
  const patchHistory = await memoryStore.listSkillChangeHistory({
    skillId: "online-gap-review",
    limit: 20,
  });
  const patchChange = patchHistory.find(
    (item) =>
      item.action === "patch" &&
      item.success &&
      item.beforeHash === beforePatchHash &&
      item.afterHash === afterPatchHash,
  );
  if (patchChange?.evolutionRunId) {
    await memoryStore.recordEvolutionEvent({
      runId: patchChange.evolutionRunId,
      eventType: "baseline_eval",
      message: "线上反馈 patch 前评分",
      traceId: patchRun.traceId ?? patchChange.traceId,
      scoreBefore: beforeEvolutionScore,
      success: true,
      data: { hash: beforePatchHash },
    });
    await memoryStore.recordEvolutionEvent({
      runId: patchChange.evolutionRunId,
      eventType: "online_regression",
      message: "线上反馈 patch 提升质量且未修改 control skill",
      traceId: patchRun.traceId ?? patchChange.traceId,
      scoreBefore: beforeEvolutionScore,
      scoreAfter: afterEvolutionScore,
      success:
        afterEvolutionScore > beforeEvolutionScore &&
        controlHashAfterPatch === controlHashBefore,
      data: {
        targetHashChanged: beforePatchHash !== afterPatchHash,
        controlHashUnchanged: controlHashAfterPatch === controlHashBefore,
      },
    });
    await memoryStore.updateEvolutionRun(patchChange.evolutionRunId, {
      status: "verified",
      result:
        afterEvolutionScore > beforeEvolutionScore ? "improved" : "neutral",
      baselineScore: beforeEvolutionScore,
      afterScore: afterEvolutionScore,
      regressionCount: controlHashAfterPatch === controlHashBefore ? 0 : 1,
      evalReportPath: path.join(root, "report.json"),
      completedAt: new Date(),
    });
  }
  const verifiedPatchRun = patchChange?.evolutionRunId
    ? (await memoryStore.listEvolutionRuns({
        targetType: "skill",
        targetId: "online-gap-review",
      })).find((item) => item.id === patchChange.evolutionRunId)
    : undefined;
  const verifiedPatchEvents = patchChange?.evolutionRunId
    ? await memoryStore.listEvolutionEvents({
        runId: patchChange.evolutionRunId,
      })
    : [];
  record(
    "线上根据反馈进化 skill 且不改坏旁路 skill",
    hasToolCall(patchRun, "skill_manage", "patch", "online-gap-review") &&
      beforePatchHash !== afterPatchHash &&
      afterEvolutionScore > beforeEvolutionScore &&
      controlHashAfterPatch === controlHashBefore &&
      !hasToolError(patchRun) &&
      verifiedPatchRun?.status === "verified" &&
      verifiedPatchRun.result === "improved" &&
      verifiedPatchEvents.some(
        (event) => event.eventType === "online_regression" && event.success,
      ),
    [
      `skill_manage/patch: ${hasToolCall(patchRun, "skill_manage", "patch", "online-gap-review")}`,
      `目标 hash 改变: ${beforePatchHash !== afterPatchHash}`,
      `能力分提升: ${beforeEvolutionScore} -> ${afterEvolutionScore}`,
      `control 未变化: ${controlHashAfterPatch === controlHashBefore}`,
      `evolution verified: ${verifiedPatchRun?.status === "verified"}`,
      `工具错误: ${hasToolError(patchRun)}`,
    ],
    {
      traceId: patchRun.traceId,
      toolCalls: patchRun.toolCalls,
      tokensIn: patchRun.tokensIn,
      tokensOut: patchRun.tokensOut,
    },
    afterEvolutionScore,
  );

  createManualSkill(
    skillsDir,
    "online-stale-skill",
    "temporary stale skill used by online regression",
    "弱技能，没有二级标题，也没有真实流程。",
  );
  const stalePath = skillPath(skillsDir, "online-stale-skill");
  const oldTime = new Date(Date.now() - 10 * 86_400_000);
  utimesSync(stalePath, oldTime, oldTime);
  await reloadSkills();

  const dryRun = await runAgent(`
请调用 skill_curator analyze，对当前测试 skills 做 dryRun=true 分析，staleDays=1。
只做 dry-run，不要归档、不要删除。
`);
  const staleStillExistsAfterDryRun = existsSync(stalePath);
  const dryRunRecommendation = dryRun.toolResults
    .map(toolResultJson)
    .some(
      (json) =>
        Array.isArray(json?.recommendations) &&
        json.recommendations.some(
          (item) =>
            item &&
            typeof item === "object" &&
            (item as { skillId?: string }).skillId === "online-stale-skill",
        ),
    );
  record(
    "线上 curator dry-run 只发现问题不改文件",
    hasToolCall(dryRun, "skill_curator", "analyze") &&
      dryRunRecommendation &&
      staleStillExistsAfterDryRun &&
      !hasToolError(dryRun),
    [
      `skill_curator/analyze: ${hasToolCall(dryRun, "skill_curator", "analyze")}`,
      `发现 stale skill: ${dryRunRecommendation}`,
      `dry-run 后文件仍存在: ${staleStillExistsAfterDryRun}`,
      `工具错误: ${hasToolError(dryRun)}`,
    ],
    {
      traceId: dryRun.traceId,
      toolCalls: dryRun.toolCalls,
      tokensIn: dryRun.tokensIn,
      tokensOut: dryRun.tokensOut,
    },
  );

  const archiveRun = await runAgent(`
请调用 skill_curator archive，归档 skillId=online-stale-skill。
不要修改 online-gap-review 和 online-control-skill。
完成后简短说明归档与备份结果。
`);
  await reloadSkills();
  const staleArchived = !existsSync(stalePath);
  const archiveExists =
    existsSync(archiveDir) &&
    !!readDirRecursive(archiveDir).find((item) =>
      item.endsWith("online-stale-skill/SKILL.md"),
    );
  const backupExists =
    existsSync(backupDir) &&
    !!readDirRecursive(backupDir).find((item) =>
      item.endsWith("online-stale-skill/SKILL.md"),
    );
  const finalControlHash = fileHash(controlPath);
  record(
    "线上 curator 归档 stale skill 并保留备份",
    hasToolCall(archiveRun, "skill_curator", "archive", "online-stale-skill") &&
      staleArchived &&
      archiveExists &&
      backupExists &&
      finalControlHash === controlHashBefore &&
      !hasToolError(archiveRun),
    [
      `skill_curator/archive: ${hasToolCall(archiveRun, "skill_curator", "archive", "online-stale-skill")}`,
      `源文件移除: ${staleArchived}`,
      `archive 存在: ${archiveExists}`,
      `backup 存在: ${backupExists}`,
      `control 未变化: ${finalControlHash === controlHashBefore}`,
      `工具错误: ${hasToolError(archiveRun)}`,
    ],
    {
      traceId: archiveRun.traceId,
      toolCalls: archiveRun.toolCalls,
      tokensIn: archiveRun.tokensIn,
      tokensOut: archiveRun.tokensOut,
    },
  );

  const report = {
    provider: providerConfig.id,
    model: providerConfig.model,
    root,
    passed: results.filter((item) => item.pass).length,
    total: results.length,
    results,
  };
  const reportPath = path.join(root, "report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  db.close();

  console.log(
    JSON.stringify(
      { reportPath, passed: report.passed, total: report.total },
      null,
      2,
    ),
  );
  if (report.passed !== report.total) {
    process.exitCode = 1;
  }
}

function readDirRecursive(dir: string): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...readDirRecursive(fullPath));
    } else {
      entries.push(fullPath.replace(/\\/g, "/"));
    }
  }
  return entries;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
