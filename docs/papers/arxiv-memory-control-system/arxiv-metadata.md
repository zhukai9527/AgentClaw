# arXiv Submission Metadata Draft

Title:
Memory as a Control System for Production AI Agents

Authors:
Vorojar (AgentClaw Project)

Primary category:
cs.SE

Cross-list candidates:
cs.AI, cs.CL

Abstract:
Long-term memory is often added to language-agent systems as a retrieval problem: extract facts, store them, retrieve the top-ranked entries, and inject them into the prompt. This framing is insufficient for production agents because retrieved memory is not passive evidence once it enters the model context. It becomes part of the policy that steers the next action. A memory can be true, textually relevant, and still harmful for the current task. This paper presents a control system view of agent memory based on an open-source case study, AgentClaw. The design separates atomic evidence, scene-level memory, and stable profile memory; selects an Active Memory set before prompt injection; records memory-use telemetry; provides edit, deprecate, and merge governance primitives; and turns memory failures into replayable regression scenarios. We describe the architecture, failure modes, and a deterministic replay suite that covers stale preferences, conflicting memories, underspecified follow-up turns, layered aggregation, telemetry, and safe fallback behavior. The contribution is not a new benchmark result, but an engineering pattern: production agent memory should be measured by governed influence, not merely by retrieval recall.

Comments:
Engineering report and open-source case study. Source code and replay scripts: https://github.com/vorojar/AgentClaw

Journal reference:
Leave blank.

DOI:
Leave blank.

License recommendation:
arXiv.org perpetual, non-exclusive license to distribute, or CC BY 4.0 if you want broad reuse.

Submission note:
arXiv expects authors to self-submit from a registered author account. Before final submission, replace the author line with the exact registered author identity and confirm any affiliation/ORCID metadata.
