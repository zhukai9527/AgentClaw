# Workspace Page — UI/UX Design Document

> Generated with ui-ux-pro-max design system.  
> Style: **Dark Mode (OLED)** | Primary: `#0F172A` | Accent: `#22C55E`  
> Typography: **Fira Code** (heading) + **Fira Sans** (body)

---

## 1. Design System

### 1.1 Color Tokens (CSS Custom Properties)

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-primary` | `#020617` | Main page background (OLED black) |
| `--bg-secondary` | `#0F172A` | Sidebar, panels, cards |
| `--bg-tertiary` | `#1E293B` | Hover states, elevated surfaces |
| `--border` | `#1E293B` | Dividers, card borders |
| `--accent` | `#22C55E` | Primary actions, active states, success |
| `--accent-hover` | `#16A34A` | Accent hover |
| `--accent-dim` | `rgba(34,197,94,0.12)` | Accent background tint |
| `--text-primary` | `#F8FAFC` | Primary text |
| `--text-secondary` | `#94A3B8` | Secondary text |
| `--text-muted` | `#64748B` | Placeholder, disabled, hints |
| `--danger` | `#EF4444` | Errors, destructive actions |
| `--warning` | `#F59E0B` | Warning states |
| `--info` | `#3B82F6` | Information, links |

### 1.2 Typography

- **Headings (h1-h6, labels, tabs)**: Fira Code, monospace
- **Body text**: Fira Sans, sans-serif
- **Code/data**: Fira Code, monospace
- **Scale**: 11px / 12px / 13px / 14px / 16px / 18px / 22px

### 1.3 Effects & Motion

| Element | Effect |
|---------|--------|
| Card hover | `border-color: var(--accent)`, 200ms transition |
| Button hover | `background: var(--accent-hover)` 或 `opacity: 0.9` |
| Focus ring | `box-shadow: 0 0 0 2px var(--accent)` |
| Modal overlay | `rgba(0,0,0,0.6)` backdrop, scale enter animation |
| Sidebar tab active | `border-bottom-color: var(--accent)` |
| Toast enter | slide-in-top 300ms ease |
| Skeleton pulse | `@keyframes pulse` opacity 0.4→0.8 |

### 1.4 Spacing Grid

- Base unit: 4px
- Content padding: 16px
- Card padding: 12px 14px
- Section gap: 8px
- List item gap: 4px

---

## 2. Layout Architecture

### 2.1 Page Structure

```
┌─────────────────────────────────────────────────────────────────────┐
│ PageHeader                                                          │
│ AgentClaw Workspace — [breadcrumb / active item label]              │
├──────────┬─────────────────────────────────────────┬────────────────┤
│ Sidebar  │ Main Area                               │ Inspect Panel  │
│ 280px    │ flex: 1                                 │ 0/320px        │
│          │                                         │ (collapsible)  │
│ ┌──────┐ │ ┌─────────────────────────────────────┐ │ ┌────────────┐ │
│ │Project│ │ │ Mode Bar: [Execute] [Edit] [Run]   │ │ │ Properties │ │
│ │ Info  │ │ └─────────────────────────────────────┘ │ │ / Details  │ │
│ ├──────┤ │ ┌─────────────────────────────────────┐ │ │            │ │
│ │Tabs   │ │ │                                     │ │ │ Canvas     │ │
│ │[Tasks]│ │ │  Canvas Area                        │ │ │ node props │ │
│ │[WFs]  │ │ │  (WorkflowCanvas / WorkflowEditor)  │ │ │ Task meta  │ │
│ ├──────┤ │ │                                     │ │ │ Artifacts  │ │
│ │List   │ │ │                                     │ │ │            │ │
│ │items  │ │ └─────────────────────────────────────┘ │ └────────────┘ │
│ │       │ │ ┌─────────────────────────────────────┐ │                │
│ │       │ │ │ Chat Panel                          │ │                │
│ │       │ │ │ [messages]                          │ │                │
│ │       │ │ │ [input________________] [Send]      │ │                │
│ └──────┘ │ └─────────────────────────────────────┘ │                │
└──────────┴─────────────────────────────────────────┴────────────────┘
```

### 2.2 Column Behavior

| Column | Width | Behavior |
|--------|-------|----------|
| Sidebar | 280px fixed | Always visible when workspace active |
| Main | `flex: 1` min-width: 480px | Always visible when workspace active |
| Inspect | 0→320px toggle | Hidden by default, slides open on selection |

### 2.3 Responsive Breakpoints

| Breakpoint | Behavior |
|------------|----------|
| ≥1200px | 3 columns (sidebar + main + inspect) |
| 800-1199px | 2 columns (sidebar collapsed to icons + main + inspect overlay) |
| <800px | Single column with tab bar at bottom, inspect as drawer |

### 2.4 Inspect Panel Toggle

- **Closed** (default): Main area takes full width, inspect panel button visible in mode bar
- **Open**: Inspect panel slides in from right, main area shrinks
- Panel content context-sensitive:
  - Workflow selected: node properties, step details
  - Task selected: task metadata, artifacts, logs
  - Nothing selected: contextual help / quick actions

---

## 3. Navigation Model

### 3.1 Top-LevelPage Tabs (Sidebar)

```
┌─────────────────────┐
│ [Tasks]  [Workflows]│  ← sidebar tabs, mutually exclusive
└─────────────────────┘
```

- **Tasks tab**: Shows managed task list with status badges
- **Workflows tab**: Shows workflow definitions from workspace/ YAML

### 3.2 Mode Bar (Main Area)

```
┌──────────────────────────────────────────────────────────────┐
│ [Execute] [Edit]  │  [Run]  │  workflow-name / task-title   │
└──────────────────────────────────────────────────────────────┘
```

- **Execute**: Read-only canvas view (no drag/drop)
- **Edit**: Full editor with palette, drag-drop, properties
- **Run**: Execute the current workflow (triggers task execution)
- Right side: Current workflow or task label

### 3.3 Selection Flow

```
Sidebar Item Click
  ↓
If Task selected → Load task details → Show chat history
  → Switch mode bar to task context → Enable Run
If Workflow selected → Load YAML definition → Render canvas
  → Show workflow name in mode bar → Enable Execute/Edit/Run
```

### 3.4 Breadcrumb (PageHeader)

```
Workspace Name › Workflows › workflow-name
                › Tasks    › task-name
```

- Click any segment to navigate up
- Shows current context clearly

---

## 4. Sidebar Design

### 4.1 Workspace Info Section

```
┌─────────────────────────────┐
│ ncbs-apstack-workspace      │  ← project name (accent color)
│ D:\...\ncbs-apstack-ws      │  ← full path (muted, truncated)
│ [● Active]                  │  ← status indicator
├─────────────────────────────┤
│ projects found: 3           │  ← optional, collapsible
│ ├─ service-api              │
│ ├─ web-app                  │
│ └─ shared-lib               │
└─────────────────────────────┘
```

### 4.2 Task List

```
┌─────────────────────────────────┐
│ [Tasks]  [Workflows]            │  ← sidebar tabs
├─────────────────────────────────┤
│ 🔍 Filter tasks...              │  ← search input
├─────────────────────────────────┤
│ ● Build API Gateway        Run  │  ← status dot + title + badge
│   └─ 3 steps · 2m ago          │  ← meta line
│ ○ Fix auth middleware      Todo │
│   └─ 1 step · created now       │
│ ○ Deploy to prod           Todo │
│   └─ 5 steps · yesterday        │
│ ⏳ Optimize queries      Wait   │
├─────────────────────────────────┤
│ [+ New Task]                    │  ← bottom action button
└─────────────────────────────────┘
```

### 4.3 Workflow List

```
┌─────────────────────────────────┐
│ [Tasks]  [Workflows]            │
├─────────────────────────────────┤
│ 🔍 Filter workflows...          │
├─────────────────────────────────┤
│ 📄 ci-pipeline.yml         Edit │
│   └─ 4 steps, 3 edges          │
│ 📄 deploy-flow.yml         Edit │
│   └─ 6 steps, 5 edges          │
│ 📄 code-review.yml         Edit │
│   └─ 3 steps, 2 edges          │
├─────────────────────────────────┤
│ [+ New Workflow]                │  ← opens blank editor
└─────────────────────────────────┘
```

### 4.4 Status Indicator System

| Status | Dot | Badge |
|--------|-----|-------|
| Queued | ○ gray | `#64748B` |
| Running | ● green pulse | `#22C55E` + spinner |
| Waiting decision | ● yellow | `#F59E0B` |
| Todo | ○ gray | `#94A3B8` |
| Done | ● green | `#16A34A` |
| Failed | ● red | `#EF4444` |

---

## 5. Main Area Design

### 5.1 Empty States

#### No Task / No Workflow Selected

```
┌──────────────────────────────────────────┐
│                                          │
│             ⚡ (accent icon)              │
│                                          │
│        Ready to build something?         │
│                                          │
│   Select a task or workflow from the     │
│   sidebar, or type a message below to    │
│   create one with AI assistance.         │
│                                          │
│   [Quick Start: Deploy flow]             │
│   [Quick Start: Code review]             │
│                                          │
└──────────────────────────────────────────┘
```

#### No Tasks Yet

```
┌──────────────────────────────────────────┐
│  No tasks yet                            │
│  Create a task to start working          │
│  [+ New Task]                            │
└──────────────────────────────────────────┘
```

#### No Workflows Yet

```
┌──────────────────────────────────────────┐
│  No workflow files found                 │
│  Add .yaml files to the workflows/       │
│  directory, or create one in the editor. │
│  [+ New Workflow]  [Learn about format] │
└──────────────────────────────────────────┘
```

### 5.2 Canvas Area

#### Execute Mode
- Read-only ReactFlow view
- Node colors: green (success), red (failed), yellow (running), gray (pending)
- MiniMap in bottom-right corner
- Controls (zoom, fit) in bottom-left
- Background grid dots

#### Edit Mode
- Palette on left side (vertical strip, collapsible)
- Drag-and-drop node creation
- Edge creation by dragging between handles
- Click node → opens properties in inspect panel
- Double-click node → inline rename
- Delete selected node with Backspace/Delete key
- Auto-layout button in toolbar

#### Run Mode
- 🔴 Recording indicator when executing
- Node status updates in real-time
- Animated edge highlights during execution
- Console/log output below canvas (expandable)

### 5.3 Chat Panel

#### Layout
- Fixed height: `min-content`, max 40% of viewport
- Resizable via drag handle at top
- Messages: compact, monospace code blocks, minimal avatars
- Input: single-line, expands to max 4 lines with Shift+Enter

#### Message Types
| Icon | Type | Style |
|------|------|-------|
| User | `#22C55E` accent dot | Fira Sans body |
| Agent | `#3B82F6` dot | Fira Sans body + code blocks |
| System | `#94A3B8` dot | Italic, muted |
| Error | `#EF4444` dot | Red border-left |

#### Session Continuity
- Chat messages persist per task
- Switching tasks swaps chat history
- Session ID stored in task state
- WebSocket subscribes for real-time streaming

---

## 6. Modals & Overlays

### 6.1 Import Workspace Modal

```
┌───────────────────────────────────────┐
│ Import Workspace                [×]   │
├───────────────────────────────────────┤
│ Import a Git repo or local directory  │
│ to use as a workspace.                │
│                                       │
│ [Git URL] [Local Path]  ← tabs       │
│                                       │
│ ── Tab: Git URL ──                   │
│ │ URL: [__________________________]  │
│ │ e.g. https://github.com/...        │
│ ───────────────────────────────────── │
│                                       │
│ ── Tab: Local Path ──                │
│ │ [←] [📁 D:\project\... ] [Drives] │
│ │ ───────────────────────────────── │
│ │ 📁 .git                  [Select] │
│ │ 📁 src                   [Select] │
│ │ 📁 node_modules          [Select] │
│ │ 📄 package.json                   │
│ │ Selected: D:\project\my-app       │
│ ───────────────────────────────────── │
│                                       │
│            [Cancel]  [Import]         │
└───────────────────────────────────────┘
```

### 6.2 Workflow Export/Import Modal (existing, keep as-is)

### 6.3 Confirm Delete Modal

```
┌───────────────────────────────────────┐
│ Delete Workflow?                 [×]  │
├───────────────────────────────────────┤
│ Are you sure you want to delete       │
│ "ci-pipeline.yml"?                    │
│ This action cannot be undone.         │
│                                       │
│       [Cancel]  [Delete]              │
└───────────────────────────────────────┘
```

### 6.4 New Task Modal

```
┌───────────────────────────────────────┐
│ New Task                         [×]  │
├───────────────────────────────────────┤
│ Title: [_________________________]   │
│                                       │
│ Description:                          │
│ [_________________________________]  │
│ [_________________________________]  │
│                                       │
│ Priority: [Medium      ▼]            │
│                                       │
│       [Cancel]  [Create]              │
└───────────────────────────────────────┘
```

---

## 7. Interaction Patterns

### 7.1 Workflow Lifecycle

```
                ┌──────────────┐
                │ New Workflow │
                │ (from UI)    │
                └──────┬───────┘
                       │
                ┌──────▼───────┐
         ┌──────│ Edit Canvas  │──────┐
         │      └──────┬───────┘      │
         │             │              │
    ┌────▼────┐  ┌─────▼──────┐  ┌───▼────┐
    │ Execute │  │ Save .yaml │  │ Export │
    │ (read)  │  │ (persist)  │  │ (JSON) │
    └────┬────┘  └─────┬──────┘  └────────┘
         │             │
    ┌────▼─────────────▼──────┐
    │ Run (create task + exec)│
    └────┬────────────────────┘
         │
    ┌────▼────┐
    │ Monitor │
    │ (live)  │
    └─────────┘
```

### 7.2 Task Lifecycle

```
     ┌──────────┐
     │ New Task │
     └────┬─────┘
          │
    ┌─────▼──────┐
    │ Queued     │
    └─────┬──────┘
          │
    ┌─────▼──────┐
    │ Running    │────→ [Wait Decision]
    └─────┬──────┘         │
          │                │
          ├────────────────┘
          │
    ┌─────▼──────┐    ┌──────────┐
    │   Done     │    │  Failed  │
    └────────────┘    └──────────┘
```

### 7.3 Chat → Task Creation

```
User types: "Create a deploy pipeline"
  ↓
Create task with title "Create a deploy pipeline"
  ↓
POST /api/sessions → get session id
  ↓
POST /api/sessions/:id/chat → send message
  ↓
Agent responds with workflow steps
  ↓
Option to "Apply as workflow" → creates .yaml
```

### 7.4 Save Workflow

```
User clicks Save in editor
  ↓
POST /api/workspace/workflows/:name
  ↓
Show success toast
  ↓
Refresh workflow list
  ↓
If error → show inline error with retry
```

---

## 8. State Management

### 8.1 Loading States

| Component | Loading State |
|-----------|--------------|
| Sidebar list | Skeleton rows (3-5 pulsing lines) |
| Canvas | Skeleton card with pulsing border |
| Chat | "Thinking..." with animated dots |
| Directory browser | Spinner in list area |
| Import button | "Importing..." disabled state |

### 8.2 Error States

| Scenario | UX |
|----------|-----|
| Workspace load fail | Toast "Failed to load workspace" + retry button |
| Task fetch fail | Inline "Failed to load tasks" + retry link |
| Workflow list fail | Inline error in workflow tab |
| Import fail | Red error message in modal |
| Chat fail | "Failed to send message" toast |
| Save workflow fail | Inline error in editor + retry |
| API unreachable | Global toast "Server unreachable" |

### 8.3 Empty States (All)

| Location | Empty Message | Action |
|----------|--------------|--------|
| Workspace (no import) | "No workspace imported yet" | Import button |
| Sidebar tasks | "No tasks yet" | + New Task button |
| Sidebar workflows | "No workflow files found" | + New Workflow / Learn link |
| Main area | "Select a task or workflow" | Quick start buttons |
| Chat | Contextual placeholder text | Type to begin |
| Inspect panel | "Select a node to inspect" | - |
| Directory empty | "This folder is empty" | - |

---

## 9. Component Hierarchy

```
WorkspacePage
├── PageHeader (breadcrumb)
├── ws-layout
│   ├── Sidebar
│   │   ├── WorkspaceInfo (project name, path, status)
│   │   ├── TargetProjects (collapsible list)
│   │   ├── SidebarTabs (Tasks | Workflows)
│   │   ├── SearchBar (filter list)
│   │   ├── TaskList or WorkflowList
│   │   │   ├── TaskItem (title, status dot, badge, meta)
│   │   │   └── WorkflowItem (name, step count, edit btn)
│   │   └── SidebarAction (+ New Task / + New Workflow)
│   ├── MainArea
│   │   ├── ModeBar (Execute | Edit | Run + label)
│   │   ├── CanvasArea
│   │   │   ├── WorkflowCanvas (read-only ReactFlow)
│   │   │   └── WorkflowEditor (drag-drop + palette)
│   │   └── ChatPanel
│   │       ├── ChatMessages (scrollable)
│   │       ├── ChatInput (expandable textarea)
│   │       └── SendButton
│   └── InspectPanel (collapsible)
│       ├── PropertiesPanel (node properties form)
│       ├── TaskMeta (details, artifacts, logs)
│       └── ContextualHelp
└── Modals
    ├── ImportModal
    ├── NewTaskModal
    ├── ConfirmDeleteModal
    ├── WorkflowExportModal
    └── WorkflowImportModal
```

---

## 10. API Design (Required New Endpoints)

| Method | Path | Purpose |
|--------|------|---------|
| `PUT` | `/api/workspace/workflows/:name` | Save/update workflow YAML |
| `DELETE` | `/api/workspace/workflows/:name` | Delete workflow YAML |
| `POST` | `/api/workspace/workflows/:name/run` | Execute workflow → create task |
| `POST` | `/api/workspace/tasks` | Create a new task |
| `GET` | `/api/workspace/tasks/:id/session` | Get task session ID |
| `GET` | `/api/workspace/search?q=` | Search tasks/workflows |

---

## 11. Implementation Priority

### P0 (Must have — current gaps)
- Workflow save/persist (PUT endpoint + editor save button)
- Workflow delete (DELETE endpoint + confirm dialog)
- Workflow run (POST run endpoint + Run button)
- Task creation UI (New Task modal)
- Error toasts for silent failures
- Proper loading skeletons (not just text)

### P1 (Should have)
- Inspect panel toggle + content
- Search/filter in sidebar
- Chat session continuity per task
- WebSocket real-time updates

### P2 (Nice to have)
- Undo/redo in workflow editor
- Auto-layout button
- Mobile responsive breakpoints
- Keyboard shortcuts
- Drag-drop file import

---

## 12. Visual Design Rules

### 12.1 Do
- Use SVG icons (Lucide) — NO emojis as UI icons
- Use `cursor-pointer` on all interactive elements
- Use 200ms transitions on hover states
- Show clear active/selected states
- Reserve space for async content to prevent layout shift
- Use skeleton loaders for list content
- Toast for success/error feedback (auto-dismiss 3s)
- Confirm before destructive actions

### 12.2 Don't
- Silent catch blocks (always show error feedback)
- Emoji icons in UI
- Layout shift when content loads
- Empty blank screens (always show empty state)
- Scale transforms on hover (causes layout shift)
- Toasts that never dismiss

### 12.3 Accessibility
- Focus rings on all interactive elements
- `prefers-reduced-motion` respected
- Color is not the only status indicator (use icons + text)
- Keyboard navigation (Tab, Enter, Escape)
- Sufficient contrast (4.5:1 minimum for text)
