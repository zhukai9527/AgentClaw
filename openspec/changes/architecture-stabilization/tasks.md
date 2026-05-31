## 1. Runtime Configuration

- [ ] 1.1 Document and codify canonical provider/model resolution around providers[] + activeProvider
- [ ] 1.2 Update config read/write paths so legacy fields are compatibility inputs rather than the primary write model
- [ ] 1.3 Add regression coverage for resolved active provider/model behavior exposed through runtime config APIs

## 2. Gateway Runtime Assembly

- [ ] 2.1 Extract configuration migration and provider factory responsibilities out of packages/gateway/src/bootstrap.ts
- [ ] 2.2 Introduce explicit runtime refresh ownership for provider reload, agent reload, prompt refresh, and health refresh
- [ ] 2.3 Verify gateway startup behavior remains compatible after assembly boundaries are introduced

## 3. Chat Surface Modularity

- [ ] 3.1 Identify and extract chat session/streaming responsibilities into dedicated hooks or modules
- [ ] 3.2 Extract composer, preview, and auxiliary input behavior behind narrower component boundaries
- [ ] 3.3 Add or update focused tests for session creation, streaming, uploads, tool rendering, and preview flows

## 4. Persistence Boundaries

- [ ] 4.1 Define repository-style interfaces for settings, usage, traces, session history, and long-term memory domains
- [ ] 4.2 Migrate the highest-churn runtime callers to the new persistence interfaces without changing persisted behavior
- [ ] 4.3 Keep SQLite-backed storage behavior compatible while interface adoption proceeds incrementally

## 5. Desktop Sidecar Lifecycle

- [ ] 5.1 Update desktop dev/build commands so sidecar generation or validation happens before Tauri resource validation
- [ ] 5.2 Improve desktop failure messaging for missing sidecar tooling or expected artifacts
- [ ] 5.3 Verify desktop workflows produce or validate the expected sidecar outputs on the supported local development path

## 6. Execution Discipline

- [ ] 6.1 Use OpenSpec 	asks.md as the execution source of truth for this change
- [ ] 6.2 Apply Superpowers practices during implementation, especially 	est-driven-development, systematic-debugging, equesting-code-review, and erification-before-completion
- [ ] 6.3 Reconcile any newly discovered scope changes back into proposal, design, specs, or tasks before implementation drifts
