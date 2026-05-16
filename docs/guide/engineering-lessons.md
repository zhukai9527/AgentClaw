# Engineering Lessons

> The hardest agent bugs were not caused by a weak model. They were caused by systems that gave the model too much freedom and too little proof.

These lessons are the reusable engineering principles behind AgentClaw. They are written as design-review rules: if a future change violates one, it should explain why.

## 1. Test the Real Trace

A local unit test can prove a parser, exporter, or adapter works. It cannot prove the full agent capability still works under real wording, old memory, channel behavior, tool side effects, and final delivery.

**Rule:** every user-visible regression should become a scenario replay at the lowest layer that reproduces the failure.

## 2. Deliver the Artifact, Not the Story

An agent can truthfully say it generated something while the user receives the wrong file type or an unreachable local path.

**Rule:** file tasks need deliverable contracts: requested type, existence, integrity, reachability, and final response reference.

## 3. Treat Memory as Authority

Memory inside the prompt is not passive. It changes the model's decision. A stale preference can override the current scene if the system lets it.

**Rule:** memories need type, scope, provenance, recency, conflict handling, telemetry, and cleanup.

## 4. Keep the Fast Path Short

Agents often perform responsible-looking rituals: dependency probes, broad searches, unnecessary subagents, repeated checks. Each ritual adds latency and failure surface.

**Rule:** take the shortest safe path first; run repair steps only after an observed failure.

## 5. Tools Need Contracts

A correct tool implementation is not enough. The model acts on the name, description, schema, output shape, and error message.

**Rule:** tool errors must tell the next valid action, and tool outputs must identify whether they are final, preview, intermediate, or diagnostic.

## 6. Context Is Influence

Old text in the prompt keeps voting. If stale observations remain powerful, the model will follow them.

**Rule:** protect fresh intent, compress old evidence, preserve handles, and demote stale output.

## 7. Provider Compatibility Is Product Surface

OpenAI-compatible APIs are not identical. Reasoning fields, streaming usage, error bodies, and context limits differ.

**Rule:** provider quirks belong in adapters, not scattered through the agent loop.

## 8. UI Explainability Cannot Replace System Guarantees

A panel that lets users tune memory, context, or retries can help experts, but it should not be required for normal correctness.

**Rule:** if a user must manually tune the agent to avoid a known failure, the system boundary is probably wrong.

## Principle

When an agent fails twice in the same class, stop asking the model to behave better. Remove the freedom that made the failure possible.
