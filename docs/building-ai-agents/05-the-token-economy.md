# The Token Economy: How We Cut LLM Costs by 60% in Our Agent Framework

*Part 5 of "Building AI Agent Frameworks" — a series on the engineering behind autonomous AI agents.*

*By Jaro & Claude | March 2026*

---

Every time your AI agent calls an LLM, you're paying for tokens. And in an agent framework — where the LLM is called repeatedly in a think-act-observe loop — those costs compound fast.

We built AgentClaw, an open-source AI agent framework that routes conversations across Telegram, WhatsApp, Slack, DingTalk, and more. After running it in production, we discovered something alarming: **over 70% of our token spend was waste**. Not hallucinations, not bad outputs — just structural overhead that the LLM never needed to see.

This article shows exactly where those tokens went, and how we clawed them back. Every number is from real production data, and every optimization is open-source.

## The Anatomy of a Single LLM Call

Before optimizing, you need to know what you're paying for. Here's the breakdown of a typical agent LLM call:

```
┌─────────────────────────────────────────────┐
│ System Prompt            ~350 tokens         │
│ + Dynamic Context        ~200-800 tokens     │
│   (memories, skill catalog)                  │
│ + Tool Definitions       ~1,500-2,000 tokens │
│ + Conversation History   ~variable           │
│   (user messages + assistant + tool results) │
│ + Current User Input     ~50-200 tokens      │
├─────────────────────────────────────────────┤
│ Total Input              ~2,100-3,400+ tokens│
└─────────────────────────────────────────────┘
```

That's the **first** call. By the third iteration of the agent loop, conversation history has ballooned with tool results — shell output, file contents, API responses — and you're sending 40,000+ tokens per call.

Here's what we measured across a real 3-round conversation:

| Round | Input Tokens | Tool Calls | What Happened |
|-------|-------------|------------|---------------|
| 1     | 42,350      | 4          | Listed files, read configs |
| 2     | 25,975      | 2          | Read two source files (~1,800 lines total) |
| 3     | 17,454      | 2          | Asked about previous results |

Round 3 processed **59% fewer tokens** than Round 1, despite having more conversation history. That's our compression pipeline at work.

## The Five Token Sinks (And How to Fix Each One)

### Sink 1: Tool Results Are Enormous

This is the #1 cost driver in any agent framework. When your agent runs `cat package.json` or `ls -la`, the entire output goes into conversation history. Next iteration, the LLM sees it all again — even though it already processed it.

A single `file_read` of a 500-line source file dumps ~8,000 tokens into the context. By the third tool call, you've spent 24,000 tokens just on historical tool output.

**Fix: Three-tier tool result compression**

We implemented a layered approach, inspired by [ClawRouter's](https://github.com/BlockRunAI/ClawRouter) observation compression:

**Tier 1 — Overflow at execution time (>8K chars)**

When a tool produces output exceeding 8,000 characters, we save the full content to disk and replace the result with a preview + file reference:

```
[Output saved to /data/tmp/overflow_abc123.txt — 45,892 chars]

Preview (first 1,500 chars):
drwxr-xr-x  12 user group  4096 Mar 21 ...
...

Use file_read to explore the full output.
```

The LLM gets enough context to decide its next step, and can read specific sections on demand. This alone saves 30-50% on file-heavy workflows.

**Tier 2 — Micro-compact on every iteration**

Before each LLM call, we silently replace tool results older than 3 iterations with `[previous tool result]`. No LLM involved — pure string replacement:

```typescript
// Runs every iteration, O(n) over messages
const KEEP_RECENT = 3;
const MIN_LENGTH = 100;

for (const idx of olderToolMessages) {
  if (content.length > MIN_LENGTH) {
    content = `[previous ${toolName} result]`;
  }
}
```

**Tier 3 — Smart observation compression for old results (>500 chars)**

This is where it gets interesting. Instead of blindly truncating old tool results, we extract the information that matters:

```typescript
// Priority extraction:
// 1. Error lines (highest signal)
// 2. Status/result lines
// 3. JSON key fields (id, name, status, error, path)
// 4. First/last lines for context

// Also: content fingerprint deduplication
// If two tool results start with the same 200 chars → "See earlier result"
```

Real compression ratios:

| Content Type | Original | Compressed | Savings |
|-------------|----------|------------|---------|
| Shell output with errors | 2,100 chars | 380 chars | 82% |
| JSON API response | 4,500 chars | 290 chars | 94% |
| File listing (200 files) | 8,400 chars | 350 chars | 96% |

**Tier 4 — JSON minification + whitespace normalization**

The simplest optimization with the best effort-to-savings ratio. Tool results containing pretty-printed JSON get minified; excessive whitespace gets normalized:

```typescript
// JSON: {"id": 1,\n  "name": "test"\n} → {"id":1,"name":"test"}
// Whitespace: collapse 3+ newlines → 2, tabs → 2 spaces, 4+ spaces → 2
```

This saves 3-30% depending on content, and **never changes semantics**. It runs on every tool result, every iteration.

### Sink 2: Tool Definitions Are Per-Call Overhead

Every LLM call includes the full schema of every registered tool. In our framework, that's 20+ tools with parameter descriptions, types, and enums.

We measured: **~1,500-2,000 tokens per call** just for tool definitions. In a 15-iteration agent loop, that's 22,500-30,000 tokens — for the same static information repeated 15 times.

**Fix: Ruthless description pruning**

We audited every tool description and parameter schema:

| Before | After | Saved |
|--------|-------|-------|
| `execute_code`: 280 chars explaining 8 global functions | 120 chars: "Execute JavaScript. Globals: web_search/web_fetch/..." | 40 tokens |
| `remember.type`: 180 chars explaining 5 types | "identity/fact/preference/entity/episodic" (enum is self-documenting) | 30 tokens |
| Every tool: `_intent` field injected into schema | Made optional, not required | 400 tokens total |

The `_intent` field deserves special attention. We were injecting a `_intent: string` parameter into every tool's schema to trace why the LLM called each tool. At ~20 tokens per tool definition × 20 tools = **400 tokens per LLM call**, just for intent tracing. We made it optional — the LLM still provides it when useful, but the schema overhead dropped significantly.

### Sink 3: Compression LLM Calls (The Hidden Tax)

When conversation history gets too long, most frameworks use an LLM to summarize older messages. This is correct — but the implementation details matter enormously.

**Problem 1: Cache key invalidation**

Our initial implementation:
```typescript
const cacheKey = `${conversationId}:${turns[turns.length - 1].id}`;
```

Every new message created a new turn ID, which invalidated the summary cache, which triggered a new LLM summarization call — even though the *old* turns being summarized hadn't changed.

**Fix:** Key on the number of turns being summarized, not the latest turn:
```typescript
const cacheKey = `${conversationId}:${turns.length}`;
```

Same old turns = same summary. Cache hit. Zero LLM calls.

**Problem 2: Memory extraction frequency**

We had a background process calling the LLM every 3 turns to extract long-term memories from the conversation. Each call sent the last 10 turns + 50 existing memories = ~1,700-4,700 input tokens.

For a 30-turn conversation: 10 extraction calls × ~3,000 tokens = 30,000 tokens. **Invisible in traces** because it's a side-channel LLM call.

**Fix:** Reduced frequency from every 3 turns to every 8 turns. 60% fewer calls, negligible impact on memory quality.

### Sink 4: System Prompt Inflation

The system prompt is sent with every single LLM call. Every token in it is multiplied by the number of iterations.

We audited our system prompt:

| Component | Tokens | Sent Every Call? |
|-----------|--------|-----------------|
| Base personality + rules | ~350 | Yes |
| Long-term memories | ~200-500 | Yes |
| Skill catalog | ~100-300 | Yes |
| Platform hints | ~50 | Yes |
| **Total** | **~700-1,200** | **Yes** |

**Fix: Frozen dynamic context**

Memories and skill catalog don't change during a conversation. So we compute them once and cache:

```typescript
// Built once per conversation, reused for all iterations
private dynamicContextCache = new LRUCache<string, DynamicContext>({ max: 5000 });

// First call: build memories + skill catalog → cache
// All subsequent calls: cache hit, zero computation
```

This doesn't save tokens directly (the content is the same), but it enables **provider-side prompt caching**. Anthropic's API caches prompt prefixes — if your system prompt is identical across calls, you pay ~90% less for those tokens. Our frozen snapshot ensures the prefix never changes mid-session.

### Sink 5: History That Should Have Been Forgotten

Not all conversation history is equally valuable. A `file_write` tool call that wrote 500 lines of code? The LLM doesn't need to see those 500 lines again — it wrote them.

**Fix: Argument truncation for write-heavy tools**

```typescript
const TRUNCATE_ARG_TOOLS = new Set(["file_write", "file_edit", "execute_code", "bash"]);
const TRUNCATE_ARG_KEYS = new Set(["content", "new_string", "code", "command"]);
const PREVIEW = 50; // chars

// After tool execution, truncate the input args in history
if (TRUNCATE_ARG_TOOLS.has(toolName)) {
  for (const key of TRUNCATE_ARG_KEYS) {
    if (parsedInput[key]?.length > PREVIEW) {
      parsedInput[key] = parsedInput[key].slice(0, PREVIEW) + "... [truncated]";
    }
  }
}
```

The LLM sees `content: "import { useState } from 'react';\n\nex... [truncated]"` instead of the full 500-line file. It knows what it wrote; it doesn't need to re-read it.

## The Complete Pipeline

Here's how all five optimizations stack in our processing pipeline:

```
Tool executes
  → Overflow (>8K chars → save to disk, keep preview)        [Tier 1]
  → Argument truncation (write tools → 50 char preview)       [Sink 5]

Each iteration, before LLM call:
  → Micro-compact (>3 rounds old → placeholder)               [Tier 2]
  → Smart observation compression (>500 chars → extract keys)  [Tier 3]
  → JSON minification + whitespace normalization               [Tier 4]
  → System prompt: frozen snapshot (cache hit)                 [Sink 4]
  → Summary cache: key by turn count (avoid re-summarization)  [Sink 3]
```

## Real-World Results

We measured token consumption across 100 production conversations before and after implementing the full pipeline:

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Avg tokens/conversation | 85,000 | 34,000 | **-60%** |
| Avg tokens/iteration | 12,100 | 5,700 | **-53%** |
| LLM summarization calls | 10/conversation | 4/conversation | **-60%** |
| P95 peak tokens (single call) | 68,000 | 28,000 | **-59%** |

At Claude Sonnet pricing ($3/M input tokens), a conversation that cost $0.26 now costs $0.10. At scale (10,000 conversations/month), that's **$1,600/month saved**.

## What We Didn't Do (And Why)

**Dictionary compression / codebook encoding**: ClawRouter implements static and dynamic codebooks that replace common strings with short codes (`$OC01` = `"unbrowse_"`). This requires the LLM to "understand" the encoding, which risks degrading output quality. We decided the complexity wasn't worth the 4-8% savings.

**Aggressive history truncation**: Some frameworks keep only the last N messages. We tried this and found it breaks multi-step tasks — the LLM forgets what files it edited 5 steps ago and re-reads them. Our tiered compression preserves *what happened* while discarding *the raw output*.

**Model downgrading**: Routing simple queries to cheaper models (GPT-4o-mini vs Claude Opus) can save 90%+ per call. We built the infrastructure for this (SmartRouter with 14-dimension scoring), but found that for agent tasks — where tool selection matters — model quality directly impacts success rate. We saved more money by reducing tokens-per-call than by reducing price-per-token.

## Takeaways

1. **Measure first**: Before optimizing, instrument your token consumption per component. We were shocked that tool definitions alone were 1,500-2,000 tokens per call.

2. **Compress in tiers**: No single technique works for everything. Overflow handles giant outputs, micro-compact handles staleness, observation compression handles medium results, and JSON minification handles formatting waste.

3. **Cache what doesn't change**: System prompts, skill catalogs, and summarization results should be computed once. Provider-side prompt caching amplifies this further.

4. **The LLM wrote it — it doesn't need to re-read it**: Truncating write-tool arguments is the highest-ROI optimization we implemented. One line of code, 15-20% savings.

5. **Invisible LLM calls are the silent killer**: Memory extraction, summarization, and classification calls don't show up in your per-conversation traces. Audit them separately.

---

*AgentClaw is open-source at [github.com/vorojar/AgentClaw](https://github.com/vorojar/AgentClaw). The token optimization code is in `packages/core/src/context-manager.ts` and `packages/core/src/agent-loop.ts`.*

*Next in series: [Part 6 — When LLMs Fail: Error Handling at Scale](./06-when-llms-fail.md)*
