# Every LLM Call Can Fail. Here's What Happens When You Plan for It.

*Part 6 of "Building AI Agent Frameworks" — a series on the engineering behind autonomous AI agents.*

*By Jaro & Claude | March 2026*

---

You shipped your agent. It works great in demos. Then production hits:

Anthropic returns 429 at 2 AM because your batch job collided with peak traffic. OpenAI gives you a 200 OK — but the body says "service temporarily unavailable." Your agent calls a tool with malformed JSON, the tool errors, and now the model tries the exact same broken call three iterations in a row, burning $0.40 per attempt while the user stares at a spinner.

**In an agent framework, LLM errors are not exceptions. They are control flow.**

We run [AgentClaw](https://github.com/vorojar/AgentClaw) in production across six messaging channels. Over three months, 11% of LLM calls returned something other than a clean response. Not 0.1%. Not 1%. Eleven percent. Rate limits, overloaded servers, malformed tool calls, degraded responses disguised as success — you name it, we've caught it.

This article is our complete error-handling playbook: how we classify errors, route around failures, and prevent the model from spiraling when it gets stuck. Every mechanism described here is open-source.

> *Full disclosure: this article was co-written with Claude. The code, data, and decisions are ours; the prose was a collaboration.*

---

## The Core Insight

> **A try-catch around your LLM call is not error handling. It's error hiding.**

Most agent frameworks treat LLM failures the way web apps treat database timeouts — retry, maybe log it, hope for the best. But in an agent loop, a failed LLM call doesn't just delay a response. It can corrupt conversation state, waste iteration budget, trigger cascading tool errors, or trap the model in an infinite retry loop. The correct response to a 429 is fundamentally different from the correct response to a 400, and treating them the same is how you get $200 surprise bills.

Every section in this article is a variation of one idea: **classify first, then react. Never retry blind.**

---

## Seven Kinds of Failure

The first thing we built was a classifier. Every error that comes back from any LLM provider passes through `classifyLLMError()`, which inspects the HTTP status code *and* the error message body to sort it into one of seven categories:

| Category | Trigger | Retryable? | What To Do |
|----------|---------|-----------|------------|
| `auth_failure` | 401, 403 (no quota keyword) | No | Stop. Your API key is wrong or revoked. No amount of retrying will fix this. |
| `quota_exceeded` | 403 + "quota" in body | No | Stop. You've hit a billing limit. Alert the operator. |
| `rate_limited` | 429, "rate limit", "too many requests" | Yes | Cool down 60 seconds, then try again — or switch models. |
| `overloaded` | 529, 503 + "overload" | Yes | Cool down 15 seconds. The provider is busy, not broken. |
| `server_error` | Any 5xx not matching above | Yes | Switch to the next model immediately. 30-second cooldown on the failed one. |
| `config_error` | 400, 413, "context length", "too long" | No | This model can't handle your request. Skip it — maybe the context is too large. |
| `network_error` | ECONNRESET, ETIMEDOUT, "fetch failed" | Yes | Transient. Retry after 10 seconds. |

Why seven categories instead of "retryable vs. not"? Because the *correct response* differs for each:

- A `rate_limited` error means **this model, right now** — wait and it'll work.
- A `server_error` means **this model might be down** — switch to another one.
- A `config_error` means **this request on this model, forever** — no retry will fix it.
- An `auth_failure` means **this provider, forever** — don't waste another API call.

A simple `isRetryable()` boolean collapses these into two buckets, but the cooldown duration, the fallback strategy, and the logging all depend on the specific category.

---

## The Lie of 200 OK

Here's the failure mode that burns people who only check status codes:

```
HTTP/1.1 200 OK
Content-Type: application/json

{"error": "service temporarily unavailable"}
```

Some providers return 200 with an error body when they're overloaded. Your retry logic sees "200, great!" and passes the garbage to your agent loop. The model tries to parse it, fails, and you've wasted an iteration.

Our classifier catches this. Even when the HTTP status is 200, if the response body contains "service temporarily" or "temporarily unavailable," we classify it as `overloaded` — same cooldown, same fallback chain, as if it had been a proper 503.

**Never trust the status code alone. Read the body.**

---

## Cooldown Tracking: Per-Model, Not Per-Provider

When a model hits a rate limit, you don't want to blacklist the entire provider. OpenAI's `gpt-4o` might be rate-limited while `gpt-4o-mini` is fine. Anthropic's Claude Sonnet might be overloaded while Haiku isn't.

We track cooldowns per `provider::model` pair:

```
┌────────────────────────────────────────────────────────────────────┐
│                       Cooldown State                               │
│                                                                    │
│  anthropic::claude-sonnet    → rate_limited, resumes in 45s       │
│  openai::gpt-4o              → (available)                        │
│  openai::gpt-4o-mini         → server_error, resumes in 20s      │
│  deepseek::deepseek-chat     → (available)                        │
│                                                                    │
│  Next route request → openai::gpt-4o (first available)            │
└────────────────────────────────────────────────────────────────────┘
```

| Error Category | Cooldown Duration | Rationale |
|---------------|-------------------|-----------|
| `rate_limited` | 60 seconds | Most provider rate limits reset within a minute |
| `overloaded` | 15 seconds | Overload is usually brief |
| `server_error` | 30 seconds | Give the server time to recover |
| `network_error` | 10 seconds | Transient — short wait is enough |

Cooled-down models aren't removed from the candidate list — they're deprioritized. If every available model is in cooldown, the least-recently-cooled one gets tried as a last resort. This is the `prioritizeNonCooledDown()` strategy: **degrade gracefully, don't fail absolutely.**

---

## The Fallback Chain

When a model fails, the router walks a fallback chain. The design has three tiers:

**Tier 1 — Explicit fallbacks.** You configure them: "For coding tasks, try Claude Sonnet first, then GPT-4o, then DeepSeek." The router walks the list, skipping anything that's down or in cooldown.

**Tier 2 — Tier-based resolution.** If no explicit rule exists, the router maps task types to model tiers (planning → flagship, chat → fast, coding → standard) and picks the first available model at that tier.

**Tier 3 — Any available provider.** Last resort. If everything in your tier is down, grab whatever is still responding.

At the `FailoverProvider` level, streaming has a critical nuance: **you can only fail over before the first token.** Once you've started yielding chunks to the client, switching providers mid-stream would produce incoherent output. So:

- Stream hasn't started yet → catch the error, mark provider down, try the next one.
- Stream has started (first text or tool_use chunk yielded) → rethrow. The partial response is unrecoverable.

This is a design constraint most frameworks ignore. They either never fail over during streaming (missing easy wins) or try to splice outputs from two different models (producing garbage).

---

## Format Error Rollback: Don't Waste Iterations

Sometimes the model doesn't hit an API error — it produces a response that *looks* valid but fails on execution. The most common case: malformed JSON in a tool call.

```
LLM says: file_edit({"file": "app.ts", "old_string": ...})
Actual args received: {"_raw": "file_edit({\"file\": \"app.ts\"..."}   ← JSON parse failure
Tool result: Error: tool "file_edit" received invalid JSON
```

In a naive agent loop, this error counts as an iteration. The model sees the error, tries again (maybe with the same broken JSON), and you've burned two iterations — out of a budget that might only be 15 — on nothing.

Our solution: **format error rollback.** When every tool call in an iteration fails due to format errors (JSON parse failure or tool-not-found), we:

1. Delete the assistant turn and all tool result turns from the database
2. Decrement the iteration counter
3. Return the iteration budget (if using `IterationBudget`)
4. Let the loop `continue` — the model gets another shot without the poisoned history

This is capped at 3 consecutive rollbacks (`MAX_CONSECUTIVE_ROLLBACKS`). After 3 failures, we let the error stand and move on — the model clearly can't produce valid output for this request.

**The key insight: a format error is the framework's fault, not the model's fault.** The model tried to use a tool. Our parser couldn't handle the output. Penalizing the model by consuming an iteration is punishing the wrong party.

---

## Three-Strike Escalation: Detecting a Stuck Model

This is the subtlest failure mode. No errors. No 429s. The model just... does the same thing over and over.

It reads a file. Gets an error. Reads the same file with the same path. Gets the same error. Reads the same file again. Each time it writes slightly different reasoning ("Let me try a different approach...") but calls the exact same tool with the exact same arguments.

We detect this with output fingerprinting:

```
Iteration 7:  "Let me check the config..." + file_read(/app/config.json)
Iteration 8:  "I'll examine the config..." + file_read(/app/config.json)
Iteration 9:  "Let me look at the config..." + file_read(/app/config.json)
              ↑ fingerprints are >80% similar → ESCALATION
```

The fingerprint is the first 300 characters of the LLM's text output (whitespace-normalized) concatenated with the sorted tool names. We keep a sliding window of 3 fingerprints. If all 3 are more than 80% character-identical, we inject an escalation hint into the next LLM call:

> *"You appear to be stuck in a loop — your last 3 responses were very similar. STOP repeating the same approach. Try a completely different strategy: use different tools, change parameters, or explain to the user what's blocking you."*

This fires once per session — the `escalated` flag prevents repeated injection. In production, it resolves about 60% of stuck loops: the model reads the hint, changes strategy, and unsticks itself. The other 40% hit the iteration limit and return whatever partial result they have.

**A stuck model isn't a bug — it's a missing signal.** The model doesn't know it's repeating itself. Telling it is usually enough.

---

## The Consecutive Error Circuit Breaker

Three consecutive iterations where every tool call errors out (`consecutiveErrors >= 3`) triggers an early stop. No more LLM calls. The loop returns the last successful text response, or a fallback error message.

This prevents the worst-case scenario: the model enters a loop where it calls a broken tool, gets an error, "reasons" about the error, calls the same tool, gets the same error — forever, billing you for each iteration.

```
┌─────────────────────────────────────────────────────┐
│ Error Handling State Machine                        │
│                                                     │
│  Normal ─── format error ──→ Rollback (up to 3x)   │
│    │                             │                  │
│    │                             ↓                  │
│    │                        Retry (same iteration)  │
│    │                                                │
│    ├── all-error iteration ──→ consecutiveErrors++  │
│    │                             │                  │
│    │                             ↓ (≥3)             │
│    │                        EARLY STOP              │
│    │                                                │
│    ├── similar fingerprints ──→ Inject escalation   │
│    │   (3 in a row)              hint (once)        │
│    │                                                │
│    └── any success ──→ Reset all counters           │
└─────────────────────────────────────────────────────┘
```

---

## Trade-offs We Evaluated and Rejected

**Exponential backoff on every error.** The textbook answer for API retries. But in an agent loop, exponential backoff means the user waits 1s, then 2s, then 4s, then 8s between iterations — while the spinner sits. We use fixed cooldowns per category instead. A rate limit always waits 60s because that's what providers actually need. An overload waits 15s. Predictable beats "correct."

**Automatic context reduction on 413.** When a model returns "context too long," you could trim the oldest messages and retry. We classify this as `config_error` and skip the model instead. Why? Because naive trimming can break tool-call/result pairs, remove critical context, and produce worse output than switching to a model with a larger context window.

**Retrying on auth failures.** Some frameworks retry 401/403 once "in case it was transient." Auth failures are never transient. Your key is wrong, expired, or revoked. Every retry is a wasted API call *and* another failed-auth entry in the provider's rate-limit counter, making things worse.

---

## Five Things to Do Monday Morning

1. **Classify your errors before retrying.** A 429 and a 500 need different responses. If your error handler does `catch (e) { retry() }`, you're retrying auth failures and burning your rate-limit budget.

2. **Track cooldowns per model, not per provider.** One model being rate-limited doesn't mean the whole provider is down. Your fallback chain should know the difference.

3. **Audit your 200 OK responses.** Search your logs for successful HTTP responses that contain error strings in the body. You might be silently swallowing failures.

4. **Don't waste iteration budget on format errors.** If the model produced invalid JSON, that's a parsing failure — roll back the iteration, don't count it. Three retries is enough; after that, let it fail.

5. **Detect stuck loops with fingerprinting.** If the model's last 3 outputs look the same, inject a hint to change strategy. This is cheaper than hitting the iteration limit every time.

---

*The code behind this article is open-source: [github.com/vorojar/AgentClaw](https://github.com/vorojar/AgentClaw). Error classification lives in `packages/providers/src/router.ts`, failover in `packages/providers/src/failover.ts`, and loop resilience in `packages/core/src/agent-loop.ts`.*

*If you've been bitten by silent 200 OK errors or infinite retry loops, you're not alone. [Star the repo](https://github.com/vorojar/AgentClaw) if this helped, and share your war stories — we're [@vorojar](https://x.com/nicekid_zhuo) on X.*

*Next in series: [Part 7 — Security: Your Agent is an Attack Surface](./07-security-attack-surface.md)*
