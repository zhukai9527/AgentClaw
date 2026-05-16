# Engineering Blog

Agent engineering is still young enough that many teams are rediscovering the same failure modes: loops that do not stop, memory that pollutes decisions, context windows that fill with stale observations, and tools that succeed locally but fail at delivery.

These articles use AgentClaw as the case study, but the patterns are meant to transfer.

## Featured Essays

| Article | Why It Matters |
|---|---|
| [The Hard Part of Agent Memory Is Forgetting](./memory-control-system.md) | Memory becomes dangerous when it acts like policy without lifecycle, evidence, and cleanup. |
| [My AI Agent Burned 170K Tokens Looking for a File That Did Not Exist](./context-compression.md) | Context compression is not just a cost optimization. It is a reliability mechanism. |
| [Building AI Agent Frameworks](./building-ai-agents/) | A 10-part series covering the core engineering surfaces of production agents. |

## Series

| # | Article |
|---|---|
| 1 | [Your AI Agent Will Run Forever Unless You Build These 5 Safety Nets](./building-ai-agents/01-the-agent-loop.md) |
| 2 | [22 Tools, 40,000 Tool Calls, and the 5 Failure Modes Nobody Warns You About](./building-ai-agents/02-tool-system-design.md) |
| 3 | [128K Tokens Sounded Like Infinity. Then Our Agent Forgot What It Was Doing on Turn 12](./building-ai-agents/03-context-management.md) |
| 4 | [Your Agent Has Amnesia. Every Single Conversation](./building-ai-agents/04-memory-architecture.md) |
| 5 | [We Were Burning $4,200/Month on LLM Tokens. Here's Where They Went](./building-ai-agents/05-the-token-economy.md) |
| 6 | [Every LLM Call Can Fail. Here's What Happens When You Plan for It](./building-ai-agents/06-when-llms-fail.md) |
| 7 | [Your AI Agent Has Root Access. Who Else Does?](./building-ai-agents/07-security.md) |
| 8 | [Your Agent Can't See the Web. Here's What It Sees Instead](./building-ai-agents/08-browser-automation.md) |
| 9 | [Seven Platforms, One Codebase](./building-ai-agents/09-multi-channel.md) |
| 10 | [It Worked on My Laptop. Then the First User Broke It](./building-ai-agents/10-production-readiness.md) |
