## ADDED Requirements

### Requirement: Startup assembly responsibilities are separated
The gateway runtime SHALL separate startup assembly responsibilities into explicit subsystems for configuration loading, dependency creation, orchestrator assembly, and runtime refresh handling.

#### Scenario: Gateway starts successfully
- **WHEN** the gateway process boots
- **THEN** provider creation, tool registration, memory initialization, skill loading, agent loading, and orchestrator construction occur through explicit assembly boundaries
- **AND** the resulting runtime behavior remains compatible with existing startup expectations

### Requirement: Runtime refresh actions have explicit ownership
The gateway SHALL route provider reloads, agent reloads, system prompt refreshes, and health refreshes through explicit runtime refresh handlers rather than ad hoc bootstrap state mutation.

#### Scenario: Provider configuration changes at runtime
- **WHEN** configuration updates require a provider or model change
- **THEN** the runtime refresh path rebuilds and swaps the active provider through a dedicated refresh boundary
- **AND** the orchestrator and runtime config reflect the updated provider state consistently
