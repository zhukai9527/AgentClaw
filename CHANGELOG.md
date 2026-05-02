# 更新日志

## [1.5.19] - 2026-05-02

### Added
- **Skill P0 自进化闭环**：新增 `skill_manage` 和 `skill_curator` 内置工具，支持技能创建、唯一匹配 patch、支持文件写入、删除确认、归档、备份、dry-run 分析和状态查询。新增 `skill_usage` / `skill_changes` SQLite 表，记录技能使用成功率、失败原因、变更动作、hash 和原因，`use_skill` 会自动写入使用 telemetry。Gateway 新增 `/api/skills/usage`、`/api/skills/changes`、`/api/skills/curate`，让前端和外部流程可直接读取与触发 curator。
- **Evolution Ledger 进化账本**：新增 `evolution_runs` / `evolution_events` SQLite 表和 `/api/evolution/runs`、`/api/evolution/events` 查询端点，把能力变更从普通会话 trace 中独立出来审计。`skill_changes` 会自动关联 evolution run，并记录触发 trace、conversation、before/after hash、change event 和验证结果，支持按目标、状态、trace 反查，从“为什么改”追到“怎么改、是否变强、如何回滚”。
- **Settings 进化日志入口**：Settings 新增“进化日志”页签，展示 evolution run 摘要、目标/状态过滤、单次进化详情和 event 时间线，补齐从账本 API 到 UI 回看的闭环。

### Changed
- **Skills 工具组扩展**：`skills=true` 现在同时加载 `use_skill`、`skill_manage`、`skill_curator`，并把 `skillsDir`、归档目录、备份目录和 telemetry 回调注入工具执行上下文，形成可持续优化的程序性记忆闭环。
- **线上能力回归增强**：`scripts/skill-online-capability.mts` 记录每个真实线上 run 的 traceId，并在验证 skill 进化时写入 `baseline_eval` / `online_regression` 事件。`SimpleOrchestrator` 新增默认开启的 `enableBackgroundLearning` 开关，回归脚本可关闭后台学习，避免测试结束时后台记忆抽取干扰验收结果。

### Fixed
- **Trace max_tokens 诊断可读性**：Trace 时间线现在显示 LLM `stopReason`、错误和文本详情；agent-loop 遇到 `max_tokens` 且没有产生工具调用/回复时，会把 trace 标记为 `llm_max_tokens_truncated`，避免空白回复被误判为正常完成。
- **Codex CLI Windows Store 路径解析**：`claude_code` 降级到 Codex CLI 时会把 `where codex` 返回的 AppData 转接路径解析为真实 LocalCache 可执行文件，避免 Node `spawn()` 对转接路径报 `ENOENT`，保证未安装 Claude Code CLI 时仍可使用 Codex 委托。
- **外部委托工具不可用空转**：`claude_code` 先快速探测 Claude Code CLI，不可用时自动降级到 Codex CLI；两者都不可用时返回终端失败并让 agent-loop 立即收敛。agent-loop 新增连续 `max_tokens` 无工具调用熔断，避免 687 秒级无副作用空转；overflow 临时目录改为真正懒创建，短错误结果不再触碰文件系统。
- **线上 Skill 能力回归修复**：新增 `scripts/skill-online-capability.mts` 真实线上回归脚本，覆盖 create、use、patch 进化、curator dry-run、archive+backup 五条能力链路。修复两处线上暴露的问题：工具失败去重 key 改为“参数前缀 + 完整参数 hash”，避免纠正后的长参数被误杀；`skill_manage create` 以 `skillId` 作为唯一身份源，自动归一 SKILL.md frontmatter `name`，确保创建后可通过 `use_skill(skillId)` 加载。

## [1.5.18] - 2026-04-30

### 新功能
- **Task DAG（任务依赖图）**：任务支持 `blocked_by` 依赖关系，自动拓扑排序执行。新建 `task_dependencies` 联表存储依赖边，含循环检测（BFS）、`blocked→queued` 自动转换、任务完成时触发下游解锁。API 新增 `GET/POST/DELETE /api/tasks/:id/dependencies` 端点
- **Hook 编码修复**：所有 `.claude/hooks/*.ps1` 文件添加 UTF-8 BOM，修复 PowerShell 5.1 读取 UTF-8 中文字符时的 `TerminatorExpectedAtEndOfString` 解析错误

## [1.5.17] - 2026-04-29

### 优化
- **overflow 提示优化**：工具输出超长时不再提示 agent 用 file_read/grep 读取完整文件，改为"预览通常够用"。天气查询测试工具调用从 6 个降到 1 个，token 消耗从 134K 降到 28K（-79%），耗时从 63s 降到 7.7s（-88%）
- **grep 工具增强**：新增 `exclude_dir` 参数，默认排除 node_modules/dist/.git/target/binaries 等目录。解决搜索大目录时结果混入二进制文件、agent 转向 bash 调用失败的问题

### 修复
- **工具被禁用时的 agent 行为优化**：glob 等工具被 config deny 后，错误消息从 "blocked by a before hook" 改为明确告知 "disabled by configuration. Do NOT retry"。修前 agent 重试 3 次触发 max_iterations（149s），修后第 1 次被拒即改用替代方案
- **依赖漏洞修复**：通过 pnpm overrides 修复 45 个安全漏洞（2 critical → 0），涉及 protobufjs/rollup/dompurify/fastify/axios/postcss 等 14 个传递依赖。xlsx（2 high）无补丁可用，vite 7（3 high，仅 dev）受 Node.js 版本限制暂未覆盖
- **README 增强**：添加 MIT License + GitHub Stars badge；新增常见问题（FAQ）章节覆盖 API key 配置、Docker 部署、模型选择、工具禁用重试、上下文压缩等 5 个问题

## [1.5.16] - 2026-04-13

### 优化
- **execute_code nudge 机制**：agent-loop 检测 web_search/web_fetch 累计 ≥3 次时智能干预。已有足够数据时引导直接输出（禁止 file_read/grep overflow），否则引导用 execute_code 批量化。军事新闻测试 110K→26K（-76%）、10 轮→3 轮

## [1.5.15] - 2026-04-12

### 新功能
- **Anthropic prompt cache 三点标记**：系统提示词 + 最后一个工具定义 + 对话历史倒数第二条消息注入 `cache_control: ephemeral`，最大化 Claude API 缓存命中率
- **yt-dlp YouTube cookies 自动化**：skill 内置 cookies 路径检查指引 + 时间范围下载模板，新会话无需用户重新提供 cookies

### 移除
- **skill_manage 工具**：实测 agent 改坏 skill 的风险远大于收益（135K token 浪费 + 错误 patch），skill 维护回归人工控制

### 修复
- **PDF/二进制下载损坏根治**：系统提示词明确禁止 web_fetch 下载二进制文件，强制 `bash curl` 下载 + `pdftotext` 提取。修复前 PDF 任务 52 次调用/182K tok/277s，修复后 4 次/42K tok/32s
- **execute_code 误写 Python 根治**：工具描述强化 "JavaScript ONLY (NOT Python)"，系统提示词明确 Python 必须走 bash
- **schedule op 参数空白容错**：LLM 输出含制表符/换行时自动 trim
- **grep 支持单文件路径**：传文件路径不再报 ENOTDIR
- **execute_code web_search 解析加固**：跳过 Direct answer/Infobox 前缀，防止 URL 错位
- **claude_code stderr 64KB 上限**：防止极端错误输出导致 OOM
- **file_write JSON/Python 语法检查**：写入后自动验证，Python hook Windows 用 `python` 而非 `python3`

## [1.5.14] - 2026-04-10

### 新功能
- **Eval 基准框架**：`npm run eval` 一键评估 agent 表现（20 个黄金测试用例），Gateway 路由 `POST /api/eval/run` 支持 API 调用
- **recall 工具（记忆主动检索）**：agent 可在对话中途主动搜索记忆库，支持关键词 + 语义 + 类型过滤，解决"记了但想不起来"的问题
- **失败自动学习**：每次对话结束后自动分析 trace 中的工具错误，LLM 提取操作教训存为 episodic 记忆，同类错误不重犯
- **复杂任务规划引导**：系统提示词新增结构化计划模板（5+ 步骤任务：列步骤 + 验证条件 + 失败回退）

### 优化
- **file_write 语法验证增强**：新增 JSON（JSON.parse）和 Python（py_compile）语法检查 hook，写入后自动验证

## [1.5.13] - 2026-04-10

### 新功能
- **AXI 工具输出优化**：web_search 改为 TOON 格式（带结果总数），glob/grep/web_fetch/schedule 增加下一步 hint 提示，引导 agent 高效串联工具调用
- **明确空状态**：glob 0 匹配、grep 0 命中、web_search 0 结果时返回明确信息（含搜索范围），区分"没结果"和"工具失败"
- **迭代式压缩摘要**：上下文多次压缩时增量更新前次摘要，而非从头重建，长对话关键信息保留率提升
- **Unicode braille 动画**：聊天页思考动画和侧边栏 spinner 替换为 unicode-animations braille 字符动画

### 修复
- **自动补发未 send_file 的文件**：LLM 偶尔跳过 send_file 直接贴本地路径，框架层兜底扫描回复文本自动补发
- **Skill description 增加反例**：15 个 skill 统一加"不用于"反例，路由准确率提升

## [1.5.12] - 2026-04-05

### 新功能
- **wechat-publish 技能**：Markdown 转微信公众号排版（100% 内联 CSS），3 个主题（tech-modern/minimal/sage），自动处理外链→脚注、中英文间距、代码高亮

### 修复
- **Skill 热更新支持新安装**：`fs.watch` 检测到新目录时自动加载 SKILL.md，git clone 安装的 skill 不再需要重启
- **use_skill 结果不再被 Overflow 截断**：skill 内容超 8K 时被转存文件导致 LLM 只看到 1500 字符预览，skill 执行不完整

### 优化
- **记忆提取改白名单模式**：从黑名单（禁止 X/Y/Z）改为白名单（只允许 4 类），default-deny 更稳健
- **上下文压缩结构化模板**：全量压缩从"3-5 bullet points"改为 7 段结构（用户请求/当前状态/关键决策/文件/错误修复/下一步/用户原话）

## [1.5.11] - 2026-03-31

### 优化
- **MicroCompact 渐进截断**：旧 tool_result 不再粗暴替换为占位符，改为保留前 200 字符 + 原始长度标记（阈值 800 字符），兼顾上下文节省与信息保留
- **记忆提取防新闻污染**：MemoryExtractor prompt 增加 6 条过滤规则，禁止提取新闻事件、市场数据、搜索结果、时效性信息等外部内容，只记用户自身信息

## [1.5.10] - 2026-03-30

### 清理
- **删除 4 个死工具文件**：`compact.ts`、`context-search.ts`、`social-post.ts`、`browser.ts`——commit de10884 删了注册但遗漏了源文件（~600 行死代码）

### 修复
- **claude_code Windows spawn 彻底修复**：不再依赖 bash 或 cmd.exe，改为解析 `claude.cmd` 找到 `cli.js` 入口，用 `process.execPath`（Node 自身）直接 spawn，彻底消除 shell 间歇性 ENOENT

## [1.5.9] - 2026-03-27

### 新功能
- **Jina Reader 集成**：web_fetch 优先通过 Jina Reader（`r.jina.ai`）获取 Markdown，质量更高；不可用时自动 fallback 到本地 Readability+Turndown
- **站点配置外置**：web_fetch 的 SPA 域名、登录墙关键词、噪音模式、站点选择器等从 `skills/web-fetch/sites.json` 加载，支持用户扩展；TS 和 Python 共享同一配置

### 修复
- **文件链接缺少 session 路径**：Telegram/钉钉/飞书/QQ/企微/WhatsApp 渠道发送文件后，WebUI 中的预览链接缺少 conversationId 路径段（如 `/files/video.mp4` → `/files/mn31qyc3-mqf8t3gu/video.mp4`），导致点击 404
- **claude_code 工具 Windows 下 ENOENT**：`shell: true` 依赖 `cmd.exe`，但 `Start-Process -WindowStyle Hidden` 启动的 gateway 进程中 `cmd.exe` 不可达，改用 Git Bash 作为 shell

## [1.5.8] - 2026-03-24

### 新功能
- **侧边栏语言切换**：底部新增地球图标，一键中英切换，删除常规设置页（/settings 默认展示模型页）
- **搜索引擎连通测试**：设置页搜索引擎卡片增加 test 按钮，一键验证 SearXNG/Serper/Querit/自定义引擎可达性
- **Hook 系统**：ToolHookManager 扩展 BeforeReturn hook，散落的 incomplete-todo guard 迁移为声明式 hook，支持外部注册
- **工具权限控制**：config.json 驱动的 allow/deny 权限，通过 PreToolUse hook 拦截，Settings 页面可视化配置

### 修复
- **claude_code SDK 失败恢复**：SDK 运行时错误不再永久禁用 SDK 模式，仅 import 失败才标记不可用

## [1.5.7] - 2026-03-23

### 新功能
- **claude_code SDK 模式**：优先使用 Claude Agent SDK（会话连续性 + 无冷启动），不可用时自动 fallback CLI。同一会话内多次调用共享上下文
- **工具全局启用/禁用**：设置页工具列表加开关，禁用的工具 LLM 完全不可见。agent 详情页同步隐藏
- **设置菜单分栏**：配置项和系统项以分隔线分组

### 修复
- **auto_send 大小写不敏感**：兼容 "True"/"true"/"TRUE"，LLM 传大写 T 不再导致文件不发送
- **桌面版配置自定义 LLM 后仍跳设置页**：providers 数组未被识别，现在同时检查
- **restart.ps1 日志重定向截断 PATH**：回滚 -RedirectStandardOutput/Error，修复 claude_code spawn cmd.exe ENOENT

## [1.5.6] - 2026-03-22

### 新功能
- **企业微信 MCP 自动发现**：WebSocket 连接后动态获取企业微信文档/表格 MCP（8 个工具），零配置
- **纯文本文件预览**：30+ 种格式侧栏预览，代码类带 Prism 语法高亮 + 行号
- **桌面版内置 5 个默认 agent**：首次启动自动部署
- **work-report skill**：一键生成日报/周报并发邮件

### 修复
- **多任务完成率从 ~20% 提升到 100%**：5 个叠加 bug 系统性修复（autoComplete 误杀、auto_send "False" truthy、todo 进度依赖 LLM、提示词矛盾、循环终止不检查完成度）
- **Playwright 抓取恢复**：误删 fetch.py 导致 X/Twitter 等 SPA 站点全部返回"JavaScript 不可用"；恢复脚本并优化去除互动按钮噪音
- **桌面版首次发消息跳设置页**：getConfig 失败时引导到模型设置页
- **MCP HTTP Accept 头**：添加 text/event-stream 支持 Streamable HTTP 协议

## [1.5.5] - 2026-03-21

### 改进
- **SQLite 每日备份**：凌晨 2 点自动备份数据库到 `data/backups/`，保留最近 7 份，防止数据丢失
- **优雅关闭**：SIGTERM 超时从 10s 延长到 30s，关闭前等待活跃对话完成（最多 15s），避免 LLM 调用被截断

### 重构
- **IM 渠道公共逻辑抽取**：新增 `channel-utils.ts`，将 5 个渠道文件中重复的 promptUser 超时、sendFile 链接构建、PUBLIC_URL 拼接、chat targets 恢复、简单事件流处理等公共逻辑统一抽取，消除 ~360 行重复代码

## [1.5.4] - 2026-03-21

### 安全修复
- **SSRF 防护**：web_fetch 新增内网地址过滤（127.0.0.0/8, 10.0.0.0/8, 169.254.0.0/16 等），阻止请求内网/元数据服务
- **file_read 路径增强**：黑名单改为正则匹配（覆盖所有 .env.* 变体），拦截 /proc/ /sys/ /dev/ 系统路径、SSH 密钥
- **Trace 敏感信息混淆**：tool_result 写入 trace 前通过 env-obfuscator 替换敏感环境变量值
- **Shell 沙箱补充**：拦截 printenv/env、cat /proc/、curl/wget 元数据服务；移除错误消息中的沙箱绕过提示
- **Subagent 回调封堵**：子代理不再继承 sendFile/saveMemory 回调，堵住通过 shell 间接绕过工具黑名单的逃逸路径
- **MCP 结果消毒**：外部 MCP server 返回内容增加 prompt injection 模式检测和警告标记
- **记忆注入中文防护**：scanMemoryContent 新增 3 条中文 prompt injection 规则
- **env-obfuscator 覆盖扩展**：SENSITIVE_PATTERNS 新增 DSN/WEBHOOK 匹配

### 修复
- **runtimeHints 不生效（P0）**：hintText 在循环外计算后固定不变，三振升级/todo nag/background task 结果全部丢失——改为每次迭代动态 join
- **namespace 数据丢失（P0）**：rebuildMemoriesTableIfNeeded 重建表时丢失 namespace 列——建表语句和 SELECT 中补入 namespace
- **QQ Bot Resume 失效（P1）**：resumeUrl 硬编码为空字符串，断线后永远走 Identify——改为从 READY 事件中获取
- **sanitizeToolPairs block 级清理**：混合 tool_result 消息中的孤立 block 现在被正确过滤，防止 API 拒绝请求
- **Docker 安全**：非特权用户运行 + .dockerignore 排除 .env/*.pem/*.key

### 优化
- **MemoryExtractor 频率**：触发间隔从 3 轮改为 8 轮，减少 60% 的独立 LLM 调用
- **压缩缓存命中**：compressTurns cache key 改为基于 turns 数量而非 tail ID，避免每条新消息触发重复 LLM 压缩
- **Shell 参数截断**：bash 工具的 command 参数加入 TRUNCATE_ARG 覆盖，减少长脚本占用上下文

### 清理
- **死代码删除**：移除 SimplePlanner、WorkflowRunner、types/config.ts（AppConfig）、legacy trigger 系统（TriggerType/SkillTrigger/matchTrigger），共删除 ~800 行无引用代码

### 改进（借鉴 ClawRouter 架构）
- **L6 观察压缩**：旧 tool_result（>500 字符）不再简单截断，而是智能提取错误行、状态信息、JSON 关键字段，重复内容自动去重引用，典型 80-95% token 节省
- **基础 Token 压缩（L2+L5）**：所有 tool_result 自动执行空白规范化（多余换行/制表符/过度缩进）和 JSON 紧凑化（pretty-print → minify），3-30% token 节省，不影响模型理解
- **LLM 错误分类体系**：7 类错误自动分类（auth/quota/rate_limit/overloaded/server_error/config/network），SmartRouter 支持模型冷却（429→60s, 503→15s）和智能 fallback 排序（冷却模型降优先级而非移除）
- **三振升级机制**：agent-loop 检测连续 3 次相似 LLM 输出（输出指纹 >80% 重合），自动注入策略变更提示，防止模型陷入重复循环
- **onLLMError 回调钩子**：agent-loop → orchestrator → gateway 三层穿透的错误报告通道，支持运行时错误分类与模型冷却
- **browser_cdp Linux headless 适配**：自动检测无 display 环境并启用 `--headless=new` + `--no-sandbox`；修复连接状态检测（`isConnected()` + 彻底重置死连接）；Dockerfile 新增 Chromium + CJK 字体；支持 Docker 部署下的浏览器自动化

## [1.5.3] - 2026-03-20

### 改进
- **Micro-Compact（静默上下文压缩）**：每轮 LLM 调用前，自动将 3 轮之前的 tool_result 内容替换为 `[previous tool result]`（>100 字符才压缩），无需 LLM 参与，持续节省 token
- **Identity Re-Injection（压缩后身份恢复）**：context 压缩后消息只剩摘要时，自动在摘要确认消息后注入 `<identity>` 块，防止非 default agent 在压缩后丢失人格
- **Todo Nag Reminder（进度提醒）**：agent 调过 update_todo 后如果连续 3 轮未更新，自动注入 `<reminder>` 提醒更新进度
- **Compact 工具（主动压缩）**：新增 `compact` 核心工具，LLM 可主动触发上下文压缩（摘要旧消息 + 删除 + 保留最近 6 轮），不再只能被动等阈值触发
- **生产就绪优化**：workDir 懒创建（纯文本 API 调用不再创建 tmp 目录）；orchestrator sessions/turnCounters + context-manager dynamicContextCache/summaryCache 替换为 LRU 缓存（防止内存无限增长）；SQLite WAL 模式已确认启用
- **Tool Argument Truncation**：旧消息中 file_write/file_edit/execute_code 的大参数自动截断为 50 字符预览，执行后不再浪费上下文空间
- **Summarization Offload**：上下文压缩时将旧消息保存到 `conversation_history.md`，summary 中带文件路径，agent 可 file_read 回顾（压缩不再不可逆）
- **记忆存储指导**：系统提示词新增 `remember` 工具规范（存什么/不存什么/先存再回复/一条一个事实）
- **Compact 门槛**：对话需达到 compressAfter 的 50% 才允许手动 compact，防止过早压缩

## [1.5.2] - 2026-03-19

### 新功能
- **文档知识库（RAG）**：agent 可上传文档文件，系统自动切片 → embedding → 向量索引；LLM 通过自动生成的搜索工具按语义检索相关段落；支持 500 字分块、段落/句子边界对齐、100 字重叠
  - 支持 PDF（pdf-parse 提取文字层，扫描件自动提示不支持）
  - 支持 HTML（Readability + Turndown 清洗，与 web_fetch 同管道）
  - 支持纯文本（.txt/.md/.csv/.json/.xml/.yaml 等直读）
- **Agent 隔离与可见性控制**：`showInChat` 控制是否在聊天页选择器中显示；`allowHandoff` 开关控制是否允许被其他 agent 转交；API 请求完全隔离，系统提示词不注入任何 agent 信息

### 改进
- **Agent 测试体验升级**：移除 Agent 详情页内嵌的简易测试 Tab，替换为"测试对话"按钮直接跳转完整 ChatPage（流式响应、工具调用、多轮对话全支持）；ChatPage 新增 Agent 指示条，非默认 Agent 时在顶部显示当前 Agent 头像和名称
- **Agent 系统提示词裁剪**：当 agent 有工具白名单时，自动移除系统提示词中引用不可用工具的规则行（如 `execute_code`、`schedule`、`claude_code` 等），末尾追加明确的工具边界声明；防止 LLM 从提示词中"发现"不可用工具名并尝试调用；tool registry 的"not found"错误信息改为列出全部可用工具
- **记忆 namespace 隔离生效**：agent 的记忆空间按 agentId 自动隔离（orchestrator 用 agentId 作为 memoryNamespace），非 default agent 不再看到全局记忆；Memory 页面新增 namespace 下拉筛选器，支持按 agent 查看/管理记忆；新增 `GET /api/memories/namespaces` 接口
- **记忆自动整合**：每天凌晨 3 点自动执行三阶段整合——重要性衰减（半衰期 30 天，identity/preference 保底 0.3）、语义去重（>0.85 相似度合并，保留更完整的条目）、清理（重要性 <0.15 且从未被检索的条目删除）；手动触发 `POST /api/memories/consolidate`

## [1.5.1] - 2026-03-19

### 新功能
- **用量统计**：Traces 页新增 Agent 下拉筛选器，按 agent 过滤追踪记录；Agent 详情页 API Tab 显示 24h / 7d 用量摘要（调用次数、token 消耗、平均延迟）；新增 `GET /api/agents/:id/usage` 接口
- **Rate Limiting**：per-agent 速率限制，支持每分钟和每天两个维度；超限返回 `429 Too Many Requests`；内存滑动窗口计数器，自动重置

## [1.5.0] - 2026-03-19

### 新功能（Hive — Agent-as-a-Service）
- **Per-agent API 端点**：每个 agent 可独立发布为 API 服务，支持无状态（`POST /api/v1/agents/:id/chat`）和 Session 模式（多轮对话），SSE 流式输出
- **Per-agent API Key**：每个 agent 生成独立的 API Key（`ac_<agentId>_<secret>`），支持生成、吊销、过期时间；`/api/v1/` 路径走 agent 自有认证，不受全局 API Key 影响
- **Memory 命名空间隔离**：`memories` 表新增 `namespace` 列，每个 agent 的记忆读写完全隔离，互不可见；向后兼容，现有数据自动归入 `default` 命名空间
- **HTTP API 知识源**：agent 可配置外部 HTTP API 作为实时数据源，平台自动生成 Tool 注册给 LLM；支持 path/query/body 参数、自定义 Headers、响应字段提取（dot-notation）；零代码连接业务系统
- **Agent 详情页**（`/agents/:id`）：从弹窗升级为独立页面，5 个 Tab：
  - Profile — 头像、名称、Soul 编辑器、模型选择、温度/迭代次数
  - Tools & Skills — 工具白名单勾选、技能黑名单勾选
  - Knowledge — HTTP API 知识源完整表单（名称/URL/Method/Headers/参数/响应提取）
  - API — 发布开关、Key 管理、自动生成 curl 示例文档
- **多语言支持**：Agent 详情页全部文字支持中英文切换（50+ 翻译键）

### 改进
- `ToolRegistryImpl` 新增 `clone()` 方法，支持 per-agent 工具注入而不污染全局注册表
- Agent 卡片显示 "API" 标记（已发布的 agent）
- CSS 类名前缀从 `ad-` 改为 `agd-`，避免 AdGuard 等广告拦截器误拦

### 修复
- **Skill 黑名单生效**：`disabledSkills` 从 UI 配置 → context-manager 过滤 skill catalog → use_skill 工具拦截，全链路生效；有黑名单时跳过全局 skillCatalogCache，确保 per-agent 过滤
- **Trace agentId 追踪**：traces 表新增 `agent_id` 列，agent-loop 创建 trace 时自动从 context 获取 agentId，支持 per-agent 用量统计
- **API Key lastUsedAt 更新**：每次 key 验证通过后自动更新 `lastUsedAt` 时间戳到 config.json
- **use_skill 黑名单拦截**：use_skill 工具执行时检查 `disabledSkills`，被禁用的 skill 返回错误而非执行

## [1.4.4] - 2026-03-18

### 新功能
- **格式错误回滚**：工具调用因 JSON 解析失败或工具名未找到而全部失败时，自动删除当前轮次的 assistant + tool turns 并重试，不浪费迭代预算；最多连续回滚 3 次，防止无限重试
- **失败摘要**：agent 达到最大迭代次数时，额外发起一次轻量 LLM 调用生成结构化总结（已完成什么、未完成什么、建议下一步），替代固定的 "max iterations reached" 提示
- **预测性 token 管理**：上下文压缩触发条件从纯轮数改为 token 估算 + 轮数双条件；根据 provider context window 的 60% 自动计算 token 预算，每轮 chars/3 估算 token 数，超过预算 70% 即触发压缩；短消息多轮不会过早压缩，长工具结果少轮也能及时压缩
- **搜索引擎 WebUI 设置**：搜索引擎配置从 .env 文件迁移到 Settings 页面，支持 SearXNG / Serper / Querit 三种引擎 + 自定义引擎；可视化拖拽排序优先级，启用/禁用切换，API Key 和 URL 在线编辑；保存后即时热更新，无需重启；旧 .env 变量自动迁移到 config.json

### 优化
- **Shell 输出 ANSI 清理**：shell 工具返回结果自动剥离 ANSI 转义序列（颜色码、光标控制等），减少无效 token 消耗

### 修复
- **Overflow 文件死循环**：模型读 overflow 文件 → 结果再被 overflow → 新文件再被读 → 无限循环。修复：file_read 读取 overflow 文件时跳过二次 overflow，并将所有 overflow 文件读取归一化为同一个 dedup key，超过 2 次自动拦截
- **工具调用总次数上限**：同一 session 内 web_search 和 web_fetch 各限 8 次（不同参数也计数），超限后强制模型用已有结果合成回答，防止"换个词再搜一遍"的无限搜索风暴
- **全局工具调用安全网**：单条用户消息内所有工具调用总计不超过 40 次，超限后强制模型停止使用工具并立即回复，防止任何模式的死循环浪费 token
- **限流压力感知**：当一轮迭代中超半数工具调用被防护层拦截时，自动注入 `[SYSTEM]` 强制输出指令，避免模型继续浪费 LLM 推理时间尝试被拦的工具（glm-5-turbo 单次推理 ~90 秒，每省一轮迭代省 90 秒）
- **Querit API 修正**：端点从 `/search` 修正为 `/v1/search`，参数名 `max_results` → `count`，响应解析适配 `results.result[]` 结构

## [1.4.3] - 2026-03-17

### 新功能
- **Intent Tracing（意图追踪）**：每个工具 schema 自动注入 `_intent` 字段，LLM 调用工具时必须说明意图；intent 在执行前剥离（不传给工具），通过 WS 事件传递到前端，ToolCallCard 优先显示 intent 作为工具调用摘要，提升 agent 行为的可解释性
- **环境变量双向混淆**：发送到 LLM 的 messages 和 systemPrompt 中，敏感环境变量值（匹配 KEY/TOKEN/SECRET/PASSWORD 模式）自动替换为 `<<$env:VAR_NAME>>` 占位符；LLM 输出和工具参数中的占位符在执行前自动还原，防止密钥泄露到 provider 训练数据
- **记忆内容质量过滤**：remember 工具新增 `EPHEMERAL_PATTERNS` 检测，自动拦截新闻标题、产品发布、市场数据等瞬时内容写入长期记忆，避免浪费系统提示词 token
- **Skill 名自动重定向**：LLM 误将 skill 名当工具调用时（如 `agent-browser snapshot`），自动识别为前缀匹配并重定向到 `use_skill`，避免 "Tool not found" 错误
- **Programmatic Tool Calling (PTC)**：新增 `execute_code` 工具，LLM 编写 JavaScript 脚本在子进程中执行，通过 IPC 调用 7 个沙箱工具（web_search/web_fetch/file_read/file_write/shell/glob/grep），中间工具结果不进入上下文窗口，仅返回 stdout；将多步工具链压缩为单轮推理，显著降低 token 消耗。沙箱工具返回 JS 友好类型（glob/grep/web_search 返回数组），禁用原生 fetch() 强制走沙箱，runner 注入完整 API 文档注释
- **对话历史搜索（context_search）**：新增核心工具，允许 Agent 搜索被压缩/截断的早期对话历史；基于 SQLite FTS5 全文索引（turns 表），支持关键词搜索并返回匹配的消息角色、时间戳和内容摘要；FTS 不可用时自动降级为 LIKE 搜索
- **受保护尾部（Fresh Tail）**：新增 `freshTailCount` 参数（默认 32），保证最近 N 条消息永远不被压缩，即使超过 `compressAfter` 阈值；与 `compressAfter` 取较大值作为实际保护数量
- **三层压缩升级**：压缩失败时自动升级 — 正常 LLM 总结（500 字 3-5 要点）→ 激进 LLM 总结（低温 200 字）→ 确定性截断（2048 字硬截断 + 轮数标注），保证无论 LLM 状态如何都能前向进展
- **大文件智能提取**：历史消息中超 12K 字符的工具结果自动持久化到磁盘（`data/tmp/lcm-files/`），替换为结构化摘要；支持 JSON（schema + 预览）、CSV（表头 + 样本行）、XML（根元素 + 子元素）、代码（imports + 签名）、纯文本（首/中/尾采样）五种内容类型检测

## [1.4.2] - 2026-03-16

### 新功能
- **Subagent 并行执行 + Cross-feed**：`spawn_and_wait` 默认 3 路并发，先完成的 agent 结果自动 steer 给还在跑的兄弟 agent；激活 `steer()` 机制，通过 `backgroundQueue` 注入指令
- **工具并行执行**：LLM 一次返回多个工具调用时，纯工具（file_read/glob/grep/web_search/web_fetch/use_skill）自动并行执行，非纯工具作为屏障串行执行；3 个 web_search 并行时延迟从 3x RTT 降至 1x RTT
- **每日简报启停开关**：Tasks 页面新增 toggle 开关，点击即时生效，关闭后 cron job 不创建
- **重复工具调用防护**：同一工具+相同参数在同一 session 中调用超过 2 次自动拦截，强制模型使用已有结果，防止 agent 循环失控无限搜索
- **聊天表格样式**：消息中的 Markdown 表格增加边框、斑马条纹、表头背景、hover 高亮、横向滚动支持
- **表格复制按钮**：hover 表格右上角出现复制图标，一键复制完整 Markdown 表格
- **消息复制按钮**：hover assistant 消息时元信息行出现复制图标，复制原始 Markdown 文本
- **MCP 热更新**：新增 `/api/mcp` 系列 API（GET/POST/DELETE/reload），支持运行时动态添加、移除、重载 MCP server，无需重启 gateway

### 修复
- **getHistory 返回最旧记录**：`ORDER BY ASC LIMIT N` 返回最旧 N 条而非最新，超 50 轮对话后 agent 完全失忆；改用子查询取最新 N 条再正排
- **memories 表重建丢失 FTS 索引**：`rebuildMemoriesTableIfNeeded` 后 `memories_fts` 残留旧数据，全文搜索完全失效；重建后同步清理并重插 FTS
- **memories/tasks 表重建无事务保护**：多条 DDL 语句不在事务中，进程崩溃可致表永久丢失；包裹 `db.transaction()`
- **Gemini tool_use ID 碰撞**：同一响应中多次调用同一工具时 ID 重复（用了 function name 作 ID），改为始终生成唯一 ID
- **Ollama native API tool call ID 碰撞**：同一响应多个 tool call 使用 `Date.now()` 生成相同 ID，改用 `generateId()` 保证唯一
- **WS activeStreams 竞态条件**：两个并发消息可同时通过 `has()` 检查，导致同一 session 启动两个 agent loop；现在在 await 前立即占位
- **WS promptUser 定时器泄漏**：stream 结束时未清理 pendingPromptRef.timer，导致 5 分钟后回调仍然触发
- **QQ Bot Resume 路径 token 未 await**：`getToken()` 是 async 函数，Resume 路径直接拼接了 Promise 对象而非 token 字符串
- **Scheduler 一次性任务竞态**：one-shot 清理逻辑在 finally 块外，回调抛异常时任务不会被清理成为僵尸记录；启动时也增加了对已执行 one-shot 的孤儿清理
- **每日简报 cron NaN**：`daily_brief_time` 设置值格式异常时 `split(":").map(Number)` 产生 NaN，导致 cron 表达式无效；增加 fallback 默认值
- **任务列表 limit 无上限**：`/api/tasks` 的 `limit` 参数无上限校验，恶意请求可拉取全量数据；限制最大 500
- **IterationBudget use_skill 回滚遗漏**：`iterations--` 回滚本地计数器但未同步 `iterationBudget.unconsume()`，子代理 use_skill 会多消耗预算
- **Context 压缩 splitIdx 越界**：`turns.length - compressAfter` 可为负数导致崩溃，增加 `splitIdx <= 0` 守卫跳过压缩
- **Tool turn JSON 解析失败静默丢失**：空 catch 导致工具结果被丢弃为空消息，改为返回 fallback tool_result block
- **remember 工具缺少 identity 类型**：type assertion 和 `saveMemory` 签名均缺少 `"identity"` 选项，与 MemoryType 定义不一致
- **ask_user CLI fallback 无超时**：readline Promise 永远等待可能挂起进程，增加 5 分钟超时保护
- **Shell streaming 模式信号杀死误判成功**：进程被信号终止时 `code` 为 null 默认为 0，现在检查 signal 参数正确设置退出码为 1
- **ChatPage wsRef stale closure**：`wsRef.current` 被错误放入 useCallback 依赖数组，WS 重连后回调使用旧连接
- **SettingsPage 无限重渲染**：`fetchAll` 和 `selectedId` 构成循环依赖，改用 ref 打破循环
- **API client headers 被丢弃**：`request()` 函数丢弃调用方自定义 headers，改为合并默认与自定义 headers
- **saveConfig 浅合并丢失嵌套字段**：`{ ...existing, ...config }` 整体替换嵌套渠道对象，改为 `deepMerge` 递归合并
- **refreshConfig 无条件重启所有渠道**：改为比较新旧配置，只重启实际变更的渠道，避免无关渠道短暂中断
- **auth.ts API_KEY 模块加载固化**：改为每次请求动态读取 config.json + env，支持通过 Web UI 热更新 API key

## [1.4.1] - 2026-03-15

### 新增
- **多 Provider 实例架构**：支持同时配置任意数量的 LLM Provider（DeepSeek/通义千问/Kimi/智谱/火山引擎/Ollama 等），`providers[]` 数组存储，旧格式环境变量自动迁移
- **Model Tab 改版**：左侧列表展示所有已配置 Provider（带开关切换），右侧编辑表单，底部添加按钮支持 10 种预设模板一键添加
- **Agent 模型下拉选择**：Agent 编辑面板的 model 字段改为下拉菜单，直接从已配置 Provider 列表中选择
- **任务型侧边栏**：对话列表按状态分组（进行中 / 等你回复 / 已完成），右键菜单支持"标记完成"/"重新打开"，运行中的 agent loop 自动归入"进行中"
- **Shell 命令流式进度推送**：yt-dlp、ffmpeg 等长时间命令执行时，实时推送下载/编码进度到前端（3 秒节流）
- **渠道配置 UI 编辑**：Settings → Channels 页面改为左右分栏布局，支持在界面配置 Telegram/钉钉/飞书/QQ Bot/企微凭证，保存后自动热重启渠道

### 改进
- **定时任务可视化调度**：创建定时任务改用频率下拉（每天/工作日/每周/每月）+ 时间选择器，替代手写 cron 表达式；高级用户仍可选「自定义 cron」；动作输入改为多行文本框；支持编辑已有任务、立即运行、启停切换；操作按钮改为图标样式（编辑/运行/删除）
- **欢迎页改版**：新增图标 + 标题「开始协作」+ 副标题，参考 DeepSeek 风格
- **LLM 自动生成会话标题**：首轮对话后异步调用 LLM 生成简洁标题（≤20 字），替代原来截取前 50 字
- 侧边栏「新对话」改为「新任务」，对齐工具型产品定位
- 「等你回复」状态的会话增加脉冲圆点指示
- 删除 SetupWizard 组件（~600 行），未配置时直接跳转 Settings 页面，入口统一
- 渠道凭证读取改为 config.json 优先、环境变量兜底，兼容老用户 .env 配置
- General Tab 精简为外观（语言/主题）+ 系统信息，LLM 配置和用量统计移至 Model Tab

### 修复
- **Provider API Key 被脱敏值覆盖**：保存某个 Provider 配置时，其他 Provider 的 `apiKey` 从 GET 返回的脱敏值（`****xxxx`）被原样写回 config.json，导致重启后 key 失效。后端现在检测 `****` 前缀并保留原始值
- 任务型侧边栏：历史会话默认归入"已完成"而非"进行中"；分组后列表无法滚动
- 点击停止按钮后，正在执行的工具卡片时钟图标不停止旋转（含刷新后历史加载）
- 停止的会话缺失 usage stats——WS abort 跳过 generator 收尾 + 有工具调用但无文本回复时 message-meta 不渲染
- 删除会话时清理 `data/tmp/{sessionId}/` 目录及文件
- Tauri 桌面版 API/WS 连接失败（`tauri://localhost` 下相对路径打到资产协议而非 gateway）

## [1.4.0] - 2026-03-14

### 新增
- **Tauri v2 桌面客户端**：Rust 窗口 + 系统托盘 + sidecar 自动启停，三平台 CI/CD（.exe/.dmg/.deb）
- **统一配置系统**：`config.json` + 环境变量 + `.env` 三层合并，配置 REST API（读/写/验证）
- **Setup Wizard**：首次启动 4 步引导，未配置时发消息自动弹出
- **Provider N 选 1**：卡片式布局，每个 Provider 独立 API Key + 模型，radio 切换运行时生效
- **静态文件托管**：gateway 生产模式自动托管 web 前端
- **disableThinking 配置**：`config.json` 或 `DISABLE_THINKING=true`，Ollama 自动切原生 API 关闭思考
- **配置热更新**：前端保存 model/baseUrl/apiKey 等字段后自动重建 provider，无需重启

### 修复
- Tauri 启动 panic（移除无效 `plugins.shell.sidecar` 字段）
- NSIS 安装包内嵌 WebView2 引导
- 静态文件 404（fastify-static wildcard 限制）
- 应用图标替换为 512x512 高清龙虾
- Linux 打包 AppImage → deb

## [1.3.12] - 2026-03-14

### 新增
- **Chrome 146 CDP 直连**：自动探测 Chrome Remote Debugging，零扩展操控真实浏览器
- **agent-browser 集成**：Rust 原生无头浏览器，140+ 命令，自动按域名匹配登录态
- **Prompt cache 命中率**：Traces 页面显示 cache 命中百分比

### 安全
- **WebSocket / CORS origin 校验**：`ALLOWED_ORIGINS` 环境变量

### 性能
- LLM 流式中止主动 `abort()` 释放连接
- OpenAI 兼容 provider 支持 prompt cache 统计
- Subagent 返回超 2000 字符自动截断
- Skill 目录全局缓存

### 修复
- **长期记忆丢失**：新增 `identity` 记忆类型，始终注入系统提示词
- web_fetch 失败自动提示切换 agent-browser
- ask_user 后 thinking 动画不消失
- send_file 自动归档到 session 目录
- regenerate/edit 流式状态丢失

## [1.3.11] - 2026-03-13

### 新增
- **Thinking 动画**：发送后即时显示轮播短语（Thinking/Pondering/Brewing… 等），工具调用期间持续显示
- **溢出模式**：工具大输出自动存文件，LLM 收预览 + 引用可按需探索
- **后台任务模式**：shell 工具新增 `background` 参数，长时间命令后台执行

### 改进
- **`/` 斜杠命令面板**：输入 `/` 弹出技能选择菜单，支持键盘导航和模糊搜索
- **Agent 选择器**：输入框左下角药丸按钮，点击弹出下拉切换，多 Agent 时显示、单 Agent 时隐藏
- **欢迎页精简**：移除顶部 Agent 药丸组和 `田` 技能按钮
- **micro_compact 标注工具名**：压缩旧工具输出时替换为 `[Previous: used grep]` 等标注
- **web_fetch 移除 max_length**：由溢出模式统一处理上下文保护

### 重构
- **ASR 去 Python 化**：迁移到 sherpa-onnx-node，连续语音延迟从 2-5s 降至 <50ms；SILK 解码改用 silk-wasm（支持 QQ/微信语音）；输出繁转简（opencc-js）

### 修复
- **移动端返回键弹层竞争**：新增 `useBackClose` hook 统一管理 overlay 栈

## [1.3.10] - 2026-03-12

### 新增
- **Traces 渠道标记**：每条 trace 记录来源渠道，前端显示标签
- **Traces 工具调用统计面板**：顶部可展开统计面板，按工具名分组详细表格
- **Traces 按 conversationId 分组**：同一会话多轮 trace 自动分组
- **bilingual-subtitle 防呆**：process.py 直接支持 URL 输入
- **确定性 Workflow Agent**：Sequential/Parallel 执行引擎，步骤间模板变量传递
- **Trajectory 自动评估框架**：工具选择/参数正确性评估 + 黄金测试集
- **Subagent 安全防线**：工具黑名单 + IterationBudget 父子共享预算
- **Memory 内容安全审查**：拦截 prompt injection、隐形 unicode、凭证窃取
- **渠道格式提示**：各渠道自动注入格式指导到系统提示词
- **Frozen Snapshot**：session 内冻结 dynamic context，prompt cache 命中率提升，~75% input token 成本节省
- **Context 压缩 tool pair 保护**：压缩边界不在 tool_call/result 间切割
- **Subagent spawn_and_wait**：一次提交多个子任务，顺序执行结果一次性返回
- **SubAgentCard 卡片 UI**：subagent 调用以单卡片展示
- **Browser 增强**：人类化输入（模拟真人节奏）、快照过滤模式（只返回交互元素）、批处理摘要、反自动化检测

### 优化
- **TTS 去 Python 化**：用 `@bestcodes/edge-tts` 替换，冷启动从 ~800ms 降至 0，总延迟 ~300-600ms
- **语音回复防呆**：注入提示防止 LLM 自己跑 edge-tts CLI

### 修复
- **web_fetch save_as + auto_send**：抓取→保存→发送从 3 轮降到 1 轮（~134s → ~15s）
- **企业微信重启后 Session not found**：检测过期 session 自动清除映射
- **会话删除不停止 agent loop**：删除时先 stop 运行中的 loop
- **切换会话工具卡片重复**：修复 history/WS resuming 竞态条件

### 重构
- **Settings 整合**：管理页面（Channels/Agents/Memory/Tools/Skills/Traces 等）收入 Settings 子页面，侧边栏精简为 4 项，旧路径自动重定向
- **ChatPage hooks 提取**：WS 连接和 streaming 状态各提取为独立 hook，ChatPage 减少 ~150 行

### 修复
- **Subagent 记录持久化**：spawn/完成/失败/kill 写入 SQLite，页面不再永远 0 条
- **停止按钮恢复**：新会话首次发送时 stop 按钮不出现
- **Settings Tools 标签页**：缺少 switch case 导致显示 General 内容

## [1.3.9] - 2026-03-11

### 改进
- **预览面板刷新按钮**：文件名旁增加刷新按钮，点击后重新加载 iframe 和源码内容，解决文件更新后缓存不刷新的问题

### 修复
- **WS 断连时停止按钮误恢复**：断连回调不再清除 isSending，agent 仍在服务端运行时保持停止按钮可见

## [1.3.8] - 2026-03-10

### 改进
- **会话级工作目录**：同一会话复用 `data/tmp/{conversationId}/` 目录，后续消息可直接修改前几轮生成的文件，无需从零重建

### 修复
- **sidebar spinner 切换会话闪烁**：解耦 streamingSessionId 和 isSending，spinner 只在收到 done 时清除，不再因切换会话而消失
- **切换会话时工具调用串台**：切换会话时重置 resumingRef，防止 loadHistory 的 resuming 分支把旧会话的 streaming 消息合并到新会话
- **WS 重连时工具调用重复显示**：loadHistory resuming 合并时去掉 history 末尾的 assistant 消息，避免与 buffer 回放重复


## [1.3.7] - 2026-03-10

### 改进
- **侧边栏会话 streaming 指示器**：会话正在响应时，左侧会话列表对应项显示旋转加载动画

### 修复
- **切换会话时 spinner 和工具调用串台**：streaming 指示器锁定到发起请求的会话，切换会话时重置 isSending 状态

## [1.3.6] - 2026-03-10

### 新增
- **Agent Handoff（代理交接）**：多代理场景下，LLM 可通过 `handoff` 工具将对话交给更合适的专家代理继续处理，最多 3 次连续交接，前端显示交接通知气泡

## [1.3.5] - 2026-03-10

### 修复
- **WS 断连后流式输出丢失**：agent loop 与 socket 解耦，断连时 loop 继续运行并缓冲事件，重连后自动回放，无需刷新页面

## [1.3.4] - 2026-03-10

### 改进
- **预览面板化**：HTML 预览从全屏 overlay 改为右侧可拖拽宽度的 panel
- **预览面板拖拽宽度**：左边缘拖拽调整（20%-70%），移动端仍全屏

### 修复
- **Markdown 预览源码/复制显示渲染后 HTML**：改为获取原始 markdown 文本
- **二进制文件预览隐藏源码/复制按钮**：pptx/xlsx/pdf 等文件的源码无意义
- **Lone surrogate 导致 Claude API 400（彻底修复）**：在 provider 层统一清理所有发往 API 的文本

## [1.3.3] - 2026-03-10

### 新增
- **编辑消息支持历史截断**：编辑用户消息时后端截断该时间点之后的对话历史再重发
- **编辑首条消息自动更新会话标题**

## [1.3.2] - 2026-03-10

### 修复
- **file_write 容错非 string content**：弱模型传 Object/Array 时自动 JSON.stringify
- **工具重试限制器误杀**：failKey 改为包含参数签名，LLM 自我修正后不再被拦截
- **browser_cdp evaluate 输出截断**：限制 8000 字符，防止错误页面灌爆上下文

## [1.3.1] - 2026-03-10

### 修复
- **任务 QuickAdd 走 LLM 分流**：经 captureTask 自动判断 agent/human 执行者
- **captureTask 返回值序列化**：修复前端 NaN 时间和字段名不匹配
- **任务执行注入工作目录**：确保 LLM 生成的文件保存到 data/tmp
- **文件预览 IconDownload 未定义**：补充导入修复 md 预览崩溃

## [1.3.0] - 2026-03-09

### 新增
- **多语言支持（i18n）**：Web 前端完整国际化，英文/中文切换，覆盖 13 页面 + 7 组件约 200 个翻译键

## [1.2.1] - 2026-03-09

### 改进
- **schedule 工具参数描述完善**：message 字段明确标注"仅填写任务指令"
- **Scheduled Tasks 持久化**：定时任务存入 SQLite，重启后自动恢复

### 新增
- **Projects 项目管理系统**：类似 Claude.ai Projects，会话按项目分组，支持 CRUD、自定义颜色/指令
- **项目详情页**：ChatGPT 风格文件夹视图，内联聊天入口，会话预览
- **侧边栏项目区**：折叠式项目列表、新建项目弹窗、会话"移至项目"操作
- **工具调用折叠组**：≥3 个已完成工具调用自动折叠为摘要，点击展开详情

## [1.2.0] - 2026-03-08

### 新增
- **企业微信渠道**：`@wecom/aibot-node-sdk` WebSocket 长连接，支持文字/图片/语音/文件、流式回复、主动推送
- **social_post 工具**：一次调用发帖到 X/小红书/即刻，支持附加图片
- **浏览器 click 文本选择器**：`text=xxx` 按可见文本匹配点击
- **paste_image 三级 fallback 去重**
- **QQ Bot 富媒体消息**：语音/图片/视频/文件处理，语音自动转文字
- **QQ Bot `/new` 命令和语音回复**
- **Telegram 语音框架层转录**：省去 LLM 调 shell 转录的 ~50K tokens
- **MAX_ITERATIONS 环境变量**
- **浏览器登录态持久化**：Chrome 扩展导出 → Playwright storageState 复用
- **TaskManager 任务管理引擎**：自然语言捕获→分诊→队列调度→自动执行→决策请求→每日简报
- **Tasks 页面重构**：5 标签页 + Task Runner Stats + QuickAdd + Decision Queue

### 改进
- **输入框图片粘贴**：textarea 支持 Ctrl+V 粘贴图片
- **语音输入 MediaRecorder fallback**：不支持 Web Speech API 时使用 MediaRecorder
- **图片 vision 修复**：DB 改为存储 ContentBlock[] JSON，支持图片路径引用
- **每日简报定时推送**、决策提醒机制、Settings KV 存储

## [1.1.0] - 2026-03-08

### 新增
- **QQ 机器人渠道**：QQ 开放平台 Bot API v2，C2C 私聊和群聊，WebSocket 网关

## [1.0.3] - 2026-03-08

### 修复
- **API 请求头覆盖**：renameSession headers 覆盖 Authorization 头
- **promptUser 超时保护**：WS/钉钉/飞书 添加 5 分钟超时

## [1.0.2] - 2026-03-08

### 修复
- **WebSocket 自动重连增强**：无限重试 + visibilitychange/online 事件监听
- **LLM 流异常捕获**：网络断开时 token 统计和 trace 仍能保存
- **上下文截断污染修复**：截断前先浅拷贝，避免直接修改原始 Message
- **promptUser 超时保护**：Telegram/WhatsApp 5 分钟超时
- **eventStream/taskDecisions 资源泄漏修复**
- **FTS5 索引事务保护**、向量相似度维度修复、WebSocket error 处理

## [1.0.1] - 2026-03-07

### 新增
- **单元测试**：memory/tools/gateway 三个包共 152 个用例（会话 CRUD、沙箱规则、HTTP 认证等）

## [1.0.0] - 2026-03-06

### 新增
- **多 Agent 系统**：创建/编辑/删除自定义 Agent，独立 Soul/Model/Temperature/Tools 过滤
- **5 个预设 Agent**：AgentClaw、Coder、Writer、Analyst、Researcher
- **Agent 管理页面** + 会话级 Agent 选择

### 修复
- Agent soul 注入失败、gitignore 遗漏 SQLite 文件

## [0.9.9] - 2026-03-06

### 修复
- **WebUI 图片上传路径丢失**：统一存储到 data/uploads/
- **comfyui 图片路径兜底**：resolve_image_path 查找
- **后台任务会话污染侧边栏**

### 新增
- **Task Runner 统计卡片**

## [0.9.8] - 2026-03-06

### 改进
- **全栈代码重构**：44 文件净减 ~800 行，提取公共工具函数，消除跨包重复

## [0.9.7] - 2026-03-06

### 改进
- **Serene Sage 主题**：全站鼠尾草绿暖色调主题，Light/Dark 双套色板，语义化 CSS 变量

## [0.9.6] - 2026-03-06

### 新增
- **Google Tasks 统一看板**：Google Tasks 作为数据源，支持 CRUD 操作
- **Google Calendar 日程展示**：未来 14 天事件按日期分组
- **Task Runner 智能执行**：LLM 自动判断任务可执行性
- **Automations 面板**：定时任务管理从 Settings 迁至 Tasks 页

### 移除
- 旧版本地 SQLite 任务看板

## [0.9.5] - 2026-03-05

### 新增
- **Google Workspace CLI (gws) 集成**：5 个 Skill（calendar/tasks/gmail/drive/sheets），零 token 开销

## [0.9.4] - 2026-03-05

### 新增
- **Settings 定时任务管理**：查看、创建、删除定时任务

## [0.9.3] - 2026-03-05

### 新增
- **频道管理面板**：运行时控制五个频道启停，状态指示灯，5 秒自动刷新
- **任务看板**：Todo/In Progress/Done 三列，优先级标记，Human/Bot 指派
- **子代理可视化页面**：运行记录、状态筛选、token/工具/迭代详情
- **ChannelManager 统一管理**

### 改进
- 侧边栏导航分层（主导航 + More 折叠组）
- Task Runner 自动执行 bot 任务

## [0.9.2] - 2026-03-05

### 修复
- **工具停止机制**：用户点击停止后子进程无法终止，新增 AbortSignal 传导链

### 改进
- Traces 页 token 显示改为 tokensIn↑/tokensOut↓ 分开

## [0.9.1] - 2026-03-05

### 新增
- **file_edit 工具**：精确字符串替换，支持唯一匹配校验和 replace_all
- **glob 工具**：文件名模式搜索
- **grep 工具**：正则内容搜索
- **子代理 explore 只读模式**

## [0.9.0] - 2026-03-05

### 新增
- **子代理编排**：subagent 工具 + SimpleSubAgentManager，独立 agent-loop 并行执行
- **Docker 沙箱**：sandbox 工具，容器内安全执行，资源限制
- **浏览器 CDP 直连**：browser_cdp 工具，Playwright connectOverCDP，DOM 快照 ref ID
- **混合记忆搜索**：FTS5 + BM25 + 向量语义 + 时间衰减 + MMR 去重
- **工具执行钩子**：before/after + allow/deny 策略

## [0.8.30] - 2026-03-04

### 新增
- **钉钉机器人**：Stream 模式，无需公网 IP
- **飞书机器人**：WebSocket 模式，无需公网 IP

## [0.8.29] - 2026-03-04

### 新增
- **OpenAI Compatible Embedding**：embed() 方法支持 /v1/embeddings 端点

### 修复
- Volcano Embedding 响应解析修复

## [0.8.28] - 2026-03-04

### 新增
- **Vitest 测试框架**：core + providers 共 45 个测试
- **Sentry 错误监控**：gateway + web 端条件初始化
- **API 路由输入校验**：13 个端点 JSON Schema 校验
- **Gateway 优雅关停** + /health 健康检查

### 改进
- knip 死代码清理、Biome 格式化、GitHub Actions CI

## [0.8.27] - 2026-03-04

### 新增
- **Office 文件预览**：docx/pptx 转 PDF、xlsx/csv 转 HTML 表格，LibreOffice 并发控制

## [0.8.26] - 2026-03-02

### 改进
- **web_fetch SPA 自动降级增强**：已知 SPA 域名列表直接走 Playwright
- **send_file autoComplete**：成功后自动结束 agent-loop 省 token
- **上下文膨胀控制**：只保留最近 2 条 tool result 完整内容
- **Telegram 流式输出**：sendMessageDraft 实时更新消息

### 新增
- **Markdown 文件预览**：服务端 marked 渲染为 HTML
- **Claude Code 执行过程透明化**：实时推送每步操作到前端

### 修复
- file_write/send_file 相对路径修复、Windows 下子进程弹窗、Telegram 文件显示为 DAT

## [0.8.25] - 2026-03-02

### 新增
- **跨通道会话同步**：Telegram/WhatsApp 完成后广播 session_activity 到 Web UI

### 改进
- 健康检查静默恢复，仅新故障通知

## [0.8.24] - 2026-03-02

### 新增
- **Browser Accessibility Snapshot**：结构化无障碍快照，token 节省 70-80%
- **Ref ID 选择器**：click/type/wait_for 支持 ref ID

## [0.8.23] - 2026-03-02

### 新增
- **Health-check 框架**：5 项服务自动检测 + 定时复检 + 异常注入系统提示词
- **Browser scroll/reload**
- **Claude Code 开发 hooks**：auto-build、check-changelog、auto-restart-gateway

### 改进
- web_fetch 智能瀑布策略（SPA 自动回退 Playwright、登录墙检测）

## [0.8.22] - 2026-03-02

### 新增
- **web_search 内置工具**：SearXNG + Serper 直接作为核心工具

### 改进
- Skill description 精确化（browser/web-fetch/web-search 职责边界）

## [0.8.21] - 2026-03-02

### 新增
- **web_fetch 注册为核心工具**
- **Readability 正文提取**：@mozilla/readability 自动提取正文，token 节省 70-80%

### 改进
- HTML→Markdown 输出（turndown 替换正则）、浏览器 UA 伪装

## [0.8.20] - 2026-03-01

### 新增
- **web-fetch Playwright 替代**：无头 Chromium 支持 JS 渲染 + 自动滚动
- **LLM stopReason 管道**：检测 max_tokens 截断并 warn

### 修复
- maxTokens 4096→8192、temperature 0.7→0.5
- use_skill 无限循环防护、auto-install 命令注入白名单
- context-manager 缓存碰撞和内存泄漏
- WS 重连指数退避

## [0.8.19] - 2026-03-01

### 修复
- comfyui 图片生成路径改为会话目录（--output-dir 参数）

## [0.8.18] - 2026-03-01

### 修复
- **use_skill 框架层替换 {WORKDIR}**：LLM 拿到带绝对路径的命令，不再依赖 LLM 自己读取路径
- 移除与技能冲突的路由规则、强制 use_skill 优先

## [0.8.17] - 2026-03-01

### 修复
- **技能目录注入 description**：弱模型无法将意图关联到纯名称，改为 `name: 中文描述` 格式

## [0.8.16] - 2026-03-01

### 修复
- 上传文件重复消除、技能输出路径统一使用 {WORKDIR}

## [0.8.15] - 2026-03-01

### 修复
- 用户附件统一进 per-trace 工作目录、shell auto_send 不再误发 ls 列出的历史文件

## [0.8.14] - 2026-02-28

### 改进
- 运行时 hint 全部中文化，与系统提示词语言一致

## [0.8.13] - 2026-02-28

### 修复
- 图片路径 hint 改为每轮注入（DB 存干净内容）
- 输出文件按会话隔离、shell auto_send 正则支持子目录

## [0.8.12] - 2026-02-28

### 修复
- bash 失败计数按命令区分（不同命令不互相阻断）
- update_todo description 与系统提示词统一
- gcal.py token 刷新错误处理

## [0.8.11] - 2026-02-28

### 改进
- 工具执行耗时持久化到 trace、移除 todo auto-advance

### 修复
- file_read/file_write `/tmp` 路径映射（Windows Git Bash 兼容）

## [0.8.10] - 2026-02-28

### 改进
- 代码精简：bootstrap 消除重复变量、context-manager 记忆提示语中文化

## [0.8.9] - 2026-02-28

### 优化
- 系统提示词全中文化并精简 35%
- 记忆去重双层防线（LLM 侧 + 代码侧跨类型搜索）

## [0.8.8] - 2026-02-28

### 精简
- 删除 3 个冗余工具（set_reminder/plan_task/delegate_task）和 2 个冗余技能
- 每轮 LLM 调用减少 ~450 tokens

## [0.8.7] - 2026-02-28

### 改进
- 删除 skill auto-injection，统一走 use_skill 按需加载
- update_todo 自动推进（工具成功后自动标记下一项）
- 移动端文件选择修复

## [0.8.6] - 2026-02-27

### 修复
- 历史消息 /files/ URL 清理、附件 hint 自然语言化、send.py 路径自动搜索
- 带附件发邮件：92k → 6.7k tokens

## [0.8.5] - 2026-02-27

### 改进
- Per-trace 临时目录隔离、脚本文件不再自动发送、Todo 进度持久化
- 非图片附件对 LLM 可见（注入文件路径提示）

## [0.8.4] - 2026-02-27

### 修复
- 用户图片自动保存到文件（避免后续迭代重发 base64）
- 强制 use_skill 优先、PowerShell 自动路由
- Skill 自动注入（结构信号匹配）、连续错误阈值 2→3

## [0.8.3] - 2026-02-27

### 修复
- 记忆回归系统提示词（KV-Cache 优化误移到 user 消息导致被忽略）
- Email Skill 强制检查环境变量、Shell 超时 30s→120s
- Skill 依赖自动安装、Token 统计持久化完善
- maxIterations 10→15

## [0.8.2] - 2026-02-27

### 修复
- SearXNG 搜索质量（仅保留 yahoo + duckduckgo、恢复 language=zh-CN）
- 知识类问题不再触发搜索
- ToolRegistry skill 自动重定向（弱模型分不清 tool/skill）

## [0.8.1] - 2026-02-26

### 新功能
- **Todo 实时进度追踪**：update_todo 工具 + 前端进度条
- **SearXNG 搜索引擎集成**：自托管免费元搜索，docker-compose 包含

### 优化
- Agent loop 上下文缓存复用、Claude provider cache_control
- 代码块简化、单行代码块轻量渲染

## [0.8.0] - 2026-02-26

### 新功能
- **Docker 化部署**：多阶段 Dockerfile + docker-compose 一键启动
- **React 实时预览（Artifacts）**：JSX/TSX 代码块 Babel 编译 + React 19 CDN 渲染

### 修复
- sendFile 子目录路径、Vite 项目预览降级、HTML 预览安全

## [0.7.15] - 2026-02-26

### 修复
- Shell 工具文件自动发送正则修复（支持任意扩展名）
- 欢迎页附件按钮和 pending files 修复

## [0.7.14] - 2026-02-25

### 新功能
- **语义向量化**：火山引擎 doubao-embedding-vision 多模态 API

## [0.7.13] - 2026-02-25

### 新功能
- **欢迎页重设计**：居中输入框 + 技能快捷入口，对齐 Claude/Gemini 风格
- **输入框两行布局**、技能弹出菜单

## [0.7.12] - 2026-02-25

### 新功能
- **Skill 预选芯片**：输入框快捷按钮跳过 use_skill，每次节省 ~3000 token

## [0.7.11] - 2026-02-25

### 新功能
- **消息编辑重发**、**ask_user Web 端交互支持**

### 改进
- Skill 目录恢复短描述、消息 meta 精简

## [0.7.10] - 2026-02-25

### 新功能
- **Web 语音输入**：Web Speech API 实时语音转文字

## [0.7.9] - 2026-02-25

### 优化
- 系统提示词瘦身（-80 token）、长期记忆注入精简（10→5 条）
- Skill 目录压缩（~250→~30 tok）、工具失败自动熔断

## [0.7.8] - 2026-02-25

### 改进
- 移动端侧边栏加宽、左滑关闭

### 修复
- claude_code 嵌套会话报错、输出重复

## [0.7.7] - 2026-02-25

### 改进
- Header 操作菜单（Rename/Export/Delete）、移动端删除按钮精简

## [0.7.6] - 2026-02-25

### 安全修复
- **命令注入漏洞（RCE）**：execSync 拼接改为 execFileSync 参数数组

### 修复
- Gemini 工具调用 ID 修复、deleteSession 事务、Trace JSON 解析容错
- ensureConversation 竞态、Agent stop 后仍重试、WhatsApp LID undefined

## [0.7.5] - 2026-02-24

### 新功能
- **claude_code 工具**：集成 Claude Code CLI，流式输出实时推送

### 改进
- 手机端侧边栏手势、Artifacts 预览（HTML/SVG/Mermaid）、工具调用 JSON 树形展示

### 修复
- WS 断连崩溃（safeSend）、Cloudflare Tunnel 503、WS 长推理断连
- Stop 按钮无效、手机回车误发送、手机侧边栏自动弹出

## [0.7.4] - 2026-02-24

### 新功能
- **URL 路由驱动会话**：`/chat/{sessionId}` 支持前进/后退/刷新/分享

### 修复
- New Chat 415 错误、零请求优化、消息闪跳、Connection Lost

## [0.7.3] - 2026-02-23

### 改进
- yt-dlp --no-warnings、--write-auto-subs，bilingual-subtitle CC 快路径

## [0.7.2] - 2026-02-23

### 新功能
- **bilingual-subtitle skill**：字幕提取/翻译/烧录，GPU 加速 Whisper
- **会话重命名**（双击标题）、全局字号提升

### 改进
- Memory 语义去重（相似度阈值 0.75）、Browser batch 模式（多步操作压缩到 2 轮）

### 修复
- Telegram/WhatsApp 广播持久化、会话懒创建

### 移除
- Plans 页面（无实际用途）

## [0.7.1] - 2026-02-23

### 改进
- Settings 页精简、Skills 独立页面、临时文件自动清理

## [0.7.0] - 2026-02-23

### 新功能
- **5 个新技能**：docx、xlsx、pptx、pdf、imap-smtp-email
- **技能开关/导入/删除**

## [0.6.1] - 2026-02-23

### 新功能
- **视频/音频播放器嵌入**、**图片多模态支持**、**会话搜索**、**移动端侧边栏优化**

### 改进
- 工具调用卡片标题增强（显示命令/技能名/路径）

## [0.6.0] - 2026-02-22

### 重构
- **WebUI 单侧边栏布局**：合并双侧边栏为 Claude 风格统一侧边栏，所有 emoji 替换为 SVG 图标

## [0.5.0] - 2026-02-22

### 新功能
- **Light/Dark 主题**、代码高亮+复制、Stop 按钮、Session 标题
- 文件上传/拖拽、消息重新生成、浏览器通知、模型切换
- 会话删除、对话导出、消息搜索、工具执行状态

## [0.4.0] - 2026-02-22

### 新功能
- **模型 Failover 链**：多 provider 自动故障切换，60 秒冷却
- **Shell 沙箱**：拦截破坏性命令
- **子 Agent 委派**：delegate_task 工具

### 技能
- yt-dlp 技能（视频/音频下载）

## [0.3.0] - 2026-02-22

### 新功能
- **TTS 语音回复**：edge-tts / vibevoice，超 500 字降级文字

## [0.2.0] - 2026-02-22

### 新功能
- 对话历史压缩、Fast Provider 路由、MCP 服务器加载、Session 持久化、SOUL.md 人格设定

### 改进
- use_skill 不消耗迭代预算、流式推送重构、Shell 输出截断

## [0.1.0] - 2026-02-22

首次发布。

- Agent 循环（思考-行动-观察）+ 流式 LLM 输出
- 多供应商适配：Claude、OpenAI 兼容、Gemini
- 核心工具 4 个 + 条件工具 6 个 + 13 个技能
- Fastify HTTP/WS + Telegram Bot + WhatsApp Bot
- React 19 + Vite 前端
- SQLite 持久化 + 定时任务调度
