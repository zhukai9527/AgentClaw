---
layout: home

hero:
  name: AgentClaw Engineering
  text: Building agents that finish real work
  tagline: Field notes, architecture decisions, and production lessons from an agent system built for long-running tasks, memory, tools, channels, and verification.
  actions:
    - theme: brand
      text: Read the memory essay
      link: /blog/memory-control-system
    - theme: alt
      text: Browse the agent series
      link: /blog/building-ai-agents/
    - theme: alt
      text: View architecture
      link: /guide/architecture
  image:
    src: /logo.svg
    alt: AgentClaw mark

features:
  - title: Memory as a control system
    details: Why production agent memory needs selective recall, provenance, governance, telemetry, cleanup, and replay tests.
    link: /blog/memory-control-system
  - title: Context without token waste
    details: How long-running agents compress observations, preserve fresh intent, and avoid rereading stale tool output.
    link: /blog/context-compression
  - title: Agent loop safety
    details: The stopping conditions, failure counters, escalation rules, and budgets that keep autonomous loops from running forever.
    link: /blog/building-ai-agents/01-the-agent-loop
---

## Start Here

AgentClaw is an open-source AI commander: a task-running agent framework with tool use, memory, browser automation, multi-channel gateways, scheduled work, and a web control plane.

This site is the engineering record behind it. The goal is not to document every internal file. The goal is to publish the parts that help other teams build more reliable agents.

| Path | What It Gives You |
|---|---|
| [Engineering Blog](/blog/) | Deep technical essays written from production failures, design constraints, and real fixes. |
| [Building AI Agent Frameworks](/blog/building-ai-agents/) | A 10-part series on loops, tools, context, memory, cost, failure handling, security, browser automation, channels, and production readiness. |
| [System Guide](/guide/) | Architecture, roadmap, and durable engineering lessons. |
| [Comparisons](/compare/) | Fair comparisons with related agent systems and the trade-offs behind AgentClaw's direction. |

## Editorial Bar

Articles here should earn their place. A publishable AgentClaw article starts from a concrete failure, names the mechanism, shows the trade-offs, and ends with principles other engineering teams can reuse.

The site intentionally excludes temporary audit reports, one-off task lists, local cache files, and private book-package materials. Those may be useful internally, but they do not belong in a public engineering publication.
