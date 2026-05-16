# Roadmap

> The roadmap is not a feature wishlist. It is a reliability sequence.

Agent projects fail when the team adds more surfaces before the existing surfaces can be verified. AgentClaw's roadmap is therefore organized around one question: which work most increases the probability that a user can hand the agent a real task and receive the correct result?

## Current Direction

| Priority | Theme | Why it matters |
|---|---|---|
| P0 | Trace replay as default regression discipline | Real user failures must become reusable tests |
| P0 | Delivery gates for file and artifact tasks | Tool success must not be confused with user delivery |
| P0 | Skill contracts and fast paths | Common workflows should not rediscover dependencies, tools, or output rules every run |
| P1 | Memory governance and telemetry | Memory should help decisions without becoming stale policy |
| P1 | Provider compatibility layer | OpenAI-compatible APIs still differ in streaming, reasoning fields, errors, and limits |
| P1 | Context influence controls | Long traces need compression that preserves user intent and handles |
| P2 | Public docs and examples | External engineers need reproducible patterns, not internal notes |

## Completed Directional Moves

| Area | Result |
|---|---|
| Memory | Moved from passive recall toward active selection, governance, telemetry, cleanup, and trace replay |
| PPT/file delivery | Added hard thinking around final artifact type instead of accepting previews as completion |
| Testing discipline | Elevated real trace scenario replay above developer-imagined happy paths |
| Documentation | Created a public VitePress site with blog, series, guide, comparison, and book sections |
| Editorial standard | Rewrote public content around failures, mechanisms, evidence, boundaries, and reusable principles |

## Near-Term Work

1. Keep converting real production failures into named replay scenarios.
2. Expand artifact delivery contracts beyond PPTX into document, spreadsheet, image, video, and website outputs.
3. Move provider-specific quirks into adapters with deterministic request normalization.
4. Add public examples that show a full trace from user request to final verified result.
5. Keep the public site small and strong: fewer articles, higher evidence density.

## What We Are Not Prioritizing

| Not Now | Reason |
|---|---|
| Large UI tuning panels for agent internals | The goal is autonomous reliability, not asking users to become runtime operators |
| More channels before shared contracts are stable | Every new platform multiplies delivery and formatting edge cases |
| Prompt-only fixes for repeated failures | Repeated failures need schema, tests, gates, or architecture changes |
| Cosmetic docs volume | A small set of strong engineering articles is better than a large archive of weak notes |

## Principle

The roadmap should make the agent more dependable, not merely larger.
