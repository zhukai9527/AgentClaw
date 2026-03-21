# Your AI Agent Will Run Forever Unless You Build These 5 Safety Nets

*Part 1 of "Building AI Agent Frameworks" — a series on the engineering behind autonomous AI agents.*

*By Jaro & Claude | March 2026*

---

You hooked up an LLM to a set of tools. It can read files, search the web, execute code. Impressive demo. Then a user asks it to "refactor the auth module," and twenty minutes later it's still running — burning tokens, repeating the same failed shell command, stuck in a loop it can't recognize.

**An LLM without a loop is a chatbot. An LLM with a loop and no brakes is a billing disaster.**

We know because we built [AgentClaw](https://github.com/vorojar/AgentClaw), an open-source agent framework running in production across Telegram, WhatsApp, DingTalk, and more. After watching agents burn through iterations on format errors, repeat themselves endlessly, and spawn sub-agents that spawn more sub-agents, we learned that the loop — not the model, not the tools — is the make-or-break abstraction.

This article breaks down the Think-Act-Observe loop from the ground up: the core iteration cycle, five layers of termination defense, and the escalation mechanisms that turn a stuck agent into a self-aware one. Every pattern comes from production code. None of it requires a specific framework.

> *Full disclosure: this article was co-written with Claude. The code, data, and decisions are ours; the prose was a collaboration.*

---

## The Core Insight

Here it is in one sentence:

> **The loop is what turns "answering questions" into "completing tasks" — and every failure mode in agent systems is a failure of loop control.**

Tool selection, context management, memory — they all matter. But they operate *inside* the loop. If the loop itself doesn't know when to stop, when to retry, and when to escalate, nothing else matters.

---

## The Core Loop: Think, Act, Observe

Every agentic system, regardless of framework, runs the same fundamental cycle:

```
┌─────────────────────────────────────────────────────┐
│                    AGENT LOOP                       │
│                                                     │
│   ┌──────────┐    ┌──────────┐    ┌──────────────┐  │
│   │  THINK   │───→│   ACT    │───→│   OBSERVE    │  │
│   │          │    │          │    │              │  │
│   │ LLM call │    │ Execute  │    │ Append tool  │  │
│   │ decides  │    │ tool     │    │ results to   │  │
│   │ next     │    │ calls    │    │ conversation │  │
│   │ action   │    │          │    │              │  │
│   └──────────┘    └──────────┘    └──────┬───────┘  │
│        ↑                                 │          │
│        └─────────────────────────────────┘          │
│                                                     │
│   EXIT when:                                        │
│    • LLM produces text with NO tool calls (done)    │
│    • maxIterations reached                          │
│    • Shared budget exhausted                        │
│    • User abort signal                              │
│    • 3 consecutive all-error iterations             │
└─────────────────────────────────────────────────────┘
```

1. **Think** — Send conversation history + tool definitions to the LLM. The model decides: respond to the user, or call a tool.
2. **Act** — Execute tool calls. File reads, shell commands, API calls, whatever the registry provides.
3. **Observe** — Feed tool results back as new messages. Go to step 1.

The loop terminates when the model produces a response with *no tool calls* — a plain text answer. That's the signal it believes it's done.

Here's the skeleton in pseudocode:

```
while iterations < maxIterations and not aborted:
    if budget?.exhausted: break
    iterations++
    budget?.consume()

    // THINK: ask the LLM what to do
    response = provider.stream(systemPrompt, messages, tools)

    // If no tool calls, we're done — yield final response
    if response.toolCalls is empty:
        yield response_complete(response.text)
        return

    // ACT: execute each tool call
    for toolCall in response.toolCalls:
        result = toolRegistry.execute(toolCall.name, toolCall.input)

    // OBSERVE: append results to conversation history
    messages.append(assistantMessage + toolResults)

// Fell through — max iterations reached
yield fallback_response()
```

Simple enough. But this skeleton hides every hard problem. What if the LLM calls the same failing tool ten times? What if a sub-agent spawns another sub-agent that spawns another? What if the model's JSON is malformed and every tool call errors? What if the model produces the same output three times in a row, clearly stuck?

Each of these failure modes requires a specific defense. Here are the five layers we built.

---

## The 5 Layers of Loop Defense

| Layer | What It Catches | Mechanism | Trigger |
|-------|----------------|-----------|---------|
| 1. Iteration Cap + Shared Budget | Runaway sessions, sub-agent explosion | Hard ceiling, shared budget object | `iterations >= max` or `budget.exhausted` |
| 2. Per-Tool Failure Tracking | Repeated failing calls, duplicate calls | Dedup key fingerprinting, per-tool-name caps | 2 failures same key, or 40 total calls |
| 3. Format Error Rollback | Malformed JSON, tool-not-found | Delete bad turns, retry transparently | All calls in iteration are format errors |
| 4. Three-Strike Escalation | Agent stuck but not failing | Output fingerprint similarity detection | 3 consecutive >80% similar iterations |
| 5. Consecutive Error Auto-Stop | Hopeless iteration sequences | Count all-error iterations | 3 consecutive all-error iterations |

---

## Layer 1: The Iteration Cap and Shared Budgets

The simplest defense is a hard ceiling on iterations. In practice, a default of 15 handles the vast majority of tasks — from simple Q&A (1 iteration, no tools) to complex multi-step operations (8-12 iterations).

But a flat cap breaks down with sub-agents. If a parent has 15 iterations and spawns a child that also has 15, you've doubled your budget. Spawn three children and you're at 60. The solution is a **shared iteration budget**:

```
class IterationBudget:
    max: number
    used: number = 0

    consume(n = 1):  used += n
    unconsume(n = 1): used = max(0, used - n)
    remaining:       max - used
    exhausted:       used >= max
```

The parent creates the budget. Every child receives *the same object by reference*. When a child consumes an iteration, it decrements from the parent's pool. **The total work across all agents in a hierarchy is bounded by a single number.** No agent tree can outgrow the root budget.

One subtlety: `unconsume()` exists because certain operations shouldn't count. Loading a skill definition is overhead, not real work. When the *only* tool call in an iteration is `use_skill`, the loop gives the iteration back — up to 3 free skill loads per session.

---

## Layer 2: Per-Tool Failure Tracking

The iteration cap is a blunt instrument. A smarter defense operates at the tool level with four independent counters:

**Per-call failure tracking.** Every tool call gets a deduplication key built from the tool name and a fingerprint of its arguments. After 2 failures with the same key, the loop short-circuits — instead of executing the tool, it returns an error telling the model to stop retrying. Crucially, *changing the arguments resets the counter*. A corrected command is a new attempt, not a retry.

**Duplicate call detection.** Even successful calls can loop. If the model calls `web_search` with identical parameters three times, something is wrong. After 2 identical calls, the loop blocks the third: "You already have this result. Synthesize from existing information."

**Global per-tool-name limits.** Some tools have session-wide caps: 8 web searches, 8 web fetches. These are total, not per-parameter. After the limit, the model gets a firm directive to work with what it has.

**The absolute safety net: global call count.** Across all tools, all parameters, the entire session gets a hard cap of 40 tool calls. When triggered, the message is unambiguous: "You MUST stop using tools and respond immediately."

**The key principle: every limit message is a directive, not an observation.** Don't tell the model "limit reached." Tell it exactly what to do. LLMs follow instructions — unclear messages produce unclear behavior.

---

## Layer 3: Format Error Rollback

Here's a failure mode most agent builders discover the hard way: the LLM generates malformed JSON in its tool call arguments. The tool call fails with a parse error. The error gets appended to conversation history. The LLM sees the error and tries again — but now the conversation is polluted with a broken call and its error, wasting context window space.

The solution is **rollback**: when *every* tool call in an iteration fails due to format errors (JSON parse failure or tool-not-found), the loop:

1. Deletes the assistant message and all tool result messages from conversation history
2. Decrements the iteration counter (and gives the budget back via `unconsume()`)
3. Continues to the next iteration — from the LLM's perspective, the malformed attempt never happened

This is capped at 3 consecutive rollbacks. After the third, the errors stay in history and the model must deal with them. The rollback counter resets whenever an iteration has at least one successful tool call.

**Format errors are the LLM's typos — you don't penalize a human for a typo, you just let them re-type.** The rollback mechanism applies the same principle: don't waste an iteration on something the model will self-correct given a clean slate.

---

## Layer 4: The Three-Strike Escalation

This is the subtlest defense and, in practice, the most valuable. **Sometimes the agent isn't failing — it's succeeding at the wrong thing.** It reads a file, doesn't find what it needs, reads a slightly different file, doesn't find it there either, reads the first file again. No errors. No duplicate calls (the parameters differ slightly). But it's clearly stuck.

Detection works by fingerprinting: each iteration's output is reduced to a normalized string — the first 300 characters of LLM text plus a sorted list of tool names called. The loop keeps a sliding window of the last 3 fingerprints. If all three are more than 80% similar (character-level overlap), the agent is stuck.

When triggered, a strategy-change directive is injected:

> "You appear to be stuck in a loop — your last 3 responses were very similar. STOP repeating the same approach. Try a completely different strategy: use different tools, change parameters, or explain to the user what's blocking you."

This fires exactly once per session (a boolean flag prevents re-triggering). The insight: **stuck agents don't need more iterations — they need a perspective shift.** The escalation message provides it.

---

## Layer 5: Consecutive Error Auto-Stop

The final defense: if 3 consecutive iterations produce *nothing but errors* (every tool call in the iteration failed), the loop breaks immediately. No fallback response, no additional LLM calls. The agent has clearly lost the thread.

This catches scenarios that per-tool limits miss — when the model alternates between *different* failing tools, so no single tool hits its individual limit, but the overall trajectory is hopeless.

---

## Making the Loop Observable

A loop you can't see is a loop you can't debug. The agent emits structured events at every state transition:

```
ITERATION 1
  ├── thinking          (LLM call starting)
  ├── response_chunk    (streaming text token)
  ├── response_chunk    (streaming text token)
  ├── tool_call         (grep: "Find auth middleware")
  ├── tool_result       (found 3 matches, 45ms)
  ├── tool_call         (file_read: "Read the match")
  └── tool_result       (returned 120 lines, 12ms)
ITERATION 2
  ├── thinking
  ├── response_chunk ...
  └── response_complete (final answer, 2 iterations, 1,847 tokens)
```

Every event carries a timestamp. The gateway forwards them over WebSocket to the UI, where users see tool calls executing in real time. The same events feed into a trace system for post-hoc debugging.

---

## Trade-offs We Evaluated and Rejected

**LLM-based loop detection** (asking the model "are you stuck?"): Requires an extra LLM call per iteration. The fingerprint approach is zero-cost and catches the same patterns.

**Aggressive timeout per tool** (kill any tool after 10 seconds): Kills legitimate long-running operations like large file reads or slow APIs. We use tool-specific timeouts instead — shell commands get 120s, web fetches get 30s.

**Letting the model manage its own iteration count** ("you have 15 iterations remaining"): The model ignores it. System-level enforcement is the only reliable approach.

---

## Five Things to Do Monday Morning

1. **Add an iteration budget, not just a cap.** If your agents can spawn sub-agents, a flat `maxIterations` is insufficient. Pass a shared budget object by reference to every child.

2. **Track tool failures by dedup key, not just tool name.** A failure with parameters A shouldn't block a retry with parameters B. Build a fingerprint from name + key arguments, and reset on parameter change.

3. **Implement format error rollback.** When every tool call in an iteration fails due to JSON parse errors, delete the messages and retry silently. Cap at 3. This alone eliminates a class of wasted iterations.

4. **Add fingerprint-based stuck detection.** Reduce each iteration's output to first N characters + tool names. If 3 consecutive fingerprints are >80% similar, inject a strategy-change directive. Fire once.

5. **Make every limit message a directive.** Don't say "limit reached." Say "Stop calling tools. Respond to the user now with the information you have." LLMs follow instructions — unclear messages produce unclear behavior.

---

*The code behind this article is open-source: [github.com/vorojar/AgentClaw](https://github.com/vorojar/AgentClaw). The agent loop lives in `packages/core/src/agent-loop.ts`.*

*If you're building agents, at least 2 of these failure modes are in your codebase right now — you just haven't hit them yet. [Star the repo](https://github.com/vorojar/AgentClaw) if these patterns save you from an infinite loop, and tell us what we missed — we're [@vorojar](https://x.com/nicekid_zhuo) on X.*

*Next in series: [Part 2 — Tool System Design: Give Your Agent Hands](./02-tool-system-design.md)*
