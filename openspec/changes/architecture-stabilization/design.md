## Context

AgentClaw is a monorepo centered on a gateway process that assembles providers, tools, memory, skills, agents, and orchestration in one runtime. The system already supports multiple entry surfaces such as web, desktop, and CLI, but several important concerns are concentrated in a few oversized modules:

- packages/gateway/src/bootstrap.ts assembles configuration, providers, search, MCP, embedding, scheduler, agent loading, runtime refresh hooks, and orchestrator construction.
- configuration supports both legacy top-level model fields and newer providers[] structures, which makes effective runtime model selection harder to reason about.
- packages/web/src/pages/ChatPage.tsx carries a large share of streaming, upload, editing, preview, voice, tool-call, and layout state.
- packages/memory/src/store.ts exposes a broad SQLite-backed API spanning unrelated operational domains.
- desktop sidecar generation is structurally separate from 	auri dev, which allows resource failures to surface late in Rust build steps.

The goal of this change is to make the architecture easier to evolve without materially changing current product behavior.

## Goals / Non-Goals

**Goals:**
- Establish one clear runtime configuration path for provider and model selection.
- Separate gateway startup assembly from ongoing runtime refresh responsibilities.
- Reduce the blast radius of chat UI changes by extracting stable seams.
- Introduce explicit persistence interfaces aligned to operational domains.
- Ensure desktop sidecar build requirements are validated and produced before Tauri resource validation.

**Non-Goals:**
- Replacing SQLite or redesigning the entire persistence engine.
- Redesigning the visible web UX.
- Replacing Tauri, Bun sidecar compilation, or the OpenSpec workflow itself.
- Converting every legacy module in one pass beyond the targeted architectural seams.

## Decisions

### 1. Use providers[] + activeProvider as the authoritative runtime model configuration

The runtime should resolve the active provider and model from one structure, with legacy environment/config fields treated as compatibility input only.

- Chosen because it makes effective configuration inspectable and reduces hidden precedence behavior.
- Alternative considered: continue dual-write support across legacy and new fields. Rejected because it prolongs ambiguity and increases UI/backend drift risk.

### 2. Split gateway runtime assembly into factories and a runtime manager

Bootstrap responsibilities should be decomposed into:

- configuration loading and migration
- provider/runtime dependency factories
- orchestrator assembly
- runtime refresh management for providers, agents, prompt, and health

This preserves existing behavior while making startup and hot-refresh flows individually testable.

- Alternative considered: keep a single bootstrap file with more helper functions. Rejected because the runtime ownership problem would remain mostly unchanged.

### 3. Treat OpenSpec tasks as the execution source of truth and Superpowers as execution discipline

For this repo, OpenSpec artifacts should define scope and task order, while Superpowers skills such as writing-plans, 	est-driven-development, systematic-debugging, and equesting-code-review should constrain implementation behavior rather than generate a competing plan.

- Alternative considered: allow both systems to maintain parallel task plans. Rejected because duplicate planning artifacts drift quickly.

### 4. Break the chat surface into domain hooks and narrow components

The chat page should be reorganized around domain seams such as session lifecycle, streaming state, composer/input, artifact preview, and voice input. The outer page remains the composition shell.

- Alternative considered: split only visual subcomponents and keep one stateful page container. Rejected because it reduces JSX size but does not meaningfully reduce behavioral coupling.

### 5. Introduce persistence repositories before considering storage engine changes

The current SQLite store remains, but runtime consumers should move toward domain-oriented interfaces such as session history, memory, traces, usage, and settings repositories.

- Alternative considered: defer all store changes until a future storage migration. Rejected because the current API shape is already a maintainability bottleneck independent of storage engine choice.

### 6. Fail desktop sidecar setup early and explicitly

Desktop dev/build scripts should ensure sidecar generation happens before Tauri validates resources. When prerequisites or binaries are missing, the failure should occur in the desktop command path with actionable guidance.

- Alternative considered: rely on existing documentation and manual pre-build steps. Rejected because it keeps the most common failure mode late and non-obvious.

## Risks / Trade-offs

- [Configuration migration confusion] -> Keep compatibility reads for legacy fields during the transition, but make new writes canonical and expose the resolved active provider/model clearly.
- [Chat page refactor regressions] -> Preserve API contracts, add focused tests around session creation, streaming, uploads, and tool rendering before broad extraction.
- [Repository interface duplication] -> Stage interface introduction over the existing SQLite store instead of attempting full physical separation immediately.
- [Desktop workflow drift between environments] -> Keep dev/build script checks platform-aware and verify expected output names against Tauri's resource naming conventions.
- [Architecture work delaying product work] -> Scope this change to seam creation and operational clarity rather than opportunistic redesign.

## Migration Plan

1. Make configuration resolution canonical while preserving read compatibility for existing files and env vars.
2. Extract bootstrap-adjacent factories and runtime refresh management without changing endpoint behavior.
3. Refactor chat-page responsibilities behind stable hooks/components while keeping routes and wire protocols intact.
4. Introduce persistence interfaces and migrate highest-churn callers first.
5. Fix desktop scripts so sidecar generation/validation runs before Tauri packaging and development resource checks.

Rollback strategy:

- Each phase should remain independently reversible by preserving existing runtime contracts until the new seam proves stable.
- Desktop workflow changes should preserve current output names so reverting only requires restoring previous scripts.

## Open Questions

- Which repository interfaces should be formalized first based on current churn: session history, usage, or settings?
- How far should chat-page extraction go in the first pass before it starts conflicting with ongoing feature work?
- Should canonical configuration migration also rewrite existing config files automatically, or only normalize reads and future writes?
