# 22 Tools, 40,000 Tool Calls, and the 5 Failure Modes Nobody Warns You About

*Part 2 of "Building AI Agent Frameworks" — a series on the engineering behind autonomous AI agents.*

*By Jaro & Claude | 2026*

---

You built the agent loop. The LLM can think. It produces eloquent paragraphs about how it *would* write the file, how it *would* run the query, how it *would* search the codebase. Except it can't do any of that. It's a brain in a jar.

The moment you give it tools, everything changes — and everything breaks.

We learned this building [AgentClaw](https://github.com/vorojar/AgentClaw), an open-source agent framework running in production across Telegram, WhatsApp, DingTalk, and half a dozen other channels. Our tool system has processed hundreds of thousands of calls across 22 registered tools. Every design decision in this article comes from watching what happens when a probabilistic model gets its hands on `shell`, `file_write`, and `web_search` in a real deployment.

Here's the core insight:

> **A tool system is not a function registry. It's a runtime that must handle the same failure modes as a distributed system — timeouts, retries, partial failures, resource exhaustion — except your "caller" is a model that will cheerfully retry the same broken command 47 times.**

> *Full disclosure: this article was co-written with Claude. The code, data, and decisions are ours; the prose was a collaboration.*

---

## The Tool Interface: Fewer Fields Than You Think

When we started, we over-engineered it. Custom validators, middleware chains, capability negotiation. We ripped it all out. The entire interface a tool must implement has six fields:

```typescript
interface Tool {
  name: string;                    // Unique identifier
  description: string;             // What the LLM reads to decide when to use it
  parameters: ToolParameterSchema; // JSON Schema for input validation
  category: "builtin" | "external" | "mcp";
  pure?: boolean;                  // Read-only, no side effects → can run in parallel
  execute(input, context?): Promise<ToolResult>;
}
```

That's it. Name, description, parameters, execute. The `description` is the most important field — not for you, for the model. A bad description means the LLM calls `grep` when it should call `glob`, or passes a regex where it needs a glob pattern. **We've rewritten tool descriptions more times than tool implementations.**

The `parameters` field is standard JSON Schema. No custom DSL, no decorators. LLM providers already speak JSON Schema natively — any translation layer is a source of bugs.

`ToolResult` is equally minimal: a `content` string, an optional `isError` boolean, and `metadata` for framework-internal signals. Two special fields — `autoComplete` (the tool's output *is* the final response) and `handoffTo` (transfer to another agent) — handle 95% of control flow needs without a state machine.

The `context` parameter is where dependency injection happens. Rather than giving every tool access to every system capability, we pass a `ToolExecutionContext` — a bag of optional callbacks that the gateway layer provides: `promptUser`, `sendFile`, `saveMemory`, `scheduler`, `abortSignal`, `toolHooks`. A `grep` tool never touches `sendFile`. A `remember` tool never touches `scheduler`. This is how the same tool implementation works identically in a CLI, a Telegram bot, and a REST API.

---

## Tiered Loading: The Menu Problem

Our first instinct was to register all tools at startup and send the full list to every LLM call. Twenty-two tool definitions. Around 2,000 tokens of schema, repeated on every single call.

The token cost matters (see [Part 5](./05-the-token-economy.md)), but it's not the real problem. **The real problem is decision quality. Give a model 25 tools and watch it pick `sandbox` when it should pick `shell`, or call `subagent` for a task it could handle in two lines of bash.**

So we split tools into two tiers:

| Tier | Tools | When Loaded | Count |
|------|-------|-------------|-------|
| **Core** — always available | shell, file_read, file_write, file_edit, glob, grep, ask_user, web_fetch, web_search, context_search, compact | Every session | 11 |
| **Conditional** — gateway mode | send_file, schedule, update_todo, sandbox, subagent, browser_cdp, social_post, handoff, execute_code | `options.gateway = true` | +9 |
| **Conditional** — memory | remember | `options.memory = true` | +1 |
| **Conditional** — skills | use_skill | `options.skills = true` | +1 |
| **Conditional** — Claude Code | claude_code | `options.claudeCode = true` | +1 |

A CLI session sees 11 tools. A fully-loaded gateway session sees 22. The system prompt is automatically pruned to remove references to unavailable tools — no dangling instructions pointing at tools that don't exist.

We measured a ~15% reduction in "wrong tool" calls after implementing tiered loading. The model simply makes better choices when the menu is shorter.

---

## Parallel Execution: Pure vs. Impure

Modern LLMs can request multiple tool calls in a single response. Claude might ask to `glob` for Python files *and* `grep` for import statements simultaneously. If you execute them sequentially, you're leaving 200-800ms per iteration on the table.

But you can't blindly parallelize everything. If the model asks to `file_write` and then `shell` run the file, order matters. Our solution: the `pure` flag.

```
Model requests: [glob, grep, file_write, grep, grep]

Execution plan:  ├─parallel─┤  ├─barrier─┤  ├─parallel─┤
                  glob+grep    file_write    grep+grep
                  (Promise.all) (sequential) (Promise.all)
```

A **pure tool** is read-only with no side effects — `glob`, `grep`, `file_read`, `web_search`. An **impure tool** modifies state — `shell`, `file_write`, `file_edit`. At execution time, consecutive pure tools form a parallel batch; each impure tool acts as a barrier. The batching logic is ~30 lines of code and the latency savings compound across every multi-tool iteration.

---

## Failure Handling: Four Layers Deep

Here's what happens without failure handling: the LLM calls `web_search("latest React docs")`. The search engine is down. The tool returns an error. The LLM thinks "I should try again" and calls `web_search("latest React docs")`. Same error. Same retry. For 15 iterations until you hit the max.

**An LLM with access to tools but no failure guardrails is an infinite loop with a credit card attached.**

We handle this at four levels, each catching what the previous one missed:

| Layer | Mechanism | Visibility to LLM | What It Catches |
|-------|-----------|-------------------|-----------------|
| **1. Auto-retry** | Exponential backoff (2s, 4s) for network tools (`web_search`, `web_fetch`, `http_request`) | Invisible | Transient failures — DNS blips, rate limits, 503s |
| **2. Duplicate detection** | Hash of tool name + input params; block after N identical calls | Gets a redirect message | LLM retry loops with exact same parameters |
| **3. Per-tool failure cap** | Counter per unique tool+input combo; block after 2 failures | Gets a "stop retrying" message | Persistent failures the LLM keeps retrying with slight variations |
| **4. Global safety net** | Hard cap of 40 total tool calls per user message | Gets a "respond NOW" message | Any runaway pattern the other layers missed |

The dedup key (Layer 2) is smarter than a naive hash. For `bash`, it includes the first 80 characters of the command so that different commands aren't falsely deduplicated. For `file_read` on overflow files, it normalizes to a single key so the model can't endlessly read different overflow files in a loop.

These four layers work as a funnel: most transient failures never reach the model (Layer 1), most loops are caught before they waste more than one iteration (Layer 2), persistent errors get escalated to the user (Layer 3), and the global cap is the circuit breaker of last resort (Layer 4).

---

## Result Overflow: When Tools Talk Too Much

A model calls `shell("find . -name '*.ts' -exec wc -l {} +")` on a large project. The result: 47,000 characters. If you stuff that into conversation history, three things happen: you burn tokens on content the model will only skim, context fills up faster triggering expensive compression, and the model may hallucinate details from the middle of a giant wall of text.

Our solution: **overflow mode**. When a tool result exceeds 8,000 characters, the framework saves the full output to a temp file and replaces the result with a 1,500-character preview plus a file reference. The model gets enough context to understand the output's shape, plus a clear path to drill deeper with `file_read` or `grep`.

```
┌──────────────────────────────────────────────────────────────────┐
│  Tool output: 47,312 chars / 2,847 lines                        │
│                                                                  │
│  ┌────────────────────────────────────────────────────┐          │
│  │ Preview (first ~1,500 chars, cut at last newline)  │ → LLM   │
│  └────────────────────────────────────────────────────┘          │
│                                                                  │
│  ┌────────────────────────────────────────────────────┐          │
│  │ Full content → data/tmp/overflow_shell_170234.txt  │ → Disk  │
│  └────────────────────────────────────────────────────┘          │
│                                                                  │
│  LLM receives: preview + "use file_read or grep to explore"     │
└──────────────────────────────────────────────────────────────────┘
```

In practice, the model usually `grep`s the overflow file for what it needs rather than reading the whole thing — exactly the behavior we want.

Two edge cases we learned the hard way:

**Never overflow error messages.** Errors are short and high-signal. If a tool failed, the model needs the full stack trace. The overflow check explicitly skips `isError: true` results.

**Never overflow a file_read of an overflow file.** Without this guard, you get an infinite loop: model reads overflow → result overflows → model reads new overflow → forever. We detect overflow file paths and bypass the logic for those reads.

---

## MCP: External Tools Without Forking Your Repo

You built a clean tool system. Then someone asks: "Can I plug in my company's internal tools?" You could ask them to implement the `Tool` interface and rebuild. Or you could support [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) — a standard for connecting AI models to external tool servers.

Our MCP integration converts external tool schemas into the same `Tool` interface. Tools are namespaced with double-underscore convention (`playwright__browser_click`, `slack__send_message`) to avoid collisions between servers. They go through the exact same execution pipeline — same failure counting, same overflow, same dedup. The model doesn't know or care whether a tool is built-in or MCP-connected.

The limitation is intentional: MCP servers load at startup, not dynamically. Hot-reloading tool definitions mid-conversation creates a class of bugs we don't want — what happens to in-flight calls? What if the model already planned around a tool that just disappeared? Static loading is boring and correct.

---

## The Registry: Graceful Degradation

The `ToolRegistryImpl` is a `Map<string, Tool>` with register, unregister, get, list, and execute. The interesting behavior is in `execute()`:

When a tool name isn't found, before returning an error, the registry checks whether it matches a registered *skill*. Models sometimes confuse tools and skills, calling `agent-browser` (a skill) as if it were a tool. Instead of failing, we auto-redirect to `use_skill("agent-browser")`. This one check eliminates an entire class of wasted iterations where the model would otherwise get an error, apologize, and call the right thing — three messages for what should be zero.

The error message for genuinely missing tools includes the full list of available names: `Tool "X" does not exist. You can ONLY use: shell, file_read, ...`. Give the model corrective information, not just a failure signal.

The registry supports `clone()` and `filter()` for multi-agent setups. Sub-agents get a filtered registry with dangerous tools removed — no `subagent` (prevents recursion), no `remember` (prevents memory pollution), no `send_file` (prevents unauthorized file delivery).

---

## What We Got Wrong

**We underestimated description quality.** Our first `shell` description was "Execute a shell command." The model called it for everything — file reads, searches, downloads — when better tools existed. After rewriting descriptions with explicit guidance on *when to use* and *when to prefer alternatives*, wrong-tool rates dropped dramatically.

**We over-trusted the model's retry judgment.** Without framework-level retry, the model would retry with slight variations — changing a flag, adding quotes, tweaking the path — turning a simple "service unavailable" into a 10-iteration debugging session. Automatic retries with backoff catch transient failures before the model gets creative.

**We didn't plan for output size.** Our first overflow threshold was "none." A single `cat` of a large file dumped 200K characters into context, blew past the window, and crashed the conversation. The 8,000-character threshold was calibrated through production data: large enough that most useful outputs pass untouched, small enough that outliers don't destroy context budgets.

---

## Five Things to Do Monday Morning

1. **Keep the interface minimal.** Name, description, parameters, execute. Resist middleware, interceptors, and capability negotiation. You'll know when you need them — and you'll need them less than you think.

2. **Implement overflow before your first demo.** The first time a `find` command dumps 50,000 characters into context, you'll wish you had it. Save full output to disk, give the model a preview and a file path. This is 40 lines of code that prevents an entire category of failures.

3. **Add failure counting on day one.** Duplicate detection + per-tool failure limits + a global cap. Three counters that prevent your agent from burning $20 on a retry loop.

4. **Split tools into tiers.** Don't give every session every tool. Core tools always load; everything else is conditional. Fewer choices = better choices.

5. **Mark pure tools for parallel execution.** A single boolean flag per tool, ~30 lines of batching logic, and 200-800ms saved per multi-tool iteration.

---

*The code behind this article is open-source: [github.com/vorojar/AgentClaw](https://github.com/vorojar/AgentClaw). Tool system code lives in `packages/tools/src/` (registry + builtins) and `packages/core/src/agent-loop.ts` (execution, overflow, failure handling).*

*If you're building an agent framework, your tool system is where most of the production bugs will live — not in the LLM, not in the prompt, but in the messy reality of executing code and managing what comes back. [Star the repo](https://github.com/vorojar/AgentClaw) if this saved you design time, and tell us what failure modes we missed — we're [@vorojar](https://x.com/nicekid_zhuo) on X.*

*Next in series: [Part 3 — Context is All You Have: Managing the Window](./03-context-management.md)*
