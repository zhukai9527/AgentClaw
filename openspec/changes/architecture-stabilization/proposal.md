## Why

AgentClaw has reached the point where feature breadth is outpacing structural clarity. Core runtime assembly, configuration resolution, frontend chat orchestration, persistence access, and desktop sidecar bootstrapping all work, but they are coupled tightly enough that routine changes now carry unnecessary regression risk.

## What Changes

- Consolidate runtime model/provider configuration around a single active provider model and explicit precedence rules.
- Split gateway runtime assembly into smaller, testable subsystems with clear startup and runtime-refresh boundaries.
- Refactor the web chat surface into smaller hooks and components while preserving current behavior.
- Introduce clearer persistence access boundaries so session history, long-term memory, traces, usage, and settings are not all consumed through one catch-all store API.
- Make desktop sidecar preparation deterministic in development and packaging workflows so missing sidecar artifacts fail early with actionable feedback.

## Capabilities

### New Capabilities
- untime-configuration: Define a single authoritative configuration model for active provider and model selection.
- untime-assembly: Define how gateway startup services and runtime refresh responsibilities are separated.
- chat-surface-modularity: Define behavioral boundaries for the chat UI's composition, streaming, input, and preview responsibilities.
- persistence-boundaries: Define explicit storage-facing interfaces for operational data domains.
- desktop-sidecar-lifecycle: Define deterministic sidecar generation and validation behavior for desktop development and build flows.

### Modified Capabilities
- None.

## Impact

- Affects packages/gateway, packages/core, packages/web, packages/memory, and packages/desktop.
- Changes configuration handling, runtime wiring, frontend composition, and desktop development ergonomics.
- Requires targeted regression coverage for provider selection, session/chat flows, and desktop startup.
