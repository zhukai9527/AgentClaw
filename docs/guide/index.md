# Field Guides

Field Guides are operational references for agent engineering. They are written for engineers who need durable patterns they can carry into design reviews, implementation work, and incident analysis.

Unlike the essays, these pages do not try to build a narrative arc. They map systems, boundaries, priorities, and reusable lessons. AgentClaw may appear as the implementation that exposed a pattern, but the guidance is framed for the broader work of building production agents.

| Field Guide | Purpose |
|---|---|
| [Architecture](./architecture.md) | A control-plane map for production agents: interfaces, loop, tools, memory, providers, artifacts, traces, and deployment boundaries. |
| [Roadmap](./roadmap.md) | A reliability-centered view of what must mature next in the field, using current implementation pressure as evidence. |
| [Engineering Lessons](./engineering-lessons.md) | Reusable principles extracted from failures: trace replay, delivery gates, governed memory, tool contracts, and fast paths. |

Temporary audit reports, one-off task lists, local cache files, and private package materials are intentionally excluded from Field Guides.
