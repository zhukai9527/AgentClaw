# Building AI Agent Frameworks

A 10-part series on the engineering behind autonomous AI agents.

By **Rosibo & Claude** | 2026

---

## Series Index

| # | Title | Status |
|---|-------|--------|
| 1 | [Your AI Agent Will Run Forever Unless You Build These 5 Safety Nets](./01-the-agent-loop.md) | **Published** |
| 2 | [22 Tools, 40,000 Tool Calls, and the 5 Failure Modes Nobody Warns You About](./02-tool-system-design.md) | **Published** |
| 3 | [128K Tokens Sounded Like Infinity. Then Our Agent Forgot on Turn 12.](./03-context-management.md) | **Published** |
| 4 | [Your Agent Has Amnesia. Every Single Conversation.](./04-memory-architecture.md) | **Published** |
| 5 | [We Were Burning $4,200/Month on LLM Tokens. Here's Where They Went.](./05-the-token-economy.md) | **Published** |
| 6 | [Every LLM Call Can Fail. Here's What Happens When You Plan for It.](./06-when-llms-fail.md) | **Published** |
| 7 | [Your AI Agent Has Root Access. Who Else Does?](./07-security.md) | **Published** |
| 8 | [Your Agent Can't See the Web. Here's What It Sees Instead.](./08-browser-automation.md) | **Published** |
| 9 | [Seven Platforms, One Codebase: Why Multi-Channel AI Agents Break](./09-multi-channel.md) | **Published** |
| 10 | [It Worked on My Laptop. Then the First User Broke It.](./10-production-readiness.md) | **Published** |

---

## Editorial Standards

Every article in this series must meet the following bar before publication.

### Voice & Audience

- **Reader-first, not project-first.** Lead with the reader's pain, not "we built X". AgentClaw is a case study, not the protagonist. Any developer building an agent framework should find the article useful, regardless of language or stack.
- **Global audience.** Write in English. Avoid idioms that don't translate. Simultaneously publish Chinese versions on Juejin/Zhihu.
- **Tone: senior engineer explaining to a peer.** Not academic, not tutorial. Assume the reader has shipped production code but hasn't built an agent framework.

### Structure

- **Title must trigger a click.** Use specific numbers, dollar amounts, or pain points. "How We Cut Costs by 60%" is weak. "$4,200/month on LLM Tokens — Here's Where They Went" is strong.
- **Open with the reader's problem, not your solution.** First 2 sentences must make the reader think "that's exactly my situation." Introduce yourself after the hook.
- **One core insight per article.** Every section should be a variation of the core insight. Don't scatter 5 disconnected findings — unify them under one thesis.
- **Total-Detail-Total structure.** Open with the thesis → break it down → close with actionable takeaways. The reader should be able to read only the opening and closing and get 80% of the value.

### Shareability

- **2-3 quotable sentences per article.** Sentences that make readers screenshot and post on X/Twitter. Bold them in the text. Examples:
  - "Your most expensive token is the one you send twice."
  - "The LLM wrote it — it doesn't need to re-read it."
- **Actionable takeaways titled "Things to Do Monday Morning."** Not abstract principles — specific actions the reader can take immediately.
- **End with a CTA.** Star the repo, share feedback, follow on X. Every article should have a clear next action.

### Data & Credibility

- **Every claim backed by measurement.** "We saved 60%" requires a before/after table with specific numbers. No hand-waving.
- **Show what you rejected, not just what you shipped.** "Trade-offs We Evaluated and Rejected" signals deeper thinking than "5 Tips to Save Tokens."
- **Don't inflate sample sizes.** If you measured 100 conversations, say "across our production workload" — don't pretend it's a million. Time ranges ("three months of production traffic") are more credible than counts.

### Code

- **Max 2-3 code blocks per article.** Keep the highest-signal snippets. Describe the rest in prose. Non-TypeScript readers should still get full value.
- **Pseudocode > language-specific syntax** for concepts. Real code for implementations.
- **Link to source files** at the end, not inline. The article is not a code walkthrough.

### Visuals

- **At least one diagram or chart per article.** Token breakdown waterfall, architecture flow, before/after comparison. One image retains 10x more readers than one paragraph.
- **Tables over bullet lists** for comparisons. Scannable in 3 seconds.

### Human + AI Collaboration

- **Acknowledge the co-authorship.** Each article should include a brief disclosure: "This article was co-written with Claude. The code, data, and decisions are ours; the prose was a collaboration."
- This transparency is itself a differentiator — and it's honest.

### Publication Checklist

Before publishing any article:

- [ ] Title passes the "would I click this on Hacker News?" test
- [ ] First 2 sentences are about the reader, not about us
- [ ] Core insight is statable in one sentence
- [ ] 2-3 bold quotable sentences exist
- [ ] All numbers backed by measurement
- [ ] Max 3 code blocks
- [ ] At least 1 visual (diagram/chart)
- [ ] "Monday Morning" actionable takeaways
- [ ] CTA at the end (star/follow/share)
- [ ] Co-authorship disclosure included
- [ ] English version + Chinese version prepared

---

Built with [AgentClaw](https://github.com/vorojar/AgentClaw) — an open-source AI agent framework.
