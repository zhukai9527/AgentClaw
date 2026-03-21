# It Worked on My Laptop. Then the First User Broke It.

*Part 10 of "Building AI Agent Frameworks" — a series on the engineering behind autonomous AI agents.*

*By Rosibo & Claude | March 2026*

---

Your AI agent demos beautifully. It answers questions, calls tools, remembers context. You deploy it to a VPS, share the link with three friends, and within an hour: the SQLite database is locked, a shell command deleted `/app/data`, the process died with no logs, and there's no backup.

**The gap between demo and production is not features — it's everything that happens when things go wrong.**

We run [AgentClaw](https://github.com/vorojar/AgentClaw) in production across six messaging channels simultaneously — Telegram, WhatsApp, DingTalk, Feishu, WeChat Work, and QQ. The framework has been running for months without unplanned downtime. Not because it never fails, but because we built layers to contain failure: automated backups, graceful shutdown, schema migration, health monitoring, and security hardening.

This article is our production readiness checklist — everything we wished someone had told us before the first deployment.

> *Full disclosure: this article was co-written with Claude. The code, data, and decisions are ours; the prose was a collaboration.*

---

## The Core Insight

Here it is in one sentence:

> **Production readiness is not a feature you add at the end — it's seven boring systems (backup, shutdown, migration, health, security, containerization, monitoring) that each prevent a different class of catastrophe.**

Every section in this article is one of those seven. Skip any one, and you'll learn about it at 3 AM.

---

## 1. Containerization: Don't Ship Your Environment

A bare `node index.js` on a VPS works until you need to rebuild, reproduce, or scale. Docker is the floor, not the ceiling.

Our Dockerfile uses a two-stage build. Stage 1 installs build dependencies (Python, make, g++ for native SQLite bindings), compiles everything, and is discarded. Stage 2 starts from a clean `node:20-slim`, copies only the built artifacts, and installs production dependencies.

The result:

| Layer | What's included | What's excluded |
|-------|----------------|-----------------|
| Build stage | Source code, devDependencies, compiler toolchain | — |
| Runtime stage | Compiled JS, prod dependencies, CLI tools | Source, tests, build tools, `.env` files |

Three details that matter more than they seem:

**Non-root user.** The container creates a dedicated `agentclaw` user (UID 1001) and runs as that user. If the LLM's shell tool gets tricked into running `rm -rf /`, it can only damage `/app/data`, not the system. This is one line in the Dockerfile — `USER agentclaw` — and it's the highest-ROI security measure you can add.

**`.dockerignore` excludes secrets.** Our `.dockerignore` blocks `.env`, `.env.*`, `*.pem`, `*.key`, and the entire `data/` directory. Without this, `docker build` copies your API keys into the image layer — permanently, even if you delete them later.

**Runtime tools are explicit.** Our agent needs `ffmpeg` (audio processing), `git` (repository tools), `curl`, `python3`, Chromium (headless browser automation), and CJK fonts. Every runtime dependency is an explicit `apt-get install` line. If it's not in the Dockerfile, it doesn't exist.

```
Build stage (discarded):     python3, make, g++, full source
                                    ↓ COPY --from=builder
Runtime stage (shipped):     node:20-slim + ffmpeg, git, chromium
                             + compiled dist/ + prod node_modules
                             + USER agentclaw (non-root)
```

The `docker-compose.yml` ties it together: the agent container, a self-hosted SearXNG search engine (replacing paid search APIs), and Valkey/Redis for caching — all behind `127.0.0.1` port binding so nothing is exposed to the internet by default.

---

## 2. Automated Backups: The System You Never Think About Until You Need It

SQLite is a single file. That's its strength (no database server to manage) and its danger (one corrupted write, one accidental deletion, and everything is gone).

We run a daily backup cron at 2:00 AM:

```
Daily at 02:00 →
  copyFileSync(db, backups/agentclaw-YYYY-MM-DD.db) →
  Prune: keep latest 7, delete older
```

That's it. `copyFileSync` on a SQLite file in WAL mode. No `sqlite3 .backup` command, no external tool. It works because our agent traffic is low enough that the file is consistent-on-read most of the time. For higher-traffic deployments, you'd want SQLite's online backup API.

The retention policy — keep 7, delete the rest — is deliberate. Seven days means you can recover from a bad migration that went unnoticed for a week. More than seven and your backup directory grows unbounded.

**The lesson: backups are not about the mechanism. They're about having them at all.** Most agent frameworks we've reviewed have zero backup strategy. A `copyFileSync` that runs every day is infinitely better than a sophisticated backup pipeline that doesn't exist.

---

## 3. Graceful Shutdown: Don't Kill Conversations Mid-Sentence

An AI agent isn't a stateless web server. When you send SIGTERM, there might be an LLM call in flight that's been running for 20 seconds. If you kill the process, the user gets a broken response, and the conversation history is corrupted (a tool_call without a matching tool_result).

Our shutdown sequence has three phases:

```
SIGTERM received
  ├─ Phase 1: Stop accepting new work
  │    Stop heartbeat, cron jobs, channel listeners, scheduler
  │
  ├─ Phase 2: Drain active conversations (up to 15s)
  │    Poll orchestrator.activeLoops every 1s
  │    Log count of remaining conversations
  │
  ├─ Phase 3: Close server + force exit timeout (30s)
  │    app.close() → process.exit(0)
  │    setTimeout(30s) → process.exit(1)  [unref'd — won't block]
  │
  └─ If conversations don't finish in 15s → proceed anyway with warning
```

**The 30-second outer timeout is critical.** Without it, a stuck LLM call (provider timeout, network issue) keeps the process alive forever. The `unref()` on the timeout means it won't prevent natural exit if everything closes cleanly.

**The 15-second drain window is a pragmatic choice.** LLM calls typically take 5-30 seconds. Waiting 15 seconds catches most in-flight calls without making deploys painfully slow. If a call is still running after 15 seconds, we log a warning and proceed — a slightly truncated response is better than a hung deployment.

---

## 4. Schema Migration: The Pragmatic Approach (and Its Limits)

Your database schema will change. New features need new columns. Old constraints become wrong. In a traditional web app, you'd use a migration framework. For an embedded SQLite database, we use a simpler pattern:

```
addColumnIfMissing(db, table, column, type)
  → PRAGMA table_info(table)
  → if column not found: ALTER TABLE ADD COLUMN
```

Every migration runs at startup, every time. The `PRAGMA table_info` check makes each one idempotent — safe to run a hundred times. This is not novel, but it's surprisingly effective:

| Migration count | Tables affected | Runtime cost |
|----------------|----------------|--------------|
| 25+ column additions | 5 tables | <50ms total |
| 3 table rebuilds | tasks, memories | <200ms (one-time) |

**Where it breaks down: CHECK constraints.** SQLite doesn't support `ALTER TABLE ... DROP CONSTRAINT`. When we needed to add new task statuses (`triaged`, `queued`, `running`) to a CHECK constraint, we had to rebuild the entire table:

1. Create `tasks_new` with the correct schema (no CHECK constraint this time)
2. Copy all data from `tasks` to `tasks_new`
3. Drop `tasks`
4. Rename `tasks_new` to `tasks`
5. Recreate indexes

We wrap this in a transaction and probe first — insert a test row with the new status, and only rebuild if it fails. After two rebuilds, we learned the lesson: **don't use CHECK constraints on columns whose valid values will change.** Validate in application code instead.

**The honest limitation:** `addColumnIfMissing` can only add columns. It can't rename them, change types, or remove them. For those, you need a full table rebuild. This is fine for an application with a single SQLite database and straightforward schema evolution. It would not work for a multi-tenant SaaS with 10,000 databases.

---

## 5. Health Checks: Know What's Broken Before Your Users Tell You

An agent framework has more dependencies than a typical web service. Ours depends on: LLM APIs, a search engine, an email server (IMAP), a browser extension, and an image generation service. Any of them can go down independently.

Our health check system runs hourly, checks all configured services concurrently (3-second timeout per check), and **only reports changes**:

```
Hourly cron →
  Check IMAP, SearXNG, Chrome extension, ComfyUI (in parallel)
  → Compare with previous results
  → If any status changed: broadcast notification to all channels
  → If all same: log "no changes", do nothing
```

**The "only report changes" design is key.** If SearXNG is down and stays down, you get one notification, not 24 per day. When it recovers, you get one more.

But the health check does something more unusual: **it injects results into the LLM's system prompt.** Failed services appear as a warning:

```
[注意] 以下服务当前不可用：SearXNG 搜索引擎（连接超时）。
涉及这些服务的请求请告知用户。
```

This means the LLM *knows* that web search is down before trying to use it. Instead of calling the tool, getting an error, and wasting a loop iteration, it tells the user upfront: "Search is currently unavailable, but I can help with what I know."

**The broader principle: don't make the LLM discover failures by trial and error. Tell it what's broken in the system prompt.**

---

## 6. Logging and Monitoring: console.log Is Not Enough

Let's be honest about where we are: our logging is `console.log` with a `[tag]` prefix. Every line in our startup sequence looks like this:

```
[gateway] Bootstrapping...
[gateway] Creating server...
[gateway] Server listening on http://0.0.0.0:3100
[health-check] 定时检查完成，无状态变化
[db-backup] Backed up to data/backups/agentclaw-2026-03-21.db
```

This works. You can `grep "[db-backup]"` to find backup logs, `grep "[shutdown]"` to trace shutdown sequences. For a single-instance deployment, it's adequate.

Where it falls apart:

| Scenario | console.log | Structured logging |
|----------|------------|-------------------|
| "What happened to conversation X?" | Grep through megabytes | Query by conversation_id |
| "How many LLM errors in the last hour?" | Count grep matches | Dashboard metric |
| "Which tool is slowest on average?" | Write a script | Pre-aggregated |
| Multi-instance deployment | Separate log files per instance | Centralized with instance tags |

We compensate with our **traces table** — every LLM call records input/output tokens, duration, tool calls, errors, model used, and channel source in SQLite. This gives us structured querying for the things that matter most (cost, performance, errors) without a full logging infrastructure.

**The pragmatic stance:** If you're running one instance, `console.log` plus a traces database covers 90% of needs. If you're scaling beyond one instance, invest in structured logging (pino, winston) and a log aggregator before you invest in new features. **You can't fix what you can't see in the logs.**

We also integrate Sentry for error monitoring — opt-in via `SENTRY_DSN` environment variable, zero overhead when not configured. Critical errors (startup failures, unhandled exceptions, scheduled task failures) are captured automatically. The 0.2 trace sample rate gives us performance data without drowning in volume.

---

## 7. Security Hardening: Your Agent Is an Attack Surface

An AI agent with tool access is fundamentally different from a web API. It can read files, execute shell commands, make HTTP requests, and write to disk. Every one of these is an attack vector.

Here's our defense-in-depth:

**Layer 1 — Shell sandbox.** A regex-based validator blocks irreversibly destructive commands (`rm -rf /`, `mkfs`, `dd if=/dev/zero`, `:(){ :|:& };:`) before they reach the shell. Not perfect (determined attackers can encode around regex), but catches the 90% case — which is the LLM being tricked by prompt injection, not a sophisticated attacker.

**Layer 2 — File read blocklist.** The `file_read` tool blocks patterns: `.env`, `credentials.json`, `secrets.json`, `.pem`, `.key`, `id_rsa`, and paths under `/etc/shadow`, `/proc`. Even if the LLM is socially engineered into reading your API keys, the tool refuses.

**Layer 3 — SSRF protection.** The `web_fetch` tool validates that URLs don't resolve to private IP ranges (`127.0.0.1`, `10.x.x.x`, `192.168.x.x`, `169.254.x.x`). Without this, a prompt injection could make your agent fetch `http://169.254.169.254/latest/meta-data/` on AWS and leak your instance credentials.

**Layer 4 — Memory content scanning.** The `remember` tool scans content for prompt injection patterns (8 detection rules), invisible Unicode characters, and credential-theft payloads before writing to persistent memory. This prevents an attacker from poisoning the agent's long-term memory through a single conversation.

**Layer 5 — Container isolation.** The `USER agentclaw` directive means the process can't install packages, modify system files, or escalate privileges. Combined with Docker's default seccomp profile, this contains blast radius.

**No single layer is sufficient. Each one catches a different class of attack.** Shell sandbox stops destructive commands. File blocklist stops data exfiltration. SSRF protection stops network-level attacks. Memory scanning stops persistent poisoning. Container isolation limits what happens when everything else fails.

---

## The Production Readiness Checklist

Before deploying your agent framework, score yourself honestly:

| Category | Check | Impact of skipping |
|----------|-------|-------------------|
| **Containerization** | Multi-stage Docker build | "Works on my machine" syndrome |
| | Non-root user in container | One bad shell command = full system compromise |
| | `.dockerignore` excludes `.env`, keys | API keys baked into image layers permanently |
| | Explicit runtime dependencies | "It worked yesterday" after base image update |
| **Backup** | Automated daily database backup | One corruption = total data loss |
| | Retention policy (keep N, prune old) | Backup directory grows until disk is full |
| **Shutdown** | Signal handlers (SIGTERM/SIGINT) | Broken conversations, corrupted history |
| | Active conversation drain with timeout | Deploys take forever or kill mid-response |
| | Force-exit timeout (unref'd) | Hung process requires manual kill |
| **Migration** | Idempotent schema migrations at startup | Manual ALTER TABLE on every deploy |
| | Table rebuild strategy for constraint changes | Stuck on old schema, can't add features |
| **Health** | Dependency health checks | LLM wastes iterations discovering broken tools |
| | Status change notifications | You find out from users, not from your system |
| | Health state injected into LLM context | Agent tries broken tools repeatedly |
| **Monitoring** | Error tracking (Sentry or equivalent) | Silent failures accumulate |
| | Per-call traces (tokens, duration, errors) | Can't answer "why is this slow/expensive?" |
| | Structured logs or tagged console.log | Debugging requires reading raw output |
| **Security** | Shell command validation | Prompt injection → `rm -rf /` |
| | File read blocklist | Prompt injection → leaked API keys |
| | SSRF protection on HTTP tools | Prompt injection → cloud metadata theft |
| | Memory content scanning | One bad conversation → permanently poisoned agent |
| | Non-root container execution | Everything else fails → limited blast radius |

**If you check fewer than 12 of these 20 items, you're running a demo, not a production system.** That's fine for development — just don't give it to users.

---

## Trade-offs We Evaluated and Rejected

**PostgreSQL instead of SQLite.** For a single-instance agent, SQLite is simpler, faster, and requires no separate process. The migration story is worse (no `ALTER COLUMN`, limited `ALTER TABLE`), but the operational simplicity — your entire database is one file you can `cp` — outweighs it. We'd switch at the point where concurrent write pressure from multiple agent instances causes WAL contention.

**Kubernetes instead of Docker Compose.** Our deployment is one agent, one search engine, one cache. Docker Compose handles this with a 40-line YAML file. Kubernetes would add a learning curve, operational complexity, and at least 5 more YAML files — for zero benefit at our scale. We'd switch when we need horizontal scaling or zero-downtime rolling deploys.

**Full migration framework (Knex, Prisma Migrate).** These tools excel when you have a team, a staging environment, and rollback requirements. For a single SQLite database with additive-only schema changes, `addColumnIfMissing` at startup is simpler and has zero dependencies. We'd switch when we need rollbacks or non-additive migrations.

---

## Five Things to Do Monday Morning

1. **Add a non-root USER to your Dockerfile.** Three lines, five minutes, and it contains the blast radius of every future security incident. If you do nothing else from this article, do this.

2. **Add a daily database backup cron.** `copyFileSync` to a `backups/` directory with a date stamp. Add a prune step that keeps the last 7. Total: 15 lines of code.

3. **Handle SIGTERM in your process.** Stop accepting new work, wait for active operations to drain (with a timeout), then exit. Without this, every deploy risks corrupting in-flight conversations.

4. **Block `.env` reads in your file tools.** A simple regex check — `if path matches /.env/ → deny` — prevents the most common data exfiltration via prompt injection.

5. **Add a `/health` endpoint that checks your dependencies.** Even if it just returns `{ "status": "ok", "uptime": process.uptime() }` — you need something to point a monitoring service at. Bonus: inject dependency status into your LLM's system prompt so it stops trying to use broken tools.

---

*The code behind this article is open-source: [github.com/vorojar/AgentClaw](https://github.com/vorojar/AgentClaw). Deployment configuration lives in `Dockerfile`, `docker-compose.yml`, and `packages/gateway/src/index.ts`. Security hardening spans `packages/tools/src/builtin/` (shell, file-read, web-fetch, remember).*

*Production readiness is boring work. It doesn't demo well. But it's the difference between an agent that impresses people for five minutes and one that runs for five months. [Star the repo](https://github.com/vorojar/AgentClaw) if this checklist saved you from a 3 AM incident, and share what we missed — [@vorojar](https://x.com/nicekid_zhuo) on X.*
