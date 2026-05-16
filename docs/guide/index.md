# System Guide

The guide section documents durable system knowledge. It is written for engineers who need to understand how AgentClaw is shaped, where the boundaries are, and which lessons should survive individual releases.

Unlike the Blog, these pages do not try to be essays. They are public engineering references: clear enough for a new contributor, specific enough for design review, and honest about what is complete versus still evolving.

| Guide | Purpose |
|---|---|
| [Architecture](./architecture.md) | The control-plane shape: interfaces, loop, tools, memory, providers, artifacts, traces, and deployment boundaries. |
| [Roadmap](./roadmap.md) | Current product direction and why the next work is prioritized around reliability rather than feature count. |
| [Engineering Lessons](./engineering-lessons.md) | Reusable principles extracted from failures: trace replay, delivery gates, governed memory, tool contracts, and fast paths. |

Temporary audit reports, one-off task lists, local cache files, and private package materials are intentionally excluded from this guide.
