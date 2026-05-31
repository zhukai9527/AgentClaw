# AgentClaw 需求文档

## 一、Behavior Policy（P0）

### 目标
每个 agent 拥有独立的运行配置档案：模型、会话、工具权限、安全规则。

### 需求

1.1 **策略数据结构**
```typescript
type BehaviorPolicy = {
  // 模型配置
  model: {
    provider: string;    // provider ID
    model: string;       // 模型名称
    baseUrl?: string;    // 自定义 base URL
    apiKey?: string;     // 自定义 API Key
  };
  // 独立会话
  session: {
    conversationId: string;
    maxTokens?: number;          // session token 预算
    contextWindow?: number;      // 上下文窗口大小
  };
  // 权限控制
  permissionMode: 'plan' | 'auto' | 'chat';
  allowedTools: string[];       // 工具白名单（空 = 全部）
  blockedTools: string[];       // 工具黑名单
  maxToolRounds: number;        // 最大工具调用轮次
  // 安全规则
  securityRules?: SecurityRule[];
};

type SecurityRule = {
  type: 'tool_approval' | 'file_access' | 'network_access';
  action: 'allow' | 'deny' | 'prompt';
  pattern?: string;
};
```

1.2 **运行时行为**
- 每个 agent spawn 时携带自己的 policy
- agent 独立运行、独立模型、独立上下文
- policy 可在运行时切换（切换后新请求生效）
- 默认 policy 使用 gateway 全局配置

1.3 **UI**
- Agent 详情页增加 Policy 配置面板
- 模型选择器支持自定义 provider / baseUrl / apiKey
- 工具权限以 checkbox 列表展示

---

## 二、Workspace 技能隔离（P0）

### 目标
切换 workspace 时 agent 能力自动切换，无需重启进程。技能文件修改后热加载。

### 需求

2.1 **技能加载策略**
```
workspace/skills/             → 当前 workspace 专有技能
system skills/                → 系统内置技能（fallback）
```
- LLM session 只看到当前 workspace 可见的技能
- 技能名冲突时 workspace 技能优先

2.2 **热加载**
- 文件变更（新增/修改/删除 SKILL.md）→ 自动刷新技能注册表
- 当前活跃 session 下一轮 agent loop 自动加载最新内容
- 使用 `fs.watch` 或类似机制监听 `skills/` 目录

2.3 **UI**
- 技能列表显示来源标签：`[workspace]` / `[system]`
- Workspace 切换后技能列表自动刷新

2.4 **当前状态**
- Phase 1-0 已有 workspace 切换基础
- 技能目录扫描逻辑已有（WorkflowRegistryImpl 可复用）
- 缺 watch/热加载机制

---

## 三、ACP 远程 CLI Agent 自动发现 + 会话透传（P1）

### 目标
自动发现本地所有运行中的 CLI Agent（Claude Code、Codex CLI、Gemini CLI、Goose 等），支持在 AgentClaw 中建会话透传消息。

### 需求

3.1 **自动发现**
- 启动时扫描本地进程的 ACP 握手端口（`.well-known` 模式）
- 通过 HTTP 请求获取 agent 元信息：类型、模型、状态、能力
- 周期性健康检查，检测 agent 上下线
- 支持检测：Claude Code、Codex CLI、Gemini CLI、Goose、Genkit 等

3.2 **会话透传**
- 用户建会话时可选 backend type：`native` | `acp`
- 选 `acp` → 展示已发现的 CLI agent 列表 → 选一个 → 进入对话
- AgentClaw 做透明代理：WebSocket ↔ ACP HTTP，消息透传
- 会话历史持久化到 AgentClaw 的 memory

3.3 **ACP 会话可用的 AgentClaw 能力**
- 会话历史持久化 ✅
- 渠道延续（在飞书/Telegram 继续 ACP 会话） ✅
- Behavior Policy 中的 model 配置（选择 ACP agent 作为执行后端）

3.4 **ACP 会话不可用的 AgentClaw 能力**
- tools（ACP agent 用自己的工具）
- memory（可用，agent 自己管理）
- skills（ACP agent 不感知 AgentClaw 技能）
- Behavior Policy 工具白名单（ACP agent 不归 AgentClaw 管）

3.5 **UI**
- ACP 状态栏：已检测 agent 列表 + 连接状态
- 建会话时 backend type 选择器
- ACP agent 头像/名称/模型信息展示

---

## 四、MCP 统一管理 UI（P1）

### 目标
在 UI 中可视化配置 MCP 服务器，所有 agent 共享 MCP 工具。

### 需求

4.1 **MCP 服务管理**
- 新增 MCP 服务器配置（name / command / args / env）
- 启动/停止/重启 MCP 服务
- MCP 服务状态监控（`TeamMcpPhase` 状态机）

4.2 **MCP 注入管线**
- 状态机：tcp_ready → session_injecting → session_ready
- 错误处理：tcp_error / session_error / load_failed / degraded
- 超时重试机制

4.3 **UI**
- MCP 配置页：服务列表 + 状态指示 + 新增/编辑/删除
- MCP 服务详情：工具列表 + 连接状态 + 日志
- Dashboard 上显示 MCP 整体健康状态

---

## 五、Cron 24/7 + 防休眠（P2）

### 目标
支持自然语言排班定时任务，agent 在后台 24 小时无人值守运行。

### 需求

5.1 **自然语言排班**
- 用户说 "每周一早 9 点分析销售数据并生成报告"
- 解析为 cron 表达式 + agent task
- 支持的粒度：一次性、每日、每周、每月、自定义 cron

5.2 **Keep-awake 机制**
- 防止系统休眠影响定时任务执行
- 通过系统调用或 server 端保活

5.3 **漏算补发**
- 系统唤醒后检测错过的定时任务
- 自动补发未执行的 task

5.4 **Task 与 Cron 的关系**
- 定时任务 = cron 触发器 + task 模板
- 执行时创建新 task 实例，走 TaskSessionManager

5.5 **UI**
- 自动化页面：定时任务列表 + 状态 + 执行历史
- 创建任务：自然语言输入 → 预览 cron 表达式 → 确认
- task 模板选择 / 自定义 prompt

---

## 六、技能市场/注册表（P2）

### 目标
引入技能市场机制，支持发现、安装、共享技能。

### 需求

6.1 **技能注册表**
- 全局技能 registry（本地 + 可扩展）
- 技能来源：内置、本地 skills/、workspace skills/、远程 hub（远期）
- 技能元信息：name、description、version、author、tags

6.2 **技能安装/卸载**
- 浏览可用技能列表
- 一键安装到当前 workspace
- 卸载不影响其他 workspace

6.3 **UI**
- 技能市场页面：搜索 + 分类 + 安装按钮
- 技能详情：描述 + 版本 + 依赖
- 已安装/可安装状态标识

---

## 七、团队多 Agent 协作（P2）

### 目标
支持 Leader-Teammate 多 agent 协作模式，teammate 可扩展为通道渠道执行节点。

### 需求

7.1 **团队数据结构**
```typescript
type Team = {
  id: string;
  name: string;
  workspace: string;
  leaderAgentId: string;
  agents: TeamAgent[];
  workspaceMode: 'shared' | 'isolated';
  createdAt: number;
  updatedAt: number;
};

type TeamAgent = {
  slotId: string;
  conversationId: string;
  role: 'leader' | 'teammate';
  agentType: 'native' | 'acp';
  agentName: string;
  status: 'pending' | 'idle' | 'active' | 'completed' | 'failed';
  policy: BehaviorPolicy;  // 每个 teammate 独立 policy
  // ACP 相关
  cliPath?: string;
  customAgentId?: string;
};
```

7.2 **Leader 驱动编排**
- Leader 接收人类指令，拆解子任务
- 通过 team MCP server 派发给 teammate
- Teammate 间通过异步消息通信
- 共享 workspace（可选）或独立 workspace

7.3 **通道延续任务**
- 用户在飞书/Telegram/钉钉发消息
- 查询该用户是否有未完成的团队任务
- 有 → 继续执行 / 分配 teammate 处理
- 消息流经 channel → gateway → team session

7.4 **事件体系**
- `team.agent.status` — agent 状态变更
- `team.agent.spawned` — 新 agent 加入
- `team.agent.removed` — agent 移除
- `team.teammate.message` — agent 间消息
- `team.message` — agent 消息流到前端

---

## 八、IPC Bridge / 远程同步（P3）

### 目标
AgentClaw 支持远程客户端模式：主机（运行 gateway）↔ 远程 WebUI / 桌面端，会话数据同步，远程可继续主机上的任务。

### 需求

8.1 **同步协议**
- 主机暴露同步 API（REST + WS）
- 客户端拉取：session 列表、任务状态、会话历史
- 双向 WS：实时推送状态变更

8.2 **远程操控**
- 远程 WebUI 可以查看主机上的 task session
- 接手未完成的 task
- 查看/继续 ACP 会话和 Native 会话

8.3 **认证**
- 远程连接需要 token 认证
- 可配置远程访问白名单

8.4 **当前基础设施**
- Session 持久化（SQLite memory） ✅
- TaskSessionManager ✅
- WS 实时推送 ✅
- 缺：同步 API、客户端连接逻辑、远程认证

---

## 九、体验优化（贯穿各阶段）

### 9.1 Token 消耗优化
| 项目 | 描述 | 优先级 |
|------|------|--------|
| Token 用量展示 | 每条消息显示 tokensIn/tokensOut | P1 |
| Session Token 预算 | 每个 session 可设 max_tokens，超出自动归档 | P1 |
| 长对话自动压缩 | 超阈值后压缩/截断历史，保留摘要 | P2 |

### 9.2 响应速度
| 项目 | 描述 | 优先级 |
|------|------|--------|
| 工具执行 elapsed | 长时间工具显示实时已用时间 | P1 |
| 并行工具可视化 | 多工具同时运行时分别展示进度 | P1 |
| 优先响应 | 简单问答跳过工具加载直接回复 | P2 |

### 9.3 UI 反馈
| 项目 | 方案 | 优先级 |
|------|------|--------|
| 骨架屏 | Boneyard（自动从 DOM 提取骨骼） | P1 |
| Toast 通知 | Sonner（应用内）+ Notification API（浏览器/桌面） | P1 |
| Thinking 超时提示 | >30s 显示"仍在处理…" | P1 |
| 文件上传进度 | 百分比进度条 | P2 |
| 逐字打字动画 | 字符级流式动画 | P2 |
| Toast 与系统通知联动 | 前台 Sonner / 后台 Notification API | P1 |

### 9.4 图标和 Logo
- 详见 `assets-需求清单.md`
- Logo 类 5 个：Favicon、App Logo、Team/Workspace/Task 空状态插画
- 图标类约 30 个：ACP、Behavior、SkillMarket、Cron、MCP、Team、Sync、Workspace、Agent 等

---

## 附录：优先级定义

| 优先级 | 含义 | 目标时间 |
|--------|------|---------|
| P0 | 核心基础，阻塞其他模块 | Phase B |
| P1 | 重要功能，可独立推进 | Phase C / D |
| P2 | 生态层，依赖 P0/P1 就绪 | Phase E / F |
| P3 | 基础设施，依赖 P2 | Phase F+ |

## 附录：执行阶段

| Phase | 模块 | 依赖 |
|-------|------|------|
| A | 提交 Phase 4-2 ~ 5-4 未推送代码 | 无 |
| B | Behavior Policy + Workspace 技能隔离 | 无 |
| C | ACP 集成 + MCP 管理 UI | Behavior Policy |
| D | 技能市场 + Cron 24/7 | Workspace 技能隔离 |
| E | 团队多 Agent 协作（含通道延续） | Behavior Policy + ACP |
| F | IPC Bridge / 远程同步 | 团队协作 |
