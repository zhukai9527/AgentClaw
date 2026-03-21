# Part 3: Context Is All You Have — Managing the Window

**128K tokens sounds like infinity. Then your agent runs out of memory on turn 12.**

*By Jaro & Claude | 2026*

---

You read the spec sheet — 128K context window, maybe 200K, maybe a million — and you think: *finally, enough room.* Then you ship an agent that calls tools. By turn 10, the context is stuffed with shell outputs, API responses, and JSON blobs from file reads. By turn 12, you're either truncating blindly and the agent forgets what it was doing, or you're paying $0.40 per request because you're shipping 80K tokens of stale tool results on every call.

The context window is not a buffer. **It is the agent's entire working memory, and managing it is the single highest-leverage engineering problem in agent development.**

This article walks through how we solved context management in AgentClaw — a production agent framework — covering the real arithmetic of context budgets, a three-tier compression strategy, and the sharp edges that will silently break your agent if you don't handle them.

---

## The Arithmetic Nobody Does

Here's what "128K tokens" actually means for an agentic loop:

| Resident Occupant | Typical Token Cost |
|---|---|
| System prompt (instructions, persona, rules) | 1,500–4,000 |
| Tool definitions (10–20 tools, JSON Schema) | 3,000–8,000 |
| Dynamic context (memories, skill catalog) | 500–2,000 |
| Safety margin for the model's reply | 4,096 |

Add it up. Before a single user message enters the window, you've already committed **10,000–18,000 tokens** to fixed overhead. Your "128K context" is really 110K of usable space for conversation history. And here's the kicker: a single `file_read` tool result can easily consume 8,000–15,000 tokens. Three shell commands with verbose output? Another 10K. That 110K runway disappears faster than you'd expect.

The first engineering decision is therefore the **context token budget** — the threshold at which you start compressing. In AgentClaw, we default to 80,000 tokens, roughly 60% of a 128K window:

```typescript
// Default: 80K tokens — conservative for most models
this.contextTokenBudget = options.contextTokenBudget ?? 80_000;
```

Why 60% and not 90%? Two reasons. First, token estimation is imprecise — we use a rough heuristic of ~3 characters per token for mixed CJK/English content, and being wrong by 20% at 90% capacity means you've already overflowed. Second, LLM providers like Anthropic offer **prompt caching** that dramatically reduces cost and latency for the prefix of your prompt — but only if that prefix is stable. Compressing too late means your system prompt + early history keeps shifting, killing cache hit rates.

> **Core insight: The context window is a budget, not a container. Overspending on history is just as bad as running out of it.**

---

## Two Triggers, One Goal

When should compression fire? The naive answer is "when the conversation gets long," but "long" has two dimensions — turn count and token volume.

A conversation with 25 short chat messages might use 5K tokens. A conversation with 8 turns might use 60K tokens because the agent read three large files. You need both triggers:

```typescript
const estimatedTokens = this.estimateTokens(turns);
const tokenThreshold = this.contextTokenBudget * 0.7;
const shouldCompress =
  turns.length > this.compressAfter || estimatedTokens > tokenThreshold;
```

The **turn count threshold** (`compressAfter`, default 20) catches the slow bleed of many small messages. The **token budget threshold** (70% of the budget) catches the sudden spike from a single enormous tool result. Both lead to the same compression pipeline, but they catch fundamentally different failure modes.

The 0.7 multiplier is not arbitrary. It leaves a 30% buffer between "start compressing" and "context is actually full" — enough room to complete the current compression before the next LLM call. Think of it as the fuel light in your car: you want the warning before you're stranded, not after.

---

## Three Tiers of Compression: Graceful Degradation

Compression is not a single operation. It's a three-tier escalation strategy, designed so that the system *always produces a result* — even when the LLM summarizer itself fails.

### Tier 1: Normal LLM Summarization

The first attempt asks the provider to produce a concise summary — 3–5 bullet points, under 500 characters, in the same language the user was speaking:

```typescript
const resp = await this.provider.chat({
  messages: [{ id: "sum", role: "user", content: transcript, createdAt: new Date() }],
  systemPrompt: "Summarize this conversation in 3-5 bullet points. Keep key facts, decisions, and user preferences. Reply in the same language the user used. Be concise (under 500 chars).",
  maxTokens: 300,
});
```

This works well 95% of the time. The summary preserves semantic meaning — *what the user wanted, what decisions were made, what state we're in* — at a fraction of the original token cost. A 30-turn conversation that consumed 40K tokens becomes a 200-token summary.

### Tier 2: Aggressive LLM Summarization

If Tier 1 fails (API error, empty response, timeout), we retry with tighter constraints — 2–3 key facts, maximum 200 characters, temperature dropped to 0.05 to minimize creative drift:

```typescript
const resp = await this.provider.chat({
  messages: [{ id: "sum-aggressive", role: "user", content: transcript, createdAt: new Date() }],
  systemPrompt: "Compress this conversation into 2-3 key facts. Maximum 200 characters. Same language as user.",
  maxTokens: 150,
  temperature: 0.05,
});
```

The low temperature is critical. When you're summarizing for context management, you want *accuracy*, not *creativity*. A hallucinated detail in a summary can send the agent down the wrong path for the rest of the session.

### Tier 3: Deterministic Truncation

If both LLM attempts fail — maybe the provider is down, maybe you're running locally with no API — the system falls back to a purely deterministic approach: take the first 2,048 characters of the transcript and slap a header on it.

Is this ideal? No. Does it ensure the agent *never crashes due to a summarization failure*? Yes. And that guarantee matters more than you think. In a production system, an agent that falls back gracefully beats an agent that produces perfect summaries 99% of the time and hard-crashes the other 1%.

The three tiers are cached by a composite key of conversation ID and turn count, stored in an LRU cache of 200 entries. If the same compression boundary is hit again (e.g., on retry), we skip straight to the cached result.

---

## Fresh Tail Protection: The Messages You Must Never Compress

Here's a mistake that will cost you days of debugging: you compress the conversation history, and the agent immediately forgets what it was doing *right now*. The summary captures the broad arc of the conversation, but it doesn't capture the specific file the agent just opened, the exact error message from the last command, or the user's most recent instruction.

**Fresh Tail Protection** guarantees that the most recent N messages are never touched by compression:

```
compressAfter: 20    // start compressing at 20 turns
freshTailCount: 32   // but always protect the last 32 messages
```

Wait — the tail count is *larger* than the compression trigger? That's intentional. The compression trigger checks `turns.length > compressAfter`, but the actual split point is calculated as `turns.length - max(compressAfter, freshTailCount)`. If the split point yields nothing meaningful to compress (fewer than 2 turns in the "old" portion), compression is skipped entirely.

This means compression primarily fires on the **token budget threshold** in practice — when a small number of turns contain disproportionately large content. The turn count threshold is a safety net for chatty conversations that slowly accumulate.

There's an additional subtlety in the split logic: if the split point lands on a `tool` turn (a tool result), it's pushed forward past tool results until it lands on a `user` or `assistant` turn. This prevents orphaning a tool result from its corresponding tool call, which would cause an API validation error.

---

## Tool Pair Safety: The Edge Case That Breaks Everything

Every LLM API enforces a strict contract: a `tool_use` block in an assistant message *must* be followed by a `tool_result` block with a matching ID. Break this contract and you get a 400 error — not a degraded response, an outright failure.

Compression creates two flavors of orphan:

1. **Orphaned tool results** — a tool result references a tool call that was removed during compression.
2. **Orphaned tool calls** — an assistant message contains tool calls whose results were compressed away.

The `sanitizeToolPairs` method handles both cases in a single pass:

**For orphaned results**, it collects all surviving tool call IDs from assistant messages, then filters out any tool result blocks that reference IDs not in that set. Critically, this operates at the *block level*, not the message level — a single tool message might contain results for multiple tool calls, and only the orphaned ones should be removed.

**For orphaned calls**, it inserts stub results — minimal `tool_result` blocks with a placeholder message — immediately after the assistant message that contains the unmatched call. The stub reads: *"[Result from earlier conversation — see context summary above]"*, pointing the agent back to the summary for context.

This is defensive programming at its most important. Without `sanitizeToolPairs`, any context management strategy that touches history will eventually produce an invalid message sequence. And "eventually" in production means "the first time a power user has a 30-turn coding session."

---

## Frozen Snapshot: Caching the System Prompt

Here's a performance insight that's easy to miss: Anthropic's prompt caching gives you a significant discount on tokens that appear in a *stable prefix* of your prompt. If your system prompt changes on every turn — because you're dynamically injecting fresh memories or skill catalogs — you lose that cache benefit entirely.

AgentClaw's solution is the **Frozen Snapshot**. The first time `buildContext` is called for a conversation, it builds the dynamic context (memories, skill catalog) and caches the result. Every subsequent turn in that session reuses the cached version:

```typescript
if (this.dynamicContextCache.has(conversationId)) {
  const cached = this.dynamicContextCache.get(conversationId)!;
  dynamicSuffix = cached.suffix;
  skillMatch = cached.skillMatch;
} else {
  const result = await this.buildDynamicContext(currentInput, options, ...);
  dynamicSuffix = result.suffix;
  this.dynamicContextCache.set(conversationId, { suffix: dynamicSuffix, skillMatch });
}
```

The tradeoff is explicit: if the user stores a new memory mid-session via the `remember` tool, that memory *is persisted to the database* but *does not appear in the system prompt* until the next session. This is a deliberate design choice — prompt stability for caching outweighs intra-session memory freshness, because the agent can always reference recent conversation history for context it just learned.

The cache is an LRU with 5,000 entries, which accommodates high-concurrency deployments where thousands of sessions may be active. Cache eviction on session close is explicit via `clearConversationCache()`, preventing stale entries from consuming memory.

---

## The Offload Escape Hatch

Compression is lossy by definition. No summary, no matter how good, preserves every detail of a 50-turn conversation. So what happens when the agent needs to recall something specific from the compressed portion?

The answer is **offload to disk**. When compression fires, the full transcript of the compressed turns is written to a file:

```
data/tmp/{conversationId}/conversation_history.md
```

The summary injected into the context includes a reference:

```
Full history saved to: data/tmp/abc123/conversation_history.md (use file_read to review if needed)
```

This creates a two-tier memory architecture: the summary provides fast, cheap, approximate recall (it's in the context window), while the full transcript provides slow, exact recall (the agent must use a tool to read it). Most of the time, the summary is sufficient. But when the agent needs to recover a specific command output or an exact file path from 20 turns ago, the escape hatch is there.

This pattern — **lossy compression with lossless backup** — is borrowed from how humans use notes. Your meeting notes are a lossy summary; the full recording is the lossless backup. You reference the notes 99% of the time and pull up the recording only when the notes aren't enough.

---

## Observation Compression: The 80% You Can Throw Away

Beyond conversation-level compression, there's a second compression layer that targets individual tool results. The insight is that most tool output is *noise* from the agent's perspective — verbose logging, formatting whitespace, repeated structures — and only a small fraction contains the information the agent actually needs.

AgentClaw's observation compression runs on all tool results except the two most recent ones (which are likely relevant to the current task). It applies a four-pass extraction:

1. **Error lines** (highest priority): anything matching `error`, `exception`, `fail`, `ENOENT`, etc.
2. **Status lines**: `success`, `created`, `updated`, `total`, `count`, etc.
3. **JSON key fields**: extract `id`, `name`, `status`, `error`, `message`, `path`, `url` from structured data.
4. **Head/tail lines**: if the above passes yield fewer than 3 lines, take the first 3 and last 2 lines for context.

Combined with deduplication (if two tool results have the same first 200 characters, the second is collapsed to a reference), this achieves **80–95% token savings** on historical tool results. A 5,000-character `shell` output from `npm install` becomes a 400-character extract of the error or success line plus the total count.

Additionally, a separate **basic compression** layer runs on all tool results unconditionally — normalizing whitespace (collapsing `\n\n\n` to `\n\n`, tabs to spaces) and minifying JSON blobs. These are safe, semantic-preserving transformations that typically save 3–12% on their own.

---

## Putting It All Together

Here's the full pipeline, in execution order:

1. **Load history** from SQLite (up to `maxHistoryTurns`).
2. **Check compression triggers** — turn count OR token budget exceeded?
3. If yes: **split** into old turns and fresh tail, **compress** old turns (three-tier), **offload** full transcript to disk, assemble summary + fresh tail.
4. **Build or reuse** the frozen dynamic context snapshot (memories + skills).
5. **Extract large content** — any tool result over 12K chars gets persisted to disk and replaced with a structured summary.
6. **Compress observations** — older tool results get intelligent extraction (errors, status, key fields).
7. **Sanitize tool pairs** — fix any orphaned tool calls or results from the above steps.
8. **Apply basic compression** — whitespace normalization and JSON minification.
9. **Assemble** — system prompt + dynamic context suffix + processed messages.

Nine steps, and each one exists because we hit a real production failure without it. The order matters: large content extraction before observation compression (so the observation compressor doesn't choke on a 100K blob), tool pair sanitization *after* all message-modifying steps (so it catches every orphan), basic compression last (so it doesn't interfere with the structured extraction in earlier steps).

---

## Monday Morning Actions

If you're building an agent and you take one thing from this article, take this: **measure your actual context usage before you think about compression.** Add logging that tracks the token count at each turn. You'll be shocked how fast it grows — and you'll see exactly where the bloat comes from (hint: it's almost always tool results, not conversation text).

Then, implement these in order of impact:

1. **Set a token budget** and trigger compression at 70% of it. Don't wait for overflow.
2. **Protect the fresh tail.** The last N messages are sacred. Compress everything else.
3. **Sanitize tool pairs** after any operation that modifies message history. This is non-negotiable for any LLM API.
4. **Offload full transcripts** so compression is reversible. Your agent will thank you when it needs to recall something specific.
5. **Compress observations** on older tool results. This is the single biggest token saver in a tool-using agent.

The context window is the most expensive resource in your entire stack — more expensive than compute, more expensive than storage, more expensive than network. Manage it like it matters, because it does.

---

*The code behind this article is open-source: [github.com/vorojar/AgentClaw](https://github.com/vorojar/AgentClaw). Context management lives in `packages/core/src/context-manager.ts`.*

*[Star the repo](https://github.com/vorojar/AgentClaw) if this saved you from a context overflow. Tell us what we missed — [@vorojar](https://x.com/nicekid_zhuo) on X.*

*Built by a human and an AI, arguing over token budgets. — Jaro & Claude, 2026*
