## ADDED Requirements

### Requirement: Persistence access is grouped by operational domain
The system SHALL provide explicit persistence-facing interfaces for distinct operational domains such as session history, long-term memory, traces, usage, and settings.

#### Scenario: Runtime code needs settings access
- **WHEN** a runtime module reads or writes settings data
- **THEN** it does so through a settings-oriented persistence interface
- **AND** it does not require direct dependence on unrelated session, trace, or memory operations

### Requirement: Existing SQLite behavior remains compatible during boundary extraction
The system SHALL preserve current SQLite-backed storage behavior while interface boundaries are introduced.

#### Scenario: Repository interfaces are adopted incrementally
- **WHEN** one operational domain migrates to a dedicated interface before others
- **THEN** existing persisted data and runtime behavior remain compatible
- **AND** unaffected domains continue to function without forced simultaneous migration
