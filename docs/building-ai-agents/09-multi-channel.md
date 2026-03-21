# Seven Platforms, One Codebase: Why Multi-Channel AI Agents Break in Ways You Don't Expect

*Part 9 of "Building AI Agent Frameworks" — a series on the engineering behind autonomous AI agents.*

*By Jaro & Claude | March 2026*

---

You built an AI agent. It works great over your WebSocket API. Your boss asks, "Can we also put it on Telegram?" Sure, you write an adapter in a day. Then comes DingTalk. Then Feishu. Then WeChat Work. Then QQ.

By the third platform, you realize: you've written the same session management code three times, the same timeout handling three times, and you just introduced a bug in DingTalk that you already fixed in Telegram two weeks ago.

**Multi-channel is not a connector problem. It's a distributed systems problem disguised as an integration task.**

We run [AgentClaw](https://github.com/vorojar/AgentClaw), an open-source agent framework serving 7 messaging platforms from a single process. We learned the hard way that each platform differs not just in API shape, but in message size limits, formatting support, file upload capabilities, interaction timing, and failure modes. The naive approach — one adapter per platform, each reimplementing core logic — doesn't scale past two channels without diverging behavior and accumulating bugs.

This article covers what actually breaks when you go multi-channel, and how to design an abstraction layer that prevents it.

> *Full disclosure: this article was co-written with Claude. The code, data, and decisions are ours; the prose was a collaboration.*

---

## The Core Insight

> **Every line of logic duplicated across channels is a bug waiting to happen in exactly one of them.**

The platforms look similar on the surface — receive message, call AI, send response. But the differences lurk in the details: Telegram renders Markdown, WeChat Work doesn't. Telegram lets you upload 50MB files inline, DingTalk gives you a webhook URL that expires. QQ requires passive reply tokens that timeout in 5 minutes. Every channel-specific behavior that leaks into your core processing pipeline is a maintenance liability that compounds with each new platform.

The goal: **channel code should handle only transport** — receiving bytes and sending bytes. Everything else — session management, timeout protection, event processing, format adaptation — belongs in shared infrastructure.

---

## The Channel Lifecycle Problem

Start with the basics: you need to start, stop, monitor, and hot-reload 7 different bot connections. Some use WebSockets (QQ), some use long-polling (Telegram), some use proprietary SDKs (DingTalk Stream), some are always-on (your own WebSocket server). Each can fail independently. Each needs different credentials.

Without centralization, you get startup code scattered across your entry point, no way to restart a single channel without restarting the whole process, and no visibility into which channels are actually connected.

We solved this with a `ChannelManager` that treats every platform as a state machine with four states:

```
┌─────────────────────────────────────────────────────┐
│               ChannelManager                         │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ Telegram │  │ DingTalk │  │  QQ Bot  │  ...      │
│  │ connected│  │ connected│  │  error   │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                      │
│  States: not_configured → disconnected → connected  │
│                                       ↘  error      │
│                                                      │
│  Interface per channel:                              │
│    { stop(), broadcast(text) }                       │
└─────────────────────────────────────────────────────┘
```

Every channel, regardless of transport mechanism, returns the same two-function interface: `stop()` to tear down gracefully, and `broadcast(text)` to push a message to all known conversations. The manager handles:

- **Startup sequencing**: iterate channels, skip unconfigured ones, catch and log individual failures without blocking others
- **Hot reload**: compare serialized configs, only restart channels whose credentials actually changed
- **Status API**: expose `list()` returning standardized `ChannelInfo` objects for dashboards

The key design choice: **a channel that fails to start doesn't prevent other channels from starting.** DingTalk credentials are wrong? Log the error, mark the channel as `error`, keep Telegram running. This sounds obvious, but early versions used a single `Promise.all()` that took everything down if one channel threw.

---

## The Duplication Trap (and How to Escape It)

When we had three channels, we audited the code. Here's what we found duplicated across every single one:

| Duplicated Logic | Lines per Channel | Bug Risk |
|---|---|---|
| Session creation + restore | ~25 | Session leak if one channel forgets cleanup |
| promptUser with timeout | ~15 | Hanging Promise if timeout is missing |
| sendFile URL construction | ~10 | Wrong URL format in one channel |
| Event stream processing | ~40 | Inconsistent error messages across channels |
| Message splitting | ~5 | One channel forgets to split, hits API limit |

That's ~95 lines of logic that was copy-pasted with slight variations. Five channels = 475 lines of almost-identical code, each drifting independently.

We extracted all of it into `channel-utils.ts` — a module of composable factory functions. Each function creates a callback matching the `ToolExecutionContext` interface, parameterized by the channel's transport:

```typescript
// Pseudocode — the pattern, not the implementation

// 1. promptUser: same 5-minute timeout everywhere
createPromptUser(chatKey, pendingPrompts, sendQuestion)
  → returns async (question) => Promise<string>

// 2. sendFile: channels that can't upload get a download link
createLinkSendFile(sentFiles, sendLink)
  → returns async (filePath, caption?) => Promise<void>

// 3. Event loop: accumulate text, split, send
processSimpleEventLoop({ channelTag, sessionId, sendReply, eventStream })
  → returns Promise<string>  // the accumulated text
```

After extraction, a new channel's message handler dropped from ~120 lines to ~30. The channel file does three things: authenticate with the platform SDK, map incoming events to our `processAndReply` pipeline, and map outgoing text to the platform's send API. Nothing more.

---

## Platform Hints: Teaching the LLM Where It Is

Here's a subtle problem. Your agent writes a beautiful response with Markdown headers, bold text, and bullet lists. It looks great in the web UI. On WeChat Work, the user sees raw asterisks and hash marks. On Telegram, the Markdown actually renders — but with different syntax than CommonMark.

You could post-process the output per channel. But that means parsing Markdown, which is fragile, and you lose the semantic intent. Better approach: **tell the LLM what format the user's platform supports, before it generates the response.**

We inject a one-line platform hint into the system prompt via a template variable:

| Channel | Hint |
|---|---|
| Telegram | "Don't use Markdown formatting (won't render). Set auto_send: true for media." |
| DingTalk | "Supports Markdown formatting." |
| WeChat Work | "Don't use Markdown. Keep messages short." |
| Feishu | "Supports rich text and Markdown." |
| QQ | "Limited Markdown support. Keep messages short." |
| CLI | "Plain text output. Avoid excessive Markdown." |
| WebSocket (Web UI) | *(no hint — full rendering support)* |

This costs approximately 15-25 tokens per LLM call. It saves re-processing every response and eliminates an entire class of formatting bugs. **The cheapest way to fix output is to prevent the wrong output from being generated.**

The hint is injected at session creation time, not per-message. It's part of the frozen system prompt snapshot, which means it's covered by Anthropic's prompt prefix caching — effectively free after the first call in a session.

---

## The 5-Minute Timeout: A Bug That Costs You Sleep

Your agent has an `ask_user` tool. It asks the user a question and waits for a response. In a web UI with WebSocket, this is simple — the Promise resolves when the next message arrives.

On Telegram, the user might close the app. On DingTalk, they might switch to another chat. The Promise hangs. Your agent loop is stuck. The LLM iteration budget ticks down. Other users in the same process are unaffected (async), but this user's session is permanently frozen.

**Every `promptUser` implementation across every channel must have a timeout.** Not "should have." Must. We learned this after a production incident where a Telegram user triggered `ask_user`, went to sleep, and their session held a pending Promise for 14 hours. The session was unusable until we restarted the gateway.

The fix is mechanical:

```
promptUser(question):
  1. Send question to user
  2. Store resolve callback in pendingPrompts map
  3. Start 5-minute timer
  4. If user responds → clear timer, resolve with answer
  5. If timer fires → delete from map, resolve with "[User did not respond within 5 minutes]"
```

The LLM receives the timeout message as a normal tool result, adapts ("The user didn't respond, I'll proceed with defaults"), and continues. No hanging, no intervention, no silent failure.

Because this logic is identical across all channels, it lives in `createPromptUser()` — one implementation, used everywhere. A new channel cannot accidentally forget the timeout because they never implement it themselves.

---

## Message Splitting: The Limit Nobody Reads

Every messaging platform has a maximum message length. None of them agree on what it is:

| Platform | Max Message Length | What Happens When Exceeded |
|---|---|---|
| Telegram | 4,096 characters | API error, message not delivered |
| DingTalk | ~20,000 characters | Silently truncated |
| QQ Bot | ~4,000 characters | API error |
| Feishu | ~30,000 characters | Varies by message type |
| WeChat Work | ~2,048 characters | API error |
| WhatsApp | ~65,536 characters | Rarely an issue |

Your LLM doesn't know these limits. It generates a 6,000-character response because that's what the question warranted. Without splitting, that response either errors out or gets silently truncated — the user sees half an answer with no indication that anything is missing.

Our `splitMessage()` function handles this with a priority-ordered splitting strategy:

1. Try to split at paragraph boundaries (double newline)
2. Fall back to line boundaries (single newline)
3. Fall back to word boundaries (space)
4. Hard-cut at the limit as last resort

Each chunk is sent as a separate message. The channel passes its specific limit — `splitMessage(text, 2048)` for WeChat Work, `splitMessage(text, 4096)` for Telegram. The function lives in shared utilities. No channel implements its own splitting.

---

## Channel-Specific Behaviors That Can't Be Abstracted

Not everything belongs in shared code. Some behaviors are genuinely platform-specific:

**Telegram** supports inline file uploads — images render as previews, documents show download buttons. It also supports streaming via draft messages, where the response appears to "type itself" in real-time. No other channel we support has this capability.

**DingTalk** uses a session webhook model — when a message arrives, it includes a webhook URL that's valid for a limited time. You must reply through that webhook, not through a general API. This means "send a reply" has fundamentally different plumbing than Telegram's `bot.api.sendMessage()`.

**QQ Bot** requires passive reply tokens. Each incoming message carries a `msg_id` and a sequence number. Your reply must reference these, and they expire. If your agent takes 6 minutes to process (complex tool chain), the reply token is dead and you need a fallback mechanism.

**WhatsApp** via the unofficial library manages its own persistent auth state on disk, needs a QR code scan on first setup, and operates in self-chat mode only (for safety reasons).

These differences belong in channel files, not in shared utilities. The test: **if removing the logic would break only one channel, it belongs in that channel's file.** If removing it would break two or more, extract it.

---

## The Architecture, End to End

```
User (Telegram/DingTalk/QQ/Feishu/WeChat Work/WhatsApp/Web)
  │
  ▼
Channel File (transport only)
  │  - Authenticate with platform SDK
  │  - Map incoming event → text or ContentBlock[]
  │  - Call shared pipeline
  │
  ▼
channel-utils.ts (shared logic)
  │  - createPromptUser() → 5-min timeout
  │  - createLinkSendFile() → URL construction
  │  - processSimpleEventLoop() → accumulate + split + send
  │
  ▼
Orchestrator.processInputStream(sessionId, input, toolContext)
  │  - The AI brain — completely channel-agnostic
  │  - Emits: tool_call, response_chunk, response_complete
  │
  ▼
platform-hints.ts
  │  - Injected at session creation
  │  - Tells the LLM what format the channel supports
  │
  ▼
ChannelManager
     - Lifecycle: start / stop / broadcast / hot-reload
     - Status: connected / disconnected / error / not_configured
```

The orchestrator never knows which channel it's serving. It receives text (or content blocks with images), processes them through the agent loop, and emits events. The channel layer translates those events into platform-specific API calls. The platform hint is the only channel-aware information that reaches the LLM — and it's a single sentence in the system prompt.

---

## Trade-offs: What We Evaluated and Rejected

**A universal message format** (like a channel-agnostic rich-text AST that each channel renders). We prototyped this. The problem: each platform's "Markdown" is different enough that a universal AST either targets the lowest common denominator (plain text) or requires per-platform renderers that are harder to maintain than just letting the LLM generate appropriate text via platform hints.

**Queue-based architecture** (messages in, responses out, channels as independent consumers). Adds infrastructure complexity (Redis/RabbitMQ) for a problem that doesn't need it at our scale. A single Node.js process handles all channels concurrently via async/await. We'd revisit this at 10,000+ concurrent sessions.

**Per-channel LLM personality tuning** (different system prompts per platform). Users on DingTalk tend to ask work-related questions; Telegram users ask everything. We considered routing to different models or prompts. Decided against it — the cognitive overhead of maintaining multiple personalities outweighs any quality gain. One brain, one personality, channel-appropriate formatting.

---

## Five Things to Do Monday Morning

1. **Audit your channel code for duplicated logic.** If session management, timeout handling, or message splitting appears in more than one channel file, extract it today. Every day it stays duplicated is a day you might fix a bug in one place and miss it in another.

2. **Add a timeout to every `promptUser` implementation.** If your agent can ask the user a question and wait for a response, that wait *must* have a ceiling. Five minutes is reasonable. Without it, a single unresponsive user can freeze a session permanently.

3. **Inject platform format hints into your system prompt.** One sentence per channel, 15-25 tokens. It's cheaper than post-processing every LLM response, and it produces better results because the model adapts its generation style — not just its formatting.

4. **Test message splitting with real limits.** Generate a 10,000-character response and send it through every channel. You'll discover which platforms error silently, which truncate, and which reject outright. Build your splitting logic before users find the edge cases.

5. **Centralize channel lifecycle management.** A `start/stop/status` interface per channel, managed by a single coordinator. Without it, you can't restart DingTalk without restarting Telegram, and you have no visibility into which channels are actually healthy.

---

*The code behind this article is open-source: [github.com/vorojar/AgentClaw](https://github.com/vorojar/AgentClaw). Channel management lives in `packages/gateway/src/channel-manager.ts`, shared utilities in `channel-utils.ts`, and platform hints in `platform-hints.ts`.*

*If you're adding a second messaging platform to your agent and the code is starting to smell — [star the repo](https://github.com/vorojar/AgentClaw) and steal the pattern. Tell us which platform gave you the worst surprises — we're [@vorojar](https://x.com/nicekid_zhuo) on X.*

*Next in series: [Part 10 — Production Readiness: From Demo to Deployment](./10-production-readiness.md)*
