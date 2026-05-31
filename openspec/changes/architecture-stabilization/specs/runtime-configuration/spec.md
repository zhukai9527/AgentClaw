## ADDED Requirements

### Requirement: Canonical active provider resolution
The system SHALL resolve the active runtime provider and model from a single canonical configuration model based on providers[] and ctiveProvider, while continuing to accept legacy configuration fields only as compatibility inputs.

#### Scenario: Active provider is configured
- **WHEN** configuration contains multiple provider entries and one provider is marked as the active provider
- **THEN** the runtime selects that provider as the primary provider
- **AND** the runtime exposes the resolved provider and model consistently through runtime configuration and config APIs

#### Scenario: Legacy fields are present during migration
- **WHEN** legacy provider/model fields are present and canonical provider entries are absent
- **THEN** the runtime derives canonical provider information from the legacy fields for compatibility
- **AND** future writes use the canonical provider structure as the source of truth

### Requirement: Provider/model precedence is inspectable
The system SHALL make effective provider/model precedence understandable to operators and frontend clients.

#### Scenario: Config is retrieved from the API
- **WHEN** a client requests current application configuration
- **THEN** the response includes the resolved active provider and model
- **AND** those values match the runtime provider currently used for chat orchestration
