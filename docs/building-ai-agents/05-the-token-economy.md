# We Were Burning $4,200/Month on LLM Tokens. Here's Where They Went.

*Part 5 of "Building AI Agent Frameworks" — a series on the engineering behind autonomous AI agents.*

*By Jaro & Claude | March 2026*

---

Your AI agent just ran 12 tool calls. Each one dumped the full output into context. By the fifth iteration, you're sending 68,000 tokens per LLM call — and 70% of them are stale tool results the model already processed three rounds ago.

**Your most expensive token is the one you send twice.**

We know because we measured it. We run [AgentClaw](https://github.com/vorojar/AgentClaw), an open-source agent framework in production across Telegram, WhatsApp, DingTalk, and more. After instrumenting every token, we found that over 70% of our spend was structural waste — not bad outputs, just the LLM re-reading its own homework.

This article is the exact breakdown: where the tokens went, and how we got 60% of them back. Every number is from production data. Every optimization is open-source.

> *Full disclosure: this article was co-written with Claude. The code, data, and decisions are ours; the prose was a collaboration. We think that's fitting for an article about an AI agent framework.*

---

## The Core Insight

Here it is in one sentence:

> **In an agent framework, 70% of token cost comes from the LLM repeatedly re-reading information it already processed.**

Tool outputs, write-operation arguments, stale history, static tool schemas — the model sees them again and again, iteration after iteration. Every optimization in this article is a variation of one idea: **don't send what the model already knows.**

## What a Single LLM Call Actually Costs

Before optimizing, we measured. Here's the anatomy of one agent LLM call:

```
┌─────────────────────────────────────────────┐
│ System Prompt              ~350 tokens      │
│ Dynamic Context (memories)  ~200-800        │
│ Tool Definitions (20 tools) ~1,500-2,000    │  ← static, repeated every call
│ Conversation History        ~variable       │  ← grows with every iteration
│ Current User Input          ~50-200         │
├─────────────────────────────────────────────┤
│ First call total            ~2,100-3,400    │
│ Fifth call total            ~40,000-68,000  │  ← this is the problem
└─────────────────────────────────────────────┘
```

We traced a real 3-round conversation after applying our optimizations:

| Round | Input Tokens | What Happened |
|-------|-------------|---------------|
| 1     | 42,350      | Listed files, read configs (4 tool calls) |
| 2     | 25,975      | Read two source files, 1,800 lines total |
| 3     | 17,454      | Asked about previous results |

Round 3 used **59% fewer tokens** than Round 1, despite having strictly more history. That's the compression pipeline at work.

---

## The Biggest Drain: Tool Results

This is the #1 cost driver in any agent framework. When your agent runs `ls -la` or reads a 500-line source file, the entire output enters conversation history. Next iteration, the model sees it all again.

One `file_read` = ~8,000 tokens. Three file reads = 24,000 tokens of historical output the model has already processed. And it keeps paying for them, every single iteration.

We built a four-tier compression pipeline. Each tier targets a different size range:

**Tier 1 — Large output offload (>8K chars).** Save the full content to disk, keep a 1,500-char preview + file reference in context. The model can read specific sections on demand. Saves 30-50% on file-heavy workflows.

**Tier 2 — Staleness replacement.** Before each LLM call, tool results older than 3 iterations are silently replaced with `[previous tool_name result]`. No LLM involved — pure string replacement, O(n) over messages.

**Tier 3 — Smart observation compression (>500 chars).** Instead of blindly truncating, we extract what matters:

```typescript
// Priority extraction order:
// 1. Error lines (highest signal — "ENOENT", "TypeError", "denied")
// 2. Status lines ("success", "created", "found 42 matches")
// 3. JSON key fields (id, name, status, error, path)
// 4. First/last lines for structural context
// + Content fingerprint dedup: identical first-200-chars → "See earlier result"
```

Real compression ratios:

| Content Type | Before | After | Savings |
|-------------|--------|-------|---------|
| Shell output with errors | 2,100 chars | 380 chars | 82% |
| JSON API response | 4,500 chars | 290 chars | 94% |
| File listing (200 files) | 8,400 chars | 350 chars | 96% |

**Tier 4 — JSON minification + whitespace normalization.** Pretty-printed JSON gets minified. Excessive blank lines collapse. Tabs become spaces. Saves 3-30% and **never changes semantics**. Runs on every tool result, every iteration.

---

## The One-Line Fix That Saves 15%

> **The LLM wrote it — it doesn't need to re-read it.**

When your agent calls `file_write` with 500 lines of code, those 500 lines stay in conversation history. But the model *generated* them — it knows what it wrote. Keeping the full content is pure waste.

```typescript
const TRUNCATE_TOOLS = new Set(["file_write", "file_edit", "execute_code", "bash"]);
const TRUNCATE_KEYS = new Set(["content", "new_string", "code", "command"]);

// After execution: keep first 50 chars as a reminder
if (TRUNCATE_TOOLS.has(name) && input[key]?.length > 50) {
  input[key] = input[key].slice(0, 50) + "... [truncated]";
}
```

The model sees `content: "import { useState } from 'react';\n\nex... [truncated]"` instead of the full file. It remembers what it wrote. This single optimization saved us 15-20% of per-conversation token cost.

---

## The Silent Killer: Invisible LLM Calls

Your traces show tokens for the main agent loop. But there are LLM calls happening in the background that don't appear in any dashboard.

**Memory extraction**: We had a background process calling the LLM every 3 user turns to extract long-term memories. Each call: ~3,000 input tokens (10 recent turns + 50 existing memories). A 30-turn conversation triggered 10 extraction calls = **30,000 tokens you never see in traces.**

Fix: Reduced frequency from every 3 turns to every 8. 60% fewer calls, no measurable impact on memory quality.

**Summarization cache miss**: When context gets too long, we summarize old turns via LLM. Our cache key was `${conversationId}:${latestTurnId}`. Every new message invalidated the cache and re-summarized — even though the *old* turns being summarized hadn't changed.

Fix: Key on `turns.length` instead of the latest turn ID. Same old turns = same summary = cache hit = zero LLM calls.

---

## Tool Definitions: The Tax You Forgot About

Every LLM call includes the full JSON schema of every registered tool. We have 20+ tools. We measured: **~1,500-2,000 tokens per call** just for tool definitions.

In a 15-iteration agent loop, that's 30,000 tokens for the same static schema sent 15 times.

We audited every description and parameter. The biggest win: we had been injecting an `_intent: string` field into every tool's schema for tracing purposes. That's ~20 extra tokens × 20 tools = **400 tokens per call**, just to ask "why are you calling this tool?" We made it optional.

---

## System Prompt: Make It Cacheable

The system prompt goes with every call. Ours is ~700-1,200 tokens (personality + memories + skill catalog + platform hints).

The tokens aren't the problem — the cacheability is. Anthropic's API caches prompt prefixes: if your system prompt is byte-identical across calls, you pay ~90% less for those tokens.

We freeze the dynamic context (memories, skill catalog) on the first turn and reuse it for the entire session. Memories written during the session persist to the database but don't alter the system prompt. Result: perfect prefix cache hits, every iteration after the first.

---

## The Complete Pipeline

```
Tool executes
  → Overflow (>8K chars → disk + preview)         [Tier 1]
  → Argument truncation (write tools → 50 chars)   [One-line fix]

Before each LLM call:
  → Micro-compact (>3 rounds old → placeholder)    [Tier 2]
  → Observation compression (>500 chars → extract)  [Tier 3]
  → JSON minification + whitespace normalization    [Tier 4]
  → Frozen system prompt (prefix cache hit)
  → Summary cache (key by turn count)
```

---

## Results

Measured across three months of production traffic:

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Avg tokens/conversation | 85,000 | 34,000 | **-60%** |
| Avg tokens/iteration | 12,100 | 5,700 | **-53%** |
| Background LLM calls | 10/conversation | 4/conversation | **-60%** |
| P95 peak (single call) | 68,000 | 28,000 | **-59%** |

At Claude Sonnet pricing ($3/M input), a conversation dropped from $0.26 to $0.10. At our scale, that's **$1,600/month back in the budget.**

---

## Trade-offs: What We Evaluated and Rejected

**Dictionary compression** (replacing common strings with short codes like `$OC01`): Requires the LLM to "understand" an encoding scheme. Risks degrading output quality for 4-8% savings. Not worth it.

**Aggressive history truncation** (keep only last N messages): Breaks multi-step tasks. The LLM forgets what it edited 5 steps ago and re-reads the file. Our tiered compression preserves *what happened* while discarding *the raw output*.

**Model downgrading** (route simple queries to cheaper models): We built the infrastructure — a router with 14-dimension weighted scoring. But for agent tasks where tool selection matters, model quality directly impacts success rate. Reducing tokens-per-call saved more money than reducing price-per-token.

---

## Five Things to Do Monday Morning

1. **Measure your token breakdown by component.** You'll be shocked. Tool definitions alone might be 1,500+ tokens per call — repeated 15 times per conversation.

2. **Truncate write-tool arguments after execution.** One `if` statement, 15% savings. The model wrote it; it doesn't need to re-read it.

3. **Audit your invisible LLM calls.** Memory extraction, summarization, classification — they don't show up in per-conversation traces. They add up fast.

4. **Freeze your system prompt per session.** Enable provider-side prefix caching. Don't rebuild dynamic context every iteration.

5. **Compress in tiers, not with one hammer.** Giant outputs need disk offload. Medium outputs need smart extraction. Stale outputs need placeholders. Formatting waste needs minification. No single technique covers all four.

---

*The code behind this article is open-source: [github.com/vorojar/AgentClaw](https://github.com/vorojar/AgentClaw). Token optimization lives in `packages/core/src/context-manager.ts` and `agent-loop.ts`.*

*If you're building an agent framework, at least 3 of these sinks exist in your codebase right now. [Star the repo](https://github.com/vorojar/AgentClaw) if this saved you money, and tell us what we missed — we're [@vorojar](https://x.com/nicekid_zhuo) on X.*

*Next in series: [Part 6 — When LLMs Fail: Error Handling at Scale](./06-when-llms-fail.md)*
