# Agent Engineering

Production agents do not fail like chatbots. They fail by looping one more time, remembering the wrong preference, handing back the wrong file type, or passing a green unit test while the user still cannot use the result.

This publication is about agent engineering as a real software discipline: control loops, tool authority, memory governance, browser perception, artifact delivery, trace replay, release discipline, and the economics of model calls.

AgentClaw appears here as source material and a case study, not the subject. The subject is the engineering fieldwork behind production agents: where autonomy breaks, how systems contain it, and which mechanisms other teams can reuse.

## Flagship Essays

Start here if you want the highest-leverage arguments. These pieces define the editorial spine of the site: agents become reliable when probabilistic behavior is surrounded by explicit contracts, replayable evidence, and delivery checks that measure the user's finished job.

| Article | Core Thesis |
|---|---|
| [The Hard Part of Agent Memory Is Forgetting](./memory-control-system.md) | Memory is not storage. It is a control system with recall, governance, telemetry, and cleanup. |
| [Trace Replay Is the Missing Test Layer for Agents](./trace-replay-testing.md) | Agent regressions cannot be trusted until the real user trace is replayed end to end. |
| [The Last Mile Is Where Agent Work Disappears](./last-mile-delivery.md) | Tool success is not delivery. The only success that counts is the artifact the user can actually use. |
| [Skills Are Runtime Contracts, Not Prompt Snippets](./skills-runtime-contracts.md) | A skill should remove degrees of freedom from the agent, not merely suggest a nicer workflow. |
| [Context Compression Is a Reliability Mechanism](./context-compression.md) | Token reduction matters because stale context changes decisions, not only because tokens cost money. |

## Series

The Series turns the same fieldwork into a production agent engineering curriculum. Read it as a sequence: first learn how an agent acts, then how it observes, remembers, spends, fails, secures authority, operates in browsers, serves multiple channels, and finally ships work a user can actually finish.

| # | Article |
|---|---|
| 1 | [Agent Loops Need Brakes Before They Need Speed](./building-ai-agents/01-the-agent-loop.md) |
| 2 | [Tool Systems Fail at the Interface, Not the Function Body](./building-ai-agents/02-tool-system-design.md) |
| 3 | [Context Is a Budget, Not a Bucket](./building-ai-agents/03-context-management.md) |
| 4 | [Memory Must Be Governed Before It Is Trusted](./building-ai-agents/04-memory-architecture.md) |
| 5 | [The Token Economy Is a Systems Problem](./building-ai-agents/05-the-token-economy.md) |
| 6 | [Every LLM Call Is a Failure Boundary](./building-ai-agents/06-when-llms-fail.md) |
| 7 | [Agent Security Starts With Tool Authority](./building-ai-agents/07-security.md) |
| 8 | [Browser Agents Need Perception, Not HTML Dumps](./building-ai-agents/08-browser-automation.md) |
| 9 | [Multi-Channel Agents Need One Brain and Many Adapters](./building-ai-agents/09-multi-channel.md) |
| 10 | [Production Readiness Means the User Can Finish the Job](./building-ai-agents/10-production-readiness.md) |
