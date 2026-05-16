# Building Production AI Agents

> A production agent is not a bigger chatbot. It is a control system around a probabilistic model.

This series is a production agent engineering curriculum. It starts where demos usually stop: the moment an agent is allowed to loop, call tools, remember, spend money, browse the web, touch user files, and claim that work is done.

The curriculum is intentionally narrower than a textbook. It focuses on the surfaces that break in production: loops, tools, context, memory, token cost, model failures, security, browser perception, channel adapters, and release discipline.

AgentClaw is one source of the field data behind these lessons. The goal is not to document a framework. The goal is to give engineers a transferable sequence of mechanisms, failure modes, and acceptance criteria for building agents that can survive contact with real users.

## Reading Path

| # | Essay | Core Question |
|---|---|---|
| 1 | [Agent Loops Need Brakes Before They Need Speed](./01-the-agent-loop.md) | How does an agent stop before autonomy becomes waste? |
| 2 | [Tool Systems Fail at the Interface, Not the Function Body](./02-tool-system-design.md) | Why do correct tools still produce wrong actions? |
| 3 | [Context Is a Budget, Not a Bucket](./03-context-management.md) | What deserves to influence the next model call? |
| 4 | [Memory Must Be Governed Before It Is Trusted](./04-memory-architecture.md) | How do you stop memory from becoming stale policy? |
| 5 | [The Token Economy Is a Systems Problem](./05-the-token-economy.md) | Where does agent cost actually come from? |
| 6 | [Every LLM Call Is a Failure Boundary](./06-when-llms-fail.md) | What happens when a provider succeeds syntactically and fails semantically? |
| 7 | [Agent Security Starts With Tool Authority](./07-security.md) | Who gets to act through the model? |
| 8 | [Browser Agents Need Perception, Not HTML Dumps](./08-browser-automation.md) | What does an agent really see on the web? |
| 9 | [Multi-Channel Agents Need One Brain and Many Adapters](./09-multi-channel.md) | How do you avoid seven slightly different agents? |
| 10 | [Production Readiness Means the User Can Finish the Job](./10-production-readiness.md) | What separates a successful trace from a finished task? |

## Editorial Contract

Every lesson in this curriculum follows the same bar:

- a concrete failure or conflict at the start;
- one reusable thesis;
- mechanisms and trade-offs, not feature lists;
- at least one evidence table, diagram, or replayable acceptance criterion;
- boundaries that state where the advice stops working;
- a final principle another team can quote in a design review.
