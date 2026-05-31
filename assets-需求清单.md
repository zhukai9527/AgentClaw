# 图标 & Logo 需求清单

## Logo 类

| 用途 | 格式 | 数量 | 说明 |
|------|------|------|------|
| App Favicon | .png + .ico | 1 | 32×32 / 64×64，浏览器标签 + 桌面图标 |
| App Logo（欢迎页/设置页） | .png | 1 | 128×128，欢迎界面 + 关于页面 |
| Team Mode 空状态插画 | .svg | 1 | ~400×200，无团队时的占位配图 |
| Workspace 空状态插画 | .svg | 1 | ~400×200，无工作区时的占位配图 |
| Task 空状态插画 | .svg | 1 | ~400×200，无任务时的占位配图 |

## 图标类（SVG，18px stroke 风格，与现有 Icon* 统一）

| 图标名 | 用途 | 页面/组件 |
|--------|------|-----------|
| IconACP | ACP 远程 CLI Agent 检测 | ACP 管理页 |
| IconACPConnected | ACP Agent 已连接状态 | ACP 状态指示器 |
| IconACPDisconnected | ACP Agent 断开状态 | ACP 状态指示器 |
| IconBehavior | Behavior Policy 配置 | 策略配置页 |
| IconBehaviorPlan | plan 模式标识 | 策略选择器 |
| IconBehaviorAuto | auto 模式标识 | 策略选择器 |
| IconBehaviorChat | chat 模式标识 | 策略选择器 |
| IconSkillMarket | 技能市场入口 | 技能页导航 |
| IconSkillInstall | 技能安装 | 技能市场按钮 |
| IconSkillBuiltin | 内置技能标识 | 技能列表标签 |
| IconSkillWorkspace | 工作区技能标识 | 技能列表标签 |
| IconCron | 定时任务/24/7 自动化 | 自动化页 |
| IconMCPServer | MCP 服务管理 | MCP 配置页 |
| IconMCPConnected | MCP 服务已连接 | MCP 状态指示 |
| IconMCPError | MCP 服务异常 | MCP 状态指示 |
| IconTeam | 团队模式入口 | 侧边栏/导航 |
| IconTeamLeader | Team Leader 标识 | 团队视图 |
| IconTeammate | Team Teammate 标识 | 团队视图 |
| IconSync | 数据同步/远程连接 | 同步状态指示 |
| IconSyncPending | 同步待处理 | 同步状态指示 |
| IconSyncSuccess | 同步成功 | 同步状态指示 |
| IconSyncError | 同步失败 | 同步状态指示 |
| IconWorkspace | Workspace 切换 | 工作区选择器 |
| IconWorkspaceDefault | 默认 workspace 标识 | 工作区列表 |
| IconSkeleton | 骨架屏占位（可选） | 加载状态 |
| IconProgress | 进度/进行中 | 各类进度指示 |
| IconQueue | 排队等待 | 任务队列 |
| IconPending | 待处理 | 任务状态 |
| IconAgentNative | AgentClaw 原生 Agent 标识 | Agent 选择器 |
| IconAgentRemote | 远程 CLI Agent 标识 | Agent 选择器 |

## 合计

- Logo / 插画：5 个
- 图标：~30 个
- 优先级：Logo + 核心导航图标（IconTeam / IconWorkspace / IconBehavior / IconACP）优先，其余可分批交付
