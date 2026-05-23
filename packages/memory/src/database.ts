import { createDatabase, type DbAdapter } from "./db-adapter.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  active_leaf_turn_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  parent_id TEXT REFERENCES turns(id),
  branch_id TEXT NOT NULL DEFAULT 'main',
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_results TEXT,
  reasoning_content TEXT,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  duration_ms INTEGER,
  tool_call_count INTEGER,
  trace_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('identity', 'fact', 'preference', 'entity', 'episodic')),
  content TEXT NOT NULL,
  source_turn_id TEXT REFERENCES turns(id),
  importance REAL NOT NULL DEFAULT 0.5,
  embedding BLOB,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
  access_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  instructions TEXT DEFAULT '',
  color TEXT DEFAULT '#6B7F5E',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS chat_targets (
  platform TEXT NOT NULL,
  target_id TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, target_id)
);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_input TEXT NOT NULL,
  system_prompt TEXT,
  skill_match TEXT,
  steps TEXT NOT NULL DEFAULT '[]',
  response TEXT,
  model TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at DESC);

-- Shell background jobs (long-running user-visible tool work)
CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  pid INTEGER,
  conversation_id TEXT,
  trace_id TEXT,
  agent_id TEXT,
  exit_code INTEGER,
  output TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status);
CREATE INDEX IF NOT EXISTS idx_background_jobs_started ON background_jobs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_background_jobs_conversation ON background_jobs(conversation_id);

-- Task management (human & bot shared)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('inbox', 'todo', 'in_progress', 'triaged', 'queued', 'running', 'done', 'failed', 'blocked', 'waiting_decision')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal', 'medium', 'low')),
  due_date TEXT,
  assignee TEXT NOT NULL DEFAULT 'human',
  created_by TEXT NOT NULL DEFAULT 'human',
  session_id TEXT,
  trace_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);

-- Task DAG dependencies (task A depends on task B)
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id != depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(depends_on_id);

-- Sub-agent execution records (real-time + historical)
CREATE TABLE IF NOT EXISTS subagents (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  goal TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'killed')),
  result TEXT,
  error TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tools_used TEXT NOT NULL DEFAULT '[]',
  iterations INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_subagents_session ON subagents(session_id);
CREATE INDEX IF NOT EXISTS idx_subagents_created ON subagents(created_at DESC);

-- Skill usage telemetry (procedural memory feedback loop)
CREATE TABLE IF NOT EXISTS skill_usage (
  skill_id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT NOT NULL,
  last_error TEXT,
  agent_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skill_usage_last_used ON skill_usage(last_used_at DESC);

-- Skill lifecycle history (create/patch/archive/delete/backup/curate)
CREATE TABLE IF NOT EXISTS skill_changes (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  action TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  before_hash TEXT,
  after_hash TEXT,
  path TEXT,
  error TEXT,
  agent_id TEXT,
  evolution_run_id TEXT,
  trace_id TEXT,
  conversation_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skill_changes_skill ON skill_changes(skill_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_changes_created ON skill_changes(created_at DESC);

-- 进化账本：能力变更的不可变审计主线
CREATE TABLE IF NOT EXISTS evolution_runs (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  result TEXT NOT NULL DEFAULT 'unknown',
  reason TEXT,
  trigger_trace_id TEXT,
  trigger_conversation_id TEXT,
  baseline_score REAL,
  after_score REAL,
  regression_count INTEGER NOT NULL DEFAULT 0,
  eval_report_path TEXT,
  rollback_path TEXT,
  agent_id TEXT,
  metadata TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evolution_runs_target ON evolution_runs(target_type, target_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_runs_status ON evolution_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS evolution_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evolution_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  trace_id TEXT,
  change_id TEXT,
  before_hash TEXT,
  after_hash TEXT,
  score_before REAL,
  score_after REAL,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evolution_events_run ON evolution_events(run_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_evolution_events_trace ON evolution_events(trace_id);

-- Observation Store：工具/环境输出的可去重原始观察记录
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  raw_path TEXT NOT NULL,
  preview TEXT NOT NULL,
  facts TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  raw_chars INTEGER NOT NULL,
  prompt_chars INTEGER NOT NULL,
  saved_chars INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash);
CREATE INDEX IF NOT EXISTS idx_observations_trace_step ON observations(trace_id, step_id);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at DESC);

CREATE TABLE IF NOT EXISTS observation_reads (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  trace_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  query TEXT,
  offset INTEGER,
  length INTEGER,
  returned_chars INTEGER NOT NULL,
  read_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_observation_reads_observation ON observation_reads(observation_id, read_at ASC);
CREATE INDEX IF NOT EXISTS idx_observation_reads_trace ON observation_reads(trace_id, step_id);

-- Memory usage telemetry: records which memories actually reached agent context
CREATE TABLE IF NOT EXISTS memory_usage (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  conversation_id TEXT,
  trace_id TEXT,
  agent_id TEXT,
  metadata TEXT,
  used_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_usage_memory ON memory_usage(memory_id, used_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_usage_conversation ON memory_usage(conversation_id, used_at DESC);

-- Agent profiles (persona with custom soul, model, tools)
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  soul TEXT NOT NULL DEFAULT '',
  model TEXT,
  tools TEXT,
  max_iterations INTEGER,
  temperature REAL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Key-value settings store
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scheduled tasks (cron automations, persisted across restarts)
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  action TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  one_shot INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 full-text search index for hybrid memory retrieval (BM25 + vector)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  content,
  tokenize='unicode61'
);

-- FTS5 full-text search index for conversation history (context_search tool)
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  id UNINDEXED,
  conversation_id UNINDEXED,
  content,
  tokenize='unicode61'
);
`;

/**
 * Initialize (or open) a SQLite database at the given path
 * and ensure all required tables exist.
 */
export function initDatabase(dbPath: string): DbAdapter {
  // createDatabase 内部已执行 WAL + foreign_keys PRAGMA
  const db = createDatabase(dbPath);

  // Execute schema creation
  db.exec(SCHEMA_SQL);

  // Migrations: add columns to existing tables
  addColumnIfMissing(db, "turns", "trace_id", "TEXT");
  addColumnIfMissing(db, "turns", "duration_ms", "INTEGER");
  addColumnIfMissing(db, "turns", "tool_call_count", "INTEGER");
  addColumnIfMissing(db, "turns", "parent_id", "TEXT");
  addColumnIfMissing(db, "turns", "branch_id", "TEXT NOT NULL DEFAULT 'main'");
  addColumnIfMissing(db, "conversations", "active_leaf_turn_id", "TEXT");
  addColumnIfMissing(db, "sessions", "title", "TEXT");
  addColumnIfMissing(db, "sessions", "status", "TEXT DEFAULT 'done'");
  // Fix: old migration used DEFAULT 'active', bulk-correct existing rows
  db.exec(
    "UPDATE sessions SET status = 'done' WHERE status = 'active' AND last_active_at < datetime('now', '-1 hour')",
  );
  addColumnIfMissing(
    db,
    "sessions",
    "project_id",
    "TEXT REFERENCES projects(id) ON DELETE SET NULL",
  );

  // Create index after migration ensures column exists
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, last_active_at DESC)",
    );
  } catch {
    // Index may already exist
  }

  // Migration: rebuild tasks table to update CHECK constraint for new statuses
  rebuildTasksTableIfNeeded(db);

  // Task Manager v2 migrations: extend tasks table for execution engine
  addColumnIfMissing(db, "tasks", "executor", "TEXT DEFAULT 'human'");
  addColumnIfMissing(db, "tasks", "source", "TEXT DEFAULT 'web'");
  addColumnIfMissing(db, "tasks", "source_msg_id", "TEXT");
  addColumnIfMissing(db, "tasks", "scheduled_at", "TEXT");
  addColumnIfMissing(db, "tasks", "deadline", "TEXT");
  addColumnIfMissing(db, "tasks", "recurrence", "TEXT");
  addColumnIfMissing(db, "tasks", "parent_id", "TEXT");
  addColumnIfMissing(db, "tasks", "result", "TEXT");
  addColumnIfMissing(db, "tasks", "decision_context", "TEXT");
  addColumnIfMissing(db, "tasks", "decision_options", "TEXT");
  addColumnIfMissing(db, "tasks", "decision_result", "TEXT");
  addColumnIfMissing(db, "tasks", "trace_ids", "TEXT DEFAULT '[]'");
  addColumnIfMissing(db, "tasks", "progress", "INTEGER DEFAULT 0");
  addColumnIfMissing(db, "tasks", "completed_at", "TEXT");
  addColumnIfMissing(db, "tasks", "metadata", "TEXT");

  // Traces: add channel and agent_id columns
  addColumnIfMissing(db, "traces", "channel", "TEXT");
  addColumnIfMissing(db, "traces", "agent_id", "TEXT DEFAULT 'default'");
  // Traces: add prompt cache token columns
  addColumnIfMissing(
    db,
    "traces",
    "cache_creation_tokens",
    "INTEGER DEFAULT 0",
  );
  addColumnIfMissing(db, "traces", "cache_read_tokens", "INTEGER DEFAULT 0");
  addColumnIfMissing(db, "turns", "reasoning_content", "TEXT");

  // 进化账本：为已有 skill_changes 表补齐审计关联字段
  addColumnIfMissing(db, "skill_changes", "evolution_run_id", "TEXT");
  addColumnIfMissing(db, "skill_changes", "trace_id", "TEXT");
  addColumnIfMissing(db, "skill_changes", "conversation_id", "TEXT");

  // Observation Store：兼容已存在的早期/部分表结构
  addColumnIfMissing(
    db,
    "observations",
    "trace_id",
    "TEXT NOT NULL DEFAULT ''",
  );
  addColumnIfMissing(db, "observations", "step_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(
    db,
    "observations",
    "tool_name",
    "TEXT NOT NULL DEFAULT ''",
  );
  addColumnIfMissing(
    db,
    "observations",
    "input_hash",
    "TEXT NOT NULL DEFAULT ''",
  );
  addColumnIfMissing(
    db,
    "observations",
    "content_hash",
    "TEXT NOT NULL DEFAULT ''",
  );
  addColumnIfMissing(
    db,
    "observations",
    "raw_path",
    "TEXT NOT NULL DEFAULT ''",
  );
  addColumnIfMissing(db, "observations", "preview", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "observations", "facts", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(
    db,
    "observations",
    "metadata",
    "TEXT NOT NULL DEFAULT '{}'",
  );
  addColumnIfMissing(
    db,
    "observations",
    "raw_chars",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    db,
    "observations",
    "prompt_chars",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    db,
    "observations",
    "saved_chars",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    db,
    "observations",
    "created_at",
    "TEXT NOT NULL DEFAULT ''",
  );
  addColumnIfMissing(
    db,
    "observation_reads",
    "observation_id",
    "TEXT NOT NULL DEFAULT ''",
  );
  addColumnIfMissing(
    db,
    "observation_reads",
    "trace_id",
    "TEXT NOT NULL DEFAULT ''",
  );
  addColumnIfMissing(
    db,
    "observation_reads",
    "step_id",
    "TEXT NOT NULL DEFAULT ''",
  );
  addColumnIfMissing(db, "observation_reads", "query", "TEXT");
  addColumnIfMissing(db, "observation_reads", "offset", "INTEGER");
  addColumnIfMissing(db, "observation_reads", "length", "INTEGER");
  addColumnIfMissing(
    db,
    "observation_reads",
    "returned_chars",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    db,
    "observation_reads",
    "read_at",
    "TEXT NOT NULL DEFAULT ''",
  );

  addColumnIfMissing(
    db,
    "memory_usage",
    "memory_id",
    "TEXT NOT NULL DEFAULT ''",
  );
  addColumnIfMissing(
    db,
    "memory_usage",
    "source",
    "TEXT NOT NULL DEFAULT 'prompt_injection'",
  );
  addColumnIfMissing(db, "memory_usage", "conversation_id", "TEXT");
  addColumnIfMissing(db, "memory_usage", "trace_id", "TEXT");
  addColumnIfMissing(db, "memory_usage", "agent_id", "TEXT");
  addColumnIfMissing(db, "memory_usage", "metadata", "TEXT");
  addColumnIfMissing(db, "memory_usage", "used_at", "TEXT NOT NULL DEFAULT ''");

  // Create indexes for migration-added columns (must run after addColumnIfMissing)
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_executor ON tasks(executor);
      CREATE INDEX IF NOT EXISTS idx_turns_parent ON turns(conversation_id, parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash);
      CREATE INDEX IF NOT EXISTS idx_observations_trace_step ON observations(trace_id, step_id);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_observation_reads_observation ON observation_reads(observation_id, read_at ASC);
      CREATE INDEX IF NOT EXISTS idx_observation_reads_trace ON observation_reads(trace_id, step_id);
      CREATE INDEX IF NOT EXISTS idx_memory_usage_memory ON memory_usage(memory_id, used_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_usage_conversation ON memory_usage(conversation_id, used_at DESC);
    `);
  } catch {
    // Indexes may already exist
  }

  // Hive: knowledge_chunks table for static file RAG
  ensureKnowledgeChunksTable(db);

  // Hive: add namespace column for per-agent memory isolation
  addColumnIfMissing(
    db,
    "memories",
    "namespace",
    "TEXT NOT NULL DEFAULT 'default'",
  );
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace)",
    );
  } catch {
    // Index may already exist
  }

  // Migration: rebuild memories table if CHECK constraint doesn't include 'identity'
  rebuildMemoriesTableIfNeeded(db);

  // Migration: populate FTS5 index from existing memories (one-time sync)
  const ftsCount = countRows(db, "memories_fts");
  const memCount = countRows(db, "memories");
  if (ftsCount === 0 && memCount > 0) {
    db.exec(
      "INSERT INTO memories_fts (id, content) SELECT id, content FROM memories",
    );
  }

  // Migration: populate turns FTS5 index (one-time sync)
  const turnsFtsCount = countRows(db, "turns_fts");
  const turnsCount = countRows(db, "turns");
  if (turnsFtsCount === 0 && turnsCount > 0) {
    db.exec(
      "INSERT INTO turns_fts (id, conversation_id, content) SELECT id, conversation_id, content FROM turns",
    );
  }

  return db;
}

/**
 * Rebuild memories table if CHECK constraint doesn't include 'identity'.
 * SQLite does not support ALTER CHECK, so we recreate the table.
 */
function rebuildMemoriesTableIfNeeded(db: DbAdapter): void {
  try {
    db.exec(
      "INSERT INTO memories (id, type, content, importance) VALUES ('__check_probe__', 'identity', '__probe__', 0)",
    );
    db.exec("DELETE FROM memories WHERE id = '__check_probe__'");
  } catch {
    // CHECK constraint failed → rebuild without CHECK on type
    db.transaction(() => {
      db.exec(`
        CREATE TABLE memories_new (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          source_turn_id TEXT,
          importance REAL NOT NULL DEFAULT 0.5,
          embedding BLOB,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
          access_count INTEGER NOT NULL DEFAULT 0,
          metadata TEXT,
          namespace TEXT
        );
        INSERT INTO memories_new SELECT id, type, content, source_turn_id, importance, embedding, created_at, accessed_at, access_count, metadata, namespace FROM memories;
        DROP TABLE memories;
        ALTER TABLE memories_new RENAME TO memories;
      `);
      // Rebuild FTS5 index to match new table
      db.exec("DELETE FROM memories_fts");
      db.exec(
        "INSERT INTO memories_fts(id, content) SELECT id, content FROM memories",
      );
    })();
  }
}

/**
 * Rebuild tasks table if CHECK constraint is outdated.
 * SQLite does not support ALTER CHECK, so we recreate the table.
 * The rebuilt table drops CHECK constraints entirely to avoid future migration pain.
 */
function rebuildTasksTableIfNeeded(db: DbAdapter): void {
  // Probe with 'triaged' status — if CHECK rejects it, we need to rebuild
  try {
    db.exec(
      "INSERT INTO tasks (id, title, status) VALUES ('__check_probe__', '__probe__', 'triaged')",
    );
    // If it succeeded, constraint already allows new statuses — remove probe row
    db.exec("DELETE FROM tasks WHERE id = '__check_probe__'");
  } catch {
    // CHECK constraint failed → need to rebuild without CHECK constraints
    db.transaction(() => {
      db.exec(`
        CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'todo',
          priority TEXT NOT NULL DEFAULT 'normal',
          due_date TEXT,
          assignee TEXT NOT NULL DEFAULT 'human',
          created_by TEXT NOT NULL DEFAULT 'human',
          session_id TEXT,
          trace_id TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO tasks_new SELECT id, title, description, status, priority, due_date, assignee, created_by, session_id, trace_id, tags, created_at, updated_at FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
      `);
    })();
  }
}

/** Count rows in a table */
function countRows(db: DbAdapter, table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }
  ).cnt;
}

/** Ensure the knowledge_chunks table exists (for static file RAG) */
function ensureKnowledgeChunksTable(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kc_agent_source ON knowledge_chunks(agent_id, source_id);
  `);
}

/** Add a column to a table if it doesn't already exist */
function addColumnIfMissing(
  db: DbAdapter,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
