# Your Agent Has Amnesia. Every Single Conversation.

*Part 4 of "Building AI Agent Frameworks" — a series on the engineering behind autonomous AI agents.*

*By Jaro & Claude | March 2026*

---

You've just spent twenty minutes explaining your project structure to your AI agent. It helped you refactor three modules, learned your naming conventions, understood your deployment setup. You close the chat. Tomorrow, you open a new session and type "continue where we left off."

It has no idea who you are.

This is the default state of every LLM-based agent. Context windows are session-scoped. When the session ends, everything the model learned about you — your name, your tech stack, that you hate tabs — evaporates. The next session starts from absolute zero.

**Memory is not a feature. It's the difference between a tool and a colleague.**

We run [AgentClaw](https://github.com/vorojar/AgentClaw), an open-source agent framework deployed across Telegram, WhatsApp, DingTalk, and web. After six months in production, we've built a memory system that lets the agent accumulate knowledge across sessions — who users are, what they prefer, what failed last time. This article is the full architecture: what we store, how we retrieve it, and the security landmines we stepped on along the way.

> *Full disclosure: this article was co-written with Claude. The code, data, and decisions are ours; the prose was a collaboration.*

---

## The Core Insight

> **Memory isn't "saving chat logs." It's teaching your agent to form opinions, recognize patterns, and build relationships — across sessions, across channels, across time.**

Chat history is what happened. Memory is what matters. The entire system described below is one idea applied repeatedly: extract the durable signal from ephemeral conversations, store it efficiently, retrieve it contextually, and inject it where the LLM will actually use it — the system prompt.

---

## What's Worth Remembering

Not everything in a conversation deserves to persist. We classify memories into five types, each with different retention characteristics:

| Type | What It Captures | Example | Decay Floor |
|------|-----------------|---------|-------------|
| `identity` | Who the user is | "Name is Alex, works at Stripe, based in Tokyo" | 0.3 (never fades) |
| `preference` | How they like things done | "Prefers TypeScript, hates ORMs, uses vim" | 0.3 (never fades) |
| `fact` | Durable knowledge | "Main project uses PostgreSQL 16 with pgvector" | 0.1 |
| `entity` | People, projects, systems | "Project Atlas — internal ML pipeline, 3-person team" | 0.1 |
| `episodic` | Lessons from experience | "Last deploy failed because migration ran before seed" | 0.1 |

The decay floor is critical. Identity and preference memories have a floor of 0.3 — they never fully decay, no matter how old. **Your agent should never forget a user's name.** Facts and episodes can fade to 0.1 but never hit zero, because even a vague memory is better than none.

This classification isn't academic taxonomy. It drives three concrete decisions: what gets injected into the system prompt (identity and preferences always, others by relevance), what survives consolidation (high-floor types survive aggressive pruning), and what the LLM is allowed to store (the `remember` tool enforces these types as an enum).

---

## The Storage Layer: SQLite + FTS5 + Vector Embeddings

We chose SQLite. Not Postgres, not Redis, not a dedicated vector database. Here's why: our agent runs as a single-process Node.js application. SQLite gives us ACID transactions, full-text search via FTS5, and binary blob storage for embeddings — all in one file, zero network hops, zero operational overhead.

The schema for the memories table:

```
memories
├── id            TEXT PRIMARY KEY
├── type          TEXT (identity|fact|preference|entity|episodic)
├── content       TEXT
├── importance    REAL (0.0 – 1.0)
├── embedding     BLOB (Float64Array, serialized)
├── namespace     TEXT (tenant isolation)
├── accessed_at   TEXT (for recency scoring)
├── access_count  INTEGER (for popularity signal)
└── created_at    TEXT
```

A parallel FTS5 virtual table (`memories_fts`) mirrors the content column for BM25 full-text search. When a memory is added, updated, or deleted, the FTS index is kept in sync within the same transaction. No eventual consistency, no sync jobs, no drift.

```
┌──────────────┐     ┌──────────────────┐     ┌────────────────┐
│   memories   │────▶│  memories_fts    │     │   embeddings   │
│  (main table)│     │  (FTS5 index)    │     │  (BLOB column) │
│              │     │  BM25 scoring    │     │  cosine sim    │
└──────────────┘     └──────────────────┘     └────────────────┘
       │                     │                        │
       └─────────────────────┼────────────────────────┘
                             ▼
                    ┌─────────────────┐
                    │  Hybrid Search  │
                    │  BM25 + Vector  │
                    │  + Recency      │
                    │  + Importance   │
                    └─────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │   MMR Rerank    │
                    │  (diversity)    │
                    └─────────────────┘
```

---

## Retrieval: Four Signals, One Score

This is where most memory systems get it wrong. They pick one retrieval strategy — keyword search, or vector similarity, or recency — and wonder why results feel random. We combine four signals into a single hybrid score:

```
score = 0.20 × bm25Score
      + 0.40 × semanticScore
      + 0.15 × recencyScore
      + 0.25 × importanceScore
```

**BM25 (weight: 0.20)** — Classic information retrieval. When the user says "what was that PostgreSQL issue?", BM25 finds memories containing "PostgreSQL." FTS5 handles this natively with the `bm25()` ranking function. We normalize the raw scores (FTS5 returns negative values where lower = better) to a 0–1 range.

**Semantic similarity (weight: 0.40)** — The user says "database problem" and the memory says "PostgreSQL connection timeout." No keyword overlap, but the meaning aligns. We generate embeddings at write time and compute cosine similarity at query time. When embeddings have mismatched dimensions (common when switching embedding providers), we truncate to the shorter length rather than zero-padding — zero-padding artificially deflates similarity scores.

**Recency (weight: 0.15)** — Exponential decay with a 7-day half-life. A memory accessed yesterday scores ~0.9. A memory from two weeks ago scores ~0.25. This prevents ancient memories from crowding out fresh ones when relevance scores are similar.

**Importance (weight: 0.25)** — The LLM assigns importance at extraction time (0.0–1.0). "User's name is Alex" gets 0.9. "User mentioned liking dark mode" gets 0.5. This is the only subjective signal, and it's deliberately weighted below semantic similarity — we trust math over the LLM's judgment.

After scoring, we apply MMR (Maximal Marginal Relevance) reranking to ensure diversity. Without it, a search for "project" might return five nearly identical memories about the same project. MMR iteratively selects results that balance relevance with dissimilarity to already-selected entries, using a lambda of 0.7 (favoring relevance but penalizing redundancy).

---

## Automatic Extraction: The Agent Remembers So the User Doesn't Have To

Most memory systems require explicit saves — the user says "remember this" or the agent calls a save function. That works for deliberate storage, but the highest-value memories are the ones users don't think to save. They mention their timezone in passing. They correct a function name. They describe their team structure while explaining a bug.

`MemoryExtractor` runs in the background every 8 conversation turns. It sends the recent turns plus existing memories to the LLM with a tightly scoped extraction prompt:

```
Extract from conversation → { type, content, importance }[]

Allowed: identity, fact, preference, entity, episodic
Forbidden: one-off operations, tool execution details,
           assistant capabilities, transient info
```

The existing memories are included in the prompt so the LLM can avoid duplicates. But we don't trust the LLM to get deduplication right — after extraction, every candidate goes through `findSimilar()`, which runs a pure-semantic search (BM25 weight zero, semantic weight 1.0) and rejects anything above a 0.75 similarity threshold. If a similar memory exists with lower importance, we update the importance instead of creating a duplicate.

**The extraction frequency matters more than you'd think.** We started at every 3 turns. At our scale, that meant 10 background LLM calls per 30-turn conversation — 30,000 tokens of invisible spend (see [Part 5: The Token Economy](./05-the-token-economy.md)). We moved to every 8 turns: 60% fewer calls, no measurable drop in memory quality.

---

## Memory Consolidation: Decay, Merge, Prune

Memories accumulate. Without maintenance, the store fills with near-duplicates, stale entries, and low-value noise that dilutes retrieval quality. We run a consolidation pipeline with three phases:

**Phase 1 — Importance Decay.** Every memory's importance decays exponentially with a 30-day half-life, calculated from `accessed_at`. A memory with importance 0.8, untouched for 60 days, drops to ~0.2. But it never drops below the type-specific floor (0.3 for identity/preference, 0.1 for others). This means your agent gradually "forgets" the name of a project you mentioned once six months ago, but never forgets your name.

**Phase 2 — Dedup Merge.** Pairwise comparison of all memories using their stored embeddings. Pairs with similarity > 0.85 get merged: the longer entry survives, importance is boosted. This catches the inevitable "user prefers dark mode" / "user likes dark mode" / "dark mode preferred" accumulation.

**Phase 3 — Prune.** Memories with importance < 0.15 and zero access count get deleted. They decayed below the threshold and were never retrieved — the system is confident they're noise.

---

## The Embedding Problem: What Do You Do Without an API?

Vector similarity requires embeddings. The obvious choice is an embedding API — OpenAI's `text-embedding-3-small`, Cohere's `embed-v3`, or a local model. But we had a constraint: AgentClaw must work with zero configuration beyond a single LLM API key. Many users run it with just `ANTHROPIC_API_KEY`, and Anthropic doesn't offer an embedding endpoint.

Our solution is a three-tier fallback:

| Priority | Provider | Quality | Latency |
|----------|----------|---------|---------|
| 1 | External embedding API (e.g., Volcano Engine doubao-embedding) | High | ~100ms |
| 2 | LLM provider's `embed()` method (if implemented) | High | ~100ms |
| 3 | `SimpleBagOfWords` — local, zero-dependency | Low | <1ms |

`SimpleBagOfWords` is our fallback: a 512-dimension bag-of-words model that builds vocabulary incrementally. It tokenizes CJK characters individually (each is a semantic unit) and groups Latin/Cyrillic words of 2+ characters. Output is L2-normalized term-frequency vectors.

Is it good? No. It has no semantic understanding — "happy" and "joyful" are completely unrelated in bag-of-words space. But it's better than nothing, it requires no API calls, no model downloads, no configuration, and **it works offline.** For users who deploy with a proper embedding API, the system uses it automatically. For everyone else, BM25 + token overlap + recency + importance still produce reasonable retrieval — the semantic score just becomes noisier.

**The pragmatic lesson: don't let perfect embeddings block your memory system. Ship with a bad fallback and a clean upgrade path.**

---

## Security: Your Memory Is an Attack Surface

Here's a scenario you haven't thought about: a user asks your agent to remember something. The agent dutifully stores it. That memory gets injected into the system prompt of every future session. The user just wrote to your system prompt.

**Every `remember` call is a write to the highest-privilege position in your prompt.**

We built `scanMemoryContent()` as a pre-write filter. It checks three categories:

**Prompt injection** — 8 patterns across English and Chinese: "ignore previous instructions," "you are now," "disregard your rules," "从现在起你是," "忽略之前的指令." These are the obvious attacks, but they catch the majority of attempts.

**Invisible unicode** — Characters like zero-width spaces (U+200B), zero-width joiners (U+200D), and bidirectional overrides (U+202E). These are used to hide injection payloads that are invisible to the user reviewing their memories but parsed by the LLM.

**Credential exfiltration** — Patterns like `curl ... $API_KEY` or `cat .env`. If a memory contains instructions to exfiltrate secrets, it gets blocked before it reaches the store.

We also block ephemeral content — news headlines, product launch announcements, market data. These aren't security threats, but they waste system prompt tokens on every future request. "Claude 4 released" is not a durable personal fact.

---

## Namespace Isolation: One Brain, Many Users

In a multi-tenant deployment, User A's memories must never leak into User B's context. Every memory has a `namespace` field — typically the user or organization identifier. All queries filter by namespace. The search method includes `namespace` in its WHERE clause before any scoring happens.

This sounds obvious, but consider the failure mode: if namespace filtering happens *after* scoring, a high-importance memory from another namespace could appear in the candidate set before being filtered out. In a timing side-channel attack, the latency difference between "found and filtered" vs. "never found" could leak information about other namespaces' memory contents. We filter first, score second.

---

## How Memories Reach the LLM

The best memory system is worthless if the LLM never sees the results. We inject memories into the system prompt — not the user message, not a tool result, but the system prompt itself. This is deliberate.

The system prompt is the highest-authority position in the prompt hierarchy. Information there is treated as ground truth by the model. Memories in user messages risk being treated as suggestions. Memories in tool results risk being ignored in favor of fresher tool outputs.

At each session's first turn, `ContextManager` runs three parallel searches:

1. **Identity memories** — always loaded, scored by importance (0.9 weight) and recency (0.1 weight). Your name, your email, your role.
2. **Preference memories** — always loaded, scored by importance (0.6) and recency (0.4). Your coding style, your tool preferences.
3. **Query-relevant memories** — the user's first message drives a hybrid search across all types. "Help me with Project Atlas" retrieves entity and episodic memories about Atlas.

Results are merged, deduped by ID, and capped at 2,000 characters. Then they're frozen for the rest of the session — no rebuilds, no re-queries. This frozen snapshot means Anthropic's prompt prefix caching gives us ~90% savings on system prompt tokens for every iteration after the first (see [Part 5](./05-the-token-economy.md)).

The injected format is minimal:

```
你的长期记忆：
- [identity] User's name is Alex, software engineer at Stripe
- [preference] Prefers TypeScript, uses vim, hates ORMs
- [entity] Project Atlas — internal ML pipeline, team of 3
- [episodic] Last Atlas deploy failed: migration ran before seed script

自然地使用这些信息。
```

No XML tags, no JSON wrappers, no elaborate framing. The LLM reads it, internalizes it, and naturally weaves it into responses. "Hi Alex, want to pick up where we left off with Atlas?" — not because we prompted it to greet by name, but because the memory was there and the model is good at being natural.

---

## Results

Measured across production over three months:

| Metric | Value |
|--------|-------|
| Avg memories per active user | 23 |
| Identity/preference memories (high-floor) | 38% of total |
| Memories surviving 90-day consolidation | 71% |
| Avg retrieval latency (hybrid search) | 12ms |
| Memory-related tokens per session | ~200-800 |
| False positive rate (security scanner) | <2% |

The 200-800 token range for memory injection is significant. That's less than a single tool definition. For that cost, the agent knows who you are, what you prefer, and what went wrong last time.

---

## Trade-offs: What We Evaluated and Rejected

**Dedicated vector database (Pinecone, Weaviate, Qdrant):** Adds an external dependency, a network hop, and operational complexity. Our memory store holds thousands of entries per user, not millions. SQLite with in-process cosine similarity handles this in single-digit milliseconds. When you need billion-scale retrieval, switch. Until then, don't.

**Conversation summarization as memory:** Summarizing entire conversations and storing the summaries. The problem: summaries lose the specific details that make memories useful. "User discussed a database migration" is less valuable than "PostgreSQL 16 migration failed because foreign key constraint on users.org_id wasn't deferred." We extract discrete facts, not summaries.

**User-controlled memory management UI:** We built it (there's a MemoryPage in the web UI), but almost nobody uses it. Users don't want to curate their agent's memories. They want the agent to just know things. The automatic extraction + consolidation pipeline handles 95% of cases. The UI exists as an escape hatch, not a primary workflow.

**Real-time memory updates within a session:** When the agent learns something new mid-session, should it immediately update the system prompt? We tried it. It broke Anthropic's prefix caching, increasing per-iteration cost by ~90% on the system prompt. The fix: write to the database immediately, but freeze the system prompt for the session. New memories take effect next session. The one-session delay is invisible to users and saves substantial money.

---

## Five Things to Do Monday Morning

1. **Classify your memories by type with explicit decay floors.** Not everything should fade equally. Identity and preference memories are permanently relevant. Don't treat "user's name" the same as "user mentioned a blog post."

2. **Combine at least three retrieval signals.** Keyword search alone misses semantic matches. Vector similarity alone misses exact terms. Recency alone favors noise. The combination is dramatically better than any single signal.

3. **Scan memory writes for injection.** Every memory you store becomes part of your system prompt. Treat `remember` like a write to your most privileged configuration. Check for prompt injection, invisible unicode, and exfiltration patterns before persisting.

4. **Ship a bad embedding fallback.** Don't block your memory system on a perfect embedding provider. Bag-of-words with BM25 and importance scoring works surprisingly well. Add real embeddings later as an upgrade, not a prerequisite.

5. **Freeze your memory context per session.** Rebuild the dynamic context on every iteration and you lose prompt caching. Freeze it on the first turn, persist new memories to the database, and let them take effect next session. Your users won't notice the delay. Your bill will notice the savings.

---

*The code behind this article is open-source: [github.com/vorojar/AgentClaw](https://github.com/vorojar/AgentClaw). Memory architecture lives in `packages/memory/src/store.ts`, extraction in `packages/core/src/memory-extractor.ts`, and security scanning in `packages/tools/src/builtin/remember.ts`.*

*If your agent forgets your name every session, the fix isn't a bigger context window — it's a memory system. [Star the repo](https://github.com/vorojar/AgentClaw) if this helped, and share what memory strategies work for you — we're [@vorojar](https://x.com/nicekid_zhuo) on X.*

*Next in series: [Part 5 — The Token Economy: Cut Your Bill by 60%](./05-the-token-economy.md)*
