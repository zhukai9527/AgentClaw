# Memory as a Control System for Production AI Agents

This page hosts the working paper draft derived from the AgentClaw memory-control work.

## Abstract

Long-term memory is often added to language-agent systems as a retrieval problem: extract facts, store them, retrieve the top-ranked entries, and inject them into the prompt. This framing is insufficient for production agents because retrieved memory is not passive evidence once it enters the model context. It becomes part of the policy that steers the next action. A memory can be true, textually relevant, and still harmful for the current task.

The paper presents a control system view of agent memory based on AgentClaw. The design separates atomic evidence, scene-level memory, and stable profile memory; selects an Active Memory set before prompt injection; records memory-use telemetry; provides edit, deprecate, and merge governance primitives; and turns memory failures into replayable regression scenarios.

## Draft Package

- LaTeX source: `docs/papers/arxiv-memory-control-system/main.tex`
- References: `docs/papers/arxiv-memory-control-system/references.bib`
- arXiv metadata draft: `docs/papers/arxiv-memory-control-system/arxiv-metadata.md`

## Related Engineering Notes

- [The Hard Part of Agent Memory Is Forgetting](/blog/memory-control-system)
- [Trace Replay Is the Missing Test Layer for Agents](/blog/trace-replay-testing)
- [Context Compression Is a Reliability Mechanism](/blog/context-compression)
- [AgentClaw repository](https://github.com/vorojar/AgentClaw)
