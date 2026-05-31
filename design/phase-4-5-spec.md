# Phase 4-2 ~ 5-4 规格文档

## Phase 4-2：工作流编辑器（WorkflowEditor）

### 目标
可视化拖拽编辑器，用户可创建、编辑 DAG 工作流。

### 交互流程
```
左侧 Palette → 拖拽节点到画布 → 连接节点边 → 属性面板编辑 → 导出 JSON
```

### 组件结构

```
WorkflowEditor (packages/web/src/components/WorkflowEditor.tsx)
├── Palette (左侧)
│   ├── 任务节点 (Task Node)
│   ├── 条件节点 (Condition Node)
│   └── 触发器节点 (Trigger Node)
├── ReactFlow Canvas (中间)
│   ├── 自定义节点 (WorkflowNode)
│   └── 自定义边 (WorkflowEdge)
├── PropertiesPanel (右侧，节点选中时显示)
│   ├── 名称
│   ├── 描述
│   ├── prompt (task 节点)
│   ├── condition (condition 节点)
│   └── trigger_type (trigger 节点)
└── Toolbar (顶部)
    ├── 导出 JSON
    ├── 导入 JSON
    └── 清除画布
```

### 节点类型

| 类型 | label | 颜色 | 属性 |
|------|-------|------|------|
| task | 任务节点 | green | name, description, prompt, expectedOutput |
| condition | 条件节点 | orange | name, description, condition |
| trigger | 触发器节点 | purple | name, triggerType (manual/cron/webhook) |

### 数据模型

```typescript
type WorkflowNodeData = {
  type: 'task' | 'condition' | 'trigger';
  label: string;
  description?: string;
  prompt?: string;          // task 专用
  condition?: string;       // condition 专用
  triggerType?: string;     // trigger 专用
  expectedOutput?: string;
};
```

### 快捷键
- `Delete` / `Backspace` — 删除选中节点或边
- 拖拽节点到 Palette 外 → 删除

### 状态
- 节点选中 → PropertiesPanel 显示
- 节点未选中 → PropertiesPanel 隐藏
- 边连接验证：不支持自循环

### CSS
- 文件：`WorkflowEditor.css`
- 主题：Slate + Green 暗色
- Palette：固定 240px 左侧栏，半透明毛玻璃背景

---

## Phase 5-0：任务列表

### 目标
从 API 拉取任务列表，按状态排序展示，支持选择和刷新。

### API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tasks` | 获取所有 task |
| POST | `/api/tasks/:id/stop` | 停止运行中的 task |

### 返回结构

```typescript
type TaskItem = {
  id: string;
  title: string;
  description?: string;
  status: 'queued' | 'running' | 'waiting_decision' | 'todo' | 'done' | 'failed';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  source?: string;
  createdAt?: string;
};
```

### 排序规则
```
queued → running → waiting_decision → todo → done → failed
```

### UI

```
┌─────────────────────────────┐
│ Task List          🔄 刷新   │
├─────────────────────────────┤
│ ⚪ [queued] 任务 A           │
│ 🔄 [running] 任务 B   ⏹ 停止 │
│ ⏳ [waiting] 任务 C          │
│ 📋 [todo] 任务 D             │
│ ✅ [done] 任务 E             │
│ ❌ [failed] 任务 F           │
└─────────────────────────────┘
```

- 状态 badge 用不同颜色标识
- running 状态显示 spinner
- running 状态可点击停止
- 点击 task 选中 → 驱动中心面板

---

## Phase 5-2：画布模式切换

### 目标
同一画布支持两种模式：View（只读执行态）和 Edit（编辑态），通过 toolbar 切换。

### 模式

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| View | 只读画布，不可拖拽/连接/编辑，显示执行状态 | 查看工作流执行进度 |
| Edit | 可拖拽创建/连接/编辑节点 | 创建和修改工作流 |

### 共享状态

```typescript
type WorkspaceState = {
  mode: 'view' | 'edit';
  steps: WorkflowStep[];        // 由 task list 选中项或 editor 提供
  edges: WorkflowEdge[];
  executionStatus?: Record<string, 'pending' | 'running' | 'done' | 'failed'>;
};
```

- View 模式：steps/edges 来自选中的工作流
- Edit 模式：steps/edges 来自编辑器当前内容

### 组件切换

```typescript
function WorkspacePage() {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  return (
    <>
      <Toolbar mode={mode} onToggle={() => setMode(mode === 'view' ? 'edit' : 'view')} />
      {mode === 'view'
        ? <WorkflowCanvas steps={steps} edges={edges} status={executionStatus} />
        : <WorkflowEditor steps={steps} edges={edges} onChange={handleChange} />
      }
    </>
  );
}
```

---

## Phase 5-3：预览面板

### 目标
右侧预览面板展示工作流执行产物（文件预览、artifact 列表）。

### 布局
```
┌──────────┬──────────────────┬──────────────┐
│ Task     │ Canvas           │ Preview       │
│ List     │ (Center)         │ Panel         │
│ (Left)   │                  │ (Right)       │
│ 280px    │ flex:1           │ 360px         │
└──────────┴──────────────────┴──────────────┘
```

### 内容

- **iframe 预览**：通过 `/preview/*` 路由渲染文件内容
- **Artifact 列表**：从 task 的 result 字段解析
  - 文件名
  - 文件类型（code / markdown / image / pdf 等）
  - 下载 / 查看操作
- **空状态**：无 artifact 时显示占位图 + "暂无产物"

### 切换
- 点击 artifact → 切换到预览 iframe
- 关闭按钮 → 回到 artifact 列表
- 面板可拖拽调整宽度

---

## Phase 5-4：Agent 引导工作流创建

### 目标
通过聊天输入自然语言创建和编辑工作流，agent 驱动用户完成设计。

### 交互流程

```
用户: "帮我创建一个代码审查工作流"
Agent: [创建初始工作流，展示在画布上]
        "我创建了一个 3 步工作流：lint 检查 → 单元测试 → 人工审核。需要调整吗？"
用户: "在 lint 前面加一个依赖安装步骤"
Agent: [更新画布，追加节点]
        "已添加。还需要其他修改吗？"
```

### 实现

- 用户在 workspace 页聊天输入框输入
- 消息发送到 `POST /api/sessions/:id/chat`
- Agent 返回中包含 workflow 操作指令
- 前端解析指令并更新画布
- 画布变更反映 agent 的工作流设计

### 聊天 vs 工作流画布联动

| 用户操作 | 效果 |
|---------|------|
| 聊天输入自然语言 | Agent 返回工作流修改 |
| 画布手动编辑 | Agent 感知变更，可在聊天中建议调整 |
| Chat 中确认 | 执行工作流 |

### UI 要点

- 聊天区和工作流画布同页展示
- 画布操作和聊天消息颜色一致（agent 消息突出显示）
- Agent 修改画布时，聊天中显示操作摘要
