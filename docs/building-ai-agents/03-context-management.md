# 128K Tokens Sounded Like Infinity. Then Our Agent Forgot What It Was Doing on Turn 12.

*Part 3 of "Building AI Agent Frameworks" — a series on the engineering behind autonomous AI agents.*

*By Rosibo & Claude | March 2026*

---

You read the spec sheet — 128K context window, maybe 200K, maybe a million — and you think: *finally, enough room.* Then you ship an agent that calls tools. By turn 10, the context is stuffed with shell outputs, API responses, and JSON blobs from file reads. By turn 12, you're either truncating blindly and the agent forgets what it was doing, or you're paying $0.40 per request because you're shipping 80K tokens of stale tool results on every call.

**The context window is not a storage problem. It is an information priority problem — deciding what the LLM deserves to see right now.**

We run [AgentClaw](https://github.com/vorojar/AgentClaw), an open-source agent framework in production across Telegram, WhatsApp, DingTalk, and more. After instrumenting every byte that enters the context window, we learned that managing it is the single highest-leverage engineering problem in agent development. Not prompt engineering. Not model selection. Context management.

This article is the full breakdown: the arithmetic of context budgets, a three-tier compression waterfall, the edge cases that silently break your agent, and the caching trick that makes it all affordable.


---

## The Arithmetic Nobody Does

Here's what "128K tokens" actually means for an agentic loop:

| Resident Occupant | Typical Token Cost | Notes |
|---|---|---|
| System prompt (instructions, persona, rules) | 1,500–4,000 | Repeated every call |
| Tool definitions (10–20 tools, JSON Schema) | 3,000–8,000 | Static, repeated every call |
| Dynamic context (memories, skill catalog) | 500–2,000 | Frozen per session |
| Safety margin for the model's reply | 4,096 | Non-negotiable |
| **Fixed overhead total** | **10,000–18,000** | **Before a single user message** |

Your "128K context" is really 110K of usable space for conversation history. And here's the kicker: a single `file_read` tool result can easily consume 8,000–15,000 tokens. Three shell commands with verbose output? Another 10K. That 110K runway disappears in five tool calls.

The first engineering decision is the **context token budget** — the threshold at which you start compressing. We default to 80,000 tokens, roughly 60% of a 128K window.

Why 60% and not 90%? Two reasons. First, token estimation is imprecise — we use a rough heuristic of ~3 characters per token for mixed CJK/English content, and being wrong by 20% at 90% capacity means overflow. Second, Anthropic offers **prompt caching** that dramatically reduces cost for stable prompt prefixes — but only if that prefix doesn't shift. Compressing too late means your system prompt keeps changing, killing cache hit rates.

> **Core insight: The context window is a budget, not a container. The question isn't "how much fits?" — it's "what deserves to be here right now?"**

---

## Two Triggers, One Pipeline

When should compression fire? "When the conversation gets long" has two dimensions:

A conversation with 25 short chat messages might use 5K tokens. A conversation with 8 turns might use 60K because the agent read three large files. You need both triggers:

```
Compression triggers (either fires the pipeline):

  Turn count:   turns.length > 20          <- slow bleed of many small messages
  Token budget: estimatedTokens > 80K x 0.7  <- sudden spike from large tool output
```

The 0.7 multiplier is the fuel light in your car: you want the warning before you're stranded, not after. It leaves 30% buffer between "start compressing" and "context is actually full" — enough room to complete compression before the next LLM call.

---

## The Three-Tier Compression Waterfall

Compression is not a single operation. It's a three-tier escalation, designed so that **the system always produces a result** — even when the LLM summarizer itself fails.

```
Tier 1: LLM Summarization (normal)
  |-- "Summarize in 3-5 bullet points, under 500 chars"
  |-- maxTokens: 300
  |-- Success rate: ~95%
  '-- Fail? --> Tier 2

Tier 2: LLM Summarization (aggressive)
  |-- "2-3 key facts, max 200 chars"
  |-- maxTokens: 150, temperature: 0.05
  |-- Low temp = accuracy over creativity
  '-- Fail? --> Tier 3

Tier 3: Deterministic Truncation
  |-- First 2,048 chars of transcript + header
  |-- No LLM involved -- pure string slicing
  '-- ALWAYS succeeds -- the crash-proof backstop
```

**Tier 1** preserves semantics — *what the user wanted, what decisions were made, what state we're in* — at a fraction of the original tokens. A 30-turn, 40K-token conversation becomes a 200-token summary.

**Tier 2** drops to near-zero temperature because when you're summarizing for context management, a hallucinated detail in the summary can send the agent down the wrong path for the rest of the session.

**Tier 3** exists because a production system that falls back gracefully beats a system that produces perfect summaries 99% of the time and hard-crashes the other 1%.

All three tiers cache by `conversationId:turnCount`. Same compression boundary = cache hit = zero LLM calls.

---

## Fresh Tail Protection: The Messages You Must Never Compress

Here's a mistake that will cost you days: you compress the conversation history, and the agent immediately forgets what it's doing *right now*. The summary captures the broad arc, but it doesn't capture the specific file the agent just opened, the exact error from the last command, or the user's most recent instruction.

**Fresh Tail Protection** guarantees that the most recent N messages are never touched by compression. In our case, the tail count (32) is deliberately *larger* than the compression trigger threshold (20). This means turn-count-triggered compression mostly fires to catch chatty conversations, while the token budget threshold handles the real emergencies — a small number of turns containing disproportionately large content.

There's an additional subtlety: if the split point between "compress" and "keep" lands on a `tool` result message, it's pushed forward until it lands on a `user` or `assistant` message. This prevents orphaning a tool result from its corresponding tool call — which would cause an API validation error, not a degraded response.

---

## Tool Pair Safety: The Edge Case That Breaks Everything

Every LLM API enforces a strict contract: a `tool_use` block in an assistant message *must* be followed by a matching `tool_result`. Break this contract and you get a 400 error — not degraded output, an outright rejection.

Compression creates two flavors of orphan:

| Failure Mode | Cause | Fix |
|---|---|---|
| **Orphaned tool result** | Tool result references a call that was compressed away | Remove the orphaned result block (block-level, not message-level) |
| **Orphaned tool call** | Assistant's tool call has no matching result in surviving messages | Insert a stub result: *"[Result from earlier conversation — see summary above]"* |

The critical detail is that this operates at the **block level**. A single tool message might contain results for multiple tool calls — some surviving, some orphaned. You can't discard the entire message; you have to surgically remove only the orphaned blocks.

**Without `sanitizeToolPairs`, any context management strategy that touches history will eventually produce an invalid message sequence.** And "eventually" in production means "the first time a power user has a 30-turn coding session."

---

## Frozen Snapshot: Making the System Prompt Cacheable

Anthropic's prompt caching gives you a significant discount on tokens in a stable prompt prefix. If your system prompt changes every turn — because you're dynamically injecting fresh memories or skill catalogs — you lose that benefit entirely.

Our solution is the **Frozen Snapshot**: the first time `buildContext` is called for a conversation, it builds the dynamic context (memories, skill catalog) and caches it. Every subsequent turn reuses the cached version.

```typescript
// Frozen snapshot: built once per conversation, reused for the session.
// Memory writes persist to DB but don't alter the system prompt --
// keeping it stable for prefix cache efficiency.
if (this.dynamicContextCache.has(conversationId)) {
  const cached = this.dynamicContextCache.get(conversationId)!;
  dynamicSuffix = cached.suffix;
} else {
  const result = await this.buildDynamicContext(currentInput, options);
  this.dynamicContextCache.set(conversationId, { suffix: result.suffix, ... });
  dynamicSuffix = result.suffix;
}
```

The tradeoff is explicit: if a user stores a new memory mid-session, it persists to the database but doesn't appear in the system prompt until the next session. This is deliberate — the agent can reference recent conversation history for anything it just learned, and prompt stability for caching outweighs intra-session memory freshness.

---

## The Offload Escape Hatch: Lossy With a Lossless Backup

Compression is lossy by definition. No summary preserves every detail of a 50-turn conversation. So what happens when the agent needs to recall something specific from the compressed portion?

When compression fires, the full transcript of the compressed turns is written to disk:

```
data/tmp/{conversationId}/conversation_history.md
```

The summary includes a reference: *"Full history saved to: {path} (use file_read to review if needed)."* This creates a two-tier memory architecture:

| Tier | Access Method | Speed | Fidelity | Token Cost |
|---|---|---|---|---|
| Summary in context | Always visible to LLM | Instant | Lossy | ~200 tokens |
| Full transcript on disk | LLM must call `file_read` | 1 tool call | Lossless | On-demand |

This pattern — **lossy compression with lossless backup** — mirrors how humans use notes. Your meeting notes are a lossy summary; the full recording is the lossless backup. You check the notes 99% of the time and pull up the recording only when the notes aren't enough.

---

## Observation Compression: The 80% You Can Throw Away

Beyond conversation-level compression, a second layer targets individual tool results. Most tool output is noise from the agent's perspective — verbose logging, formatting whitespace, repeated structures — and only a fraction contains the information the agent actually needs to reason about.

Observation compression runs on all tool results except the two most recent ones. It applies a four-pass extraction, in priority order:

1. **Error lines** (highest priority): `error`, `exception`, `fail`, `ENOENT`, `denied`
2. **Status lines**: `success`, `created`, `updated`, `total`, `count`
3. **JSON key fields**: `id`, `name`, `status`, `error`, `message`, `path`, `url`
4. **Head/tail lines**: first 3 + last 2 lines if the above yield fewer than 3 matches

Plus **content fingerprint deduplication**: if two tool results share the same first 200 characters, the second collapses to *"[Duplicate result — same as earlier message]"*.

Real compression ratios from production:

| Content Type | Before | After | Savings |
|---|---|---|---|
| Shell output with errors | 2,100 chars | 380 chars | **82%** |
| JSON API response | 4,500 chars | 290 chars | **94%** |
| File listing (200 files) | 8,400 chars | 350 chars | **96%** |

A separate **basic compression** layer runs unconditionally on all tool results — collapsing excessive blank lines, normalizing tabs to spaces, and minifying JSON blobs. These semantic-preserving transformations save 3–12% on their own.

---

## The Full Pipeline

Here's every step, in execution order:

```
  Load history from SQLite (up to maxHistoryTurns)
       |
       v
  Check triggers: turn count > 20  OR  estimated tokens > 56K?
       |                                     |
      YES                                   NO --> use history as-is
       |
  Split into old turns + fresh tail (32 msgs protected)
       |
  Compress old turns (3-tier waterfall)
       |
  Offload full transcript to disk
       |
  Assemble: [summary] + [ack] + [fresh tail]
       |
       v
  Frozen snapshot: build or reuse dynamic context (memories + skills)
       |
  Extract large content: tool results >12K chars -> disk + summary
       |
  Compress observations: older tool results -> 4-pass extraction
       |
  Sanitize tool pairs: fix orphaned tool_call / tool_result blocks
       |
  Basic compression: whitespace normalization + JSON minification
       |
       v
  Assemble: system prompt + dynamic suffix + processed messages -> LLM
```

Nine steps. Each one exists because we hit a real production failure without it. The order matters: large content extraction before observation compression (so the compressor doesn't choke on a 100K blob), tool pair sanitization *after* all message-modifying steps (so it catches every orphan), basic compression last (so it doesn't interfere with structured extraction).

---

## Trade-offs: What We Evaluated and Rejected

**Aggressive history truncation** (keep only last N messages): Breaks multi-step tasks. The agent forgets what it edited 5 steps ago and re-reads the file. Our tiered compression preserves *what happened* while discarding *the raw output*.

**Intra-session memory refresh** (update system prompt with new memories mid-conversation): Kills prompt cache hit rates. The 10% cost savings from fresh memories doesn't compensate for losing the ~90% caching discount on every subsequent call.

**Per-tool compression strategies** (different compression logic per tool type): Too much complexity for marginal gains. The four-pass extraction with error/status/JSON/head-tail priority handles every tool type we've tested — shell, file reads, API responses, search results.

---

## Five Things to Do Monday Morning

1. **Measure your actual context usage before you optimize.** Add logging that tracks token count per turn. You'll be shocked how fast it grows — and you'll see exactly where the bloat comes from (hint: it's almost always tool results, not conversation text).

2. **Set a token budget and trigger compression at 70%.** Don't wait for overflow. 60% of your model's context window is a safe default.

3. **Protect the fresh tail.** The last N messages are sacred. Compress everything else. If you compress the agent's recent working memory, it will immediately re-read files and re-run commands — costing more tokens than you saved.

4. **Sanitize tool pairs after every history modification.** This is non-negotiable. One orphaned tool call = one 400 error = one failed user request.

5. **Offload full transcripts to disk.** Compression is lossy — give your agent a way to recover details when it needs them. The `file_read` escape hatch costs one tool call; re-doing the work from scratch costs ten.

**The context window is the most expensive resource in your entire stack — more expensive than compute, more expensive than storage, more expensive than network. Manage it like it matters.**

---

*The code behind this article is open-source: [github.com/vorojar/AgentClaw](https://github.com/vorojar/AgentClaw). The context management system lives in [`packages/core/src/context-manager.ts`](../../packages/core/src/context-manager.ts).*

*If you're building an agent framework, at least 3 of the problems described here exist in your codebase right now. [Star the repo](https://github.com/vorojar/AgentClaw) if this helped, and tell us what we missed — we're [@ponyinhouse](https://x.com/ponyinhouse) on X.*

*Next in series: [Part 4 — Memory Beyond the Context Window](./04-memory-beyond-context.md)*
