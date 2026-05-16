# Your Agent Can't See the Web. Here's What It Sees Instead.

*Part 8 of "Building AI Agent Frameworks" — a series on the engineering behind autonomous AI agents.*

*By Rosibo & Claude | March 2026*

---

You want your AI agent to book a flight. It opens the airline's website. Now what?

A human sees a search form, a calendar widget, and a "Search Flights" button. The agent sees... a 340KB HTML document with 2,847 DOM nodes, 186 CSS classes, and 14 nested `div`s wrapping a single input field. You could send that to the LLM. It would cost you 85,000 tokens and the model would hallucinate half the interactive elements anyway.

**The hardest problem in browser automation isn't controlling the browser — it's representing the page.**

We know because we built three different browser automation systems for [AgentClaw](https://github.com/vorojar/AgentClaw), an open-source agent framework running across Telegram, DingTalk, Feishu, and more. We shipped screenshots. We shipped raw DOM. We shipped accessibility snapshots. This article is the story of what worked, what didn't, and why the answer was hiding in assistive technology all along.


---

## The Core Insight

> **An LLM doesn't need to see a webpage. It needs to see the page's interactive affordances — what can be clicked, typed, and read — in the fewest tokens possible.**

Every decision in this article flows from that insight. The representation you choose determines your token cost, your success rate, and whether the agent can operate on pages it has never seen before.

---

## Three Ways to Show an Agent a Webpage

We tried all three. Here's how they compare:

| Approach | Token Cost | Information Quality | Interaction | Verdict |
|----------|-----------|-------------------|-------------|---------|
| Screenshot (base64 PNG) | ~12,000-25,000 | Visual layout, but no element targeting | Requires coordinate-based clicking | Fragile, expensive |
| Raw DOM / innerHTML | ~40,000-85,000 | Complete but drowning in noise | CSS selectors work, but LLM picks wrong ones | Unusable at scale |
| Accessibility Snapshot | ~2,000-5,000 | Interactive elements with labels and roles | Ref-based targeting, deterministic | Production-ready |

The numbers aren't theoretical. We measured them on the same 20 pages — a mix of SPAs, dashboards, e-commerce sites, and social media.

**Screenshots** seem intuitive — "let the model see what the user sees." But vision tokens are 2-3x more expensive than text tokens, the model can't reliably map pixel coordinates to clickable elements, and you lose all semantic information. The model sees a blue rectangle; it doesn't know it's a submit button.

**Raw DOM** gives perfect information but at catastrophic cost. A typical SPA page produces 40,000-85,000 tokens of HTML. Most of it is styling noise, SVG icons, tracking scripts, and structural `div` soup. The signal-to-noise ratio is around 5%. We tried extracting `innerText` — better, but you lose all interactivity. The model knows *what* the page says but not *what it can do*.

**Accessibility snapshots** solved both problems. The browser's accessibility tree is purpose-built to answer "what's on this page and how can I interact with it?" — exactly the question an agent needs answered.

---

## How Accessibility Snapshots Work

The idea is simple: walk the DOM, find every interactive element, tag it with a short reference ID, and return a compact text tree. Skip everything the LLM doesn't need — styling, scripts, SVGs, hidden elements.

Here's what a snapshot of a login page looks like:

```
URL: https://example.com/login
Title: Sign In

# Sign in to your account
  [e1] input[email] "Email address"
  [e2] input[password] "Password"
  [e3] a "Forgot password?" → /reset
  [e4] button "Sign in"
  [e5] a "Create account" → /register
```

That's 6 lines. The raw DOM for this page was 1,200 lines and 48,000 tokens. **The snapshot is 120 tokens — a 99.7% reduction.**

The agent reads the snapshot, decides to type into `e1` and `e2`, then clicks `e4`. Each interaction uses the ref ID directly. No CSS selectors. No XPath. No coordinate math.

Three design decisions made this work:

**1. Tag-then-read, not read-then-tag.** Before generating the snapshot, we inject `data-ac-ref` attributes into the live DOM. Every interactive element — buttons, links, inputs, ARIA roles — gets a sequential ref like `e1`, `e2`, `e3`. The snapshot reads these refs. When the agent says "click e4," we resolve it to `[data-ac-ref="e4"]` — a selector that always works because we just created it.

**2. Interactive filter mode.** Sometimes the agent only needs to find clickable elements, not read page content. The `filter: "interactive"` option strips all text nodes and non-interactive elements, cutting token count by another 50-60%. A dashboard with 200 data points and 8 buttons becomes just those 8 buttons.

**3. Depth limit and visibility pruning.** We cap DOM traversal at depth 10 and skip any element where `offsetParent === null` (hidden) or `aria-hidden="true"`. This eliminates modals that aren't open, dropdown menus that haven't expanded, and off-screen content.

Measured across 50 real-world pages:

| Page Type | Raw DOM Tokens | Snapshot Tokens | Reduction |
|-----------|---------------|-----------------|-----------|
| E-commerce product page | 62,000 | 3,800 | 94% |
| Social media feed | 85,000 | 4,200 | 95% |
| SaaS dashboard | 41,000 | 2,100 | 95% |
| Login/signup form | 48,000 | 120 | 99.7% |
| Search results page | 53,000 | 3,500 | 93% |
| **Average** | **57,800** | **2,744** | **95%** |

**The accessibility tree is the page, compressed for machines.** Screen readers have needed this for decades. LLMs need it now for the same reasons — limited bandwidth, need for structure, and intolerance for noise.

---

## The Login Problem: Persisting Browser State

Your agent just spent 6 tool calls logging into a site. Tomorrow, the session expires and it has to do it again — navigating CAPTCHAs, 2FA codes, and cookie consent banners.

Browser state persistence solves this permanently. The key mechanism is Playwright's `storageState` — a JSON snapshot of all cookies and localStorage for a browser context.

We built two commands: `save_state` and `load_state`. After the agent (or the user) logs in manually, `save_state` captures the session:

```
Agent: browser_cdp { action: "save_state", name: "github" }
→ Login state saved: data/browser-states/github.json
```

Next session, `load_state` launches a fresh browser with that state pre-loaded:

```
Agent: browser_cdp { action: "load_state", name: "github" }
→ Browser launched with saved cookies and localStorage.
```

One subtlety we hit: cookies from Chrome extensions use `sameSite` values like `"unspecified"` or `"no_restriction"` — strings that Playwright doesn't accept. We normalize them on save: `unspecified` and `no_restriction` become `"None"`, `lax` becomes `"Lax"`, `strict` becomes `"Strict"`. Without this, `load_state` throws a cryptic validation error.

We also built a Chrome extension path for state capture. The extension connects to the gateway via WebSocket, exports the current tab's cookies and localStorage on command, and the gateway persists the state file. This lets users save login state from *their own browser session* — no need for the agent to navigate the login flow at all.

---

## Headless Deployment: From Desktop to Docker

On your dev machine, browser automation launches a visible Chrome window. On a Linux server with no display, that's a crash.

We detect the environment automatically:

```
Windows or macOS → headed (visible Chrome window)
Linux with DISPLAY or WAYLAND_DISPLAY → headed
Linux without display → headless (--headless=new)
```

The `--headless=new` flag (Chrome 112+) is critical. The old `--headless` mode ran a completely different rendering engine that broke on modern SPAs. The new headless mode runs the full browser — same rendering, same JavaScript, same DevTools protocol — without a window.

For Docker, three additional flags prevent common failures:

| Flag | Why |
|------|-----|
| `--no-sandbox` | Docker containers run as root; Chrome's sandbox conflicts with the container's own isolation |
| `--disable-dev-shm-usage` | Docker's default `/dev/shm` is 64MB; Chrome writes shared memory segments there and crashes when it fills up |
| `--disable-gpu` | No GPU available in most containers; prevents a noisy (but harmless) error log |

The detection happens once at launch and applies for the browser's lifetime. No configuration needed — it just works on a laptop, a VPS, and in a Docker container.

---

## Connection Reliability: Dealing with Dead Browsers

CDP connections die. Chrome crashes. The remote debugging port stops responding. If your agent framework doesn't handle this, the user sees "Browser error: Target closed" and every subsequent browser command fails until someone restarts the process.

We implemented a three-layer connection check:

**Layer 1 — `isConnected()` check.** Before every action, we check `browser.isConnected()`. If it returns false, we reset all state and reconnect. This catches clean disconnections (Chrome exited, remote port closed).

**Layer 2 — Active page probe.** Even if `isConnected()` returns true, the connection might be stale. We call `activePage.title()` — a cheap CDP call that exercises the actual connection. If it throws, we reset and reconnect. This catches zombie connections where the WebSocket is technically open but the browser process is dead.

**Layer 3 — Graceful launch fallback.** When connecting to `127.0.0.1:9222` fails, we launch a new Chrome instance and retry the connection up to 10 times with 500ms intervals. If Chrome was already running with a debug port, we connect to it. If not, we start one. The user never needs to manage Chrome processes manually.

**The result: the agent can use the browser across a multi-hour session without the developer handling a single connection error.**

---

## Approaches We Evaluated and Rejected

**Lightpanda** — a Zig-based headless browser built specifically for AI agents and web scraping. Promises 10-50x lower resource consumption than Chrome. The architecture is promising, but it currently lacks Windows support and full JavaScript engine compatibility. We're watching it for future integration. For production today, Chrome is the only browser that renders the same pages your users see.

**Puppeteer** — Google's official Chrome DevTools Protocol client. We chose Playwright instead for three reasons: Playwright's `storageState` API is more complete, its auto-wait mechanism reduces flaky interactions, and it supports Firefox and WebKit if we ever need them. The CDP layer underneath is identical.

**browser-use** — a Python library that wraps browser automation for LLM agents. Capable, but it's a standalone CLI tool, not an embeddable library for a TypeScript framework. We need browser automation as one tool among twenty, not as the entire agent architecture.

**Selenium** — still widely used for testing, but its WebDriver protocol adds a translation layer over CDP that introduces latency and limits access to modern browser features. CDP is the native protocol.

---

## The Architecture: Two Paths to the Browser

We support two distinct browser automation paths, each for a different use case:

```
Path 1: Direct CDP (headless / server)
  Agent → browser_cdp tool → Playwright → Chrome (local)
  Best for: autonomous tasks, server deployment, headless scraping

Path 2: Chrome Extension (user's browser)
  User's Chrome → Extension (background.js) → WebSocket → Gateway → Agent
  Best for: using the user's login sessions, interactive workflows
```

Path 1 is self-contained — the agent launches and controls its own Chrome instance. Path 2 piggybacks on the user's existing browser — the Chrome extension connects to the gateway via WebSocket, and the agent sends commands through the gateway's HTTP API. The extension executes them in the user's tabs and returns results.

Both paths produce the same output format (accessibility snapshots with ref IDs), so the agent doesn't need to know which path is active. The representation is the abstraction layer.

---

## Five Things to Do Monday Morning

1. **Replace screenshots with accessibility snapshots.** If your agent uses vision for web interaction, switch to a text-based accessibility tree. You'll cut token cost by 90%+ and improve interaction reliability.

2. **Tag interactive elements with stable ref IDs.** Inject `data-` attributes before reading the page, then use those attributes as selectors. Never let the LLM construct CSS selectors or XPath — it will hallucinate classes and IDs.

3. **Persist login state as JSON.** Capture cookies and localStorage after login, save to disk, restore on next session. Stop burning agent iterations on re-authentication.

4. **Auto-detect headless environments.** Check for `DISPLAY` / `WAYLAND_DISPLAY` on Linux. Launch Chrome with `--headless=new` (not the old `--headless`) when there's no display. Include `--no-sandbox` and `--disable-dev-shm-usage` for Docker.

5. **Implement connection health checks.** Don't trust `isConnected()` alone — probe the active page with a cheap call before every action. Auto-reconnect on failure. The user should never see a stale connection error.

---

*The code behind this article is open-source: [github.com/vorojar/AgentClaw](https://github.com/vorojar/AgentClaw). Browser automation lives in `packages/tools/src/builtin/browser-cdp.ts` and the Chrome extension gateway in `packages/gateway/src/routes/browser-ext.ts`.*

*If you've built browser automation for your agent framework, we want to hear what representation you chose — screenshots, DOM, accessibility tree, or something else entirely. [Star the repo](https://github.com/vorojar/AgentClaw) and tell us on X: [@ponyinhouse](https://x.com/ponyinhouse).*

*Next in series: [Part 9 — Multi-Channel Delivery: One Brain, Many Mouths](./09-multi-channel.md)*
