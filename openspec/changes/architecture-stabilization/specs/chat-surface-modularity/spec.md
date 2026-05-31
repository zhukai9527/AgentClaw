## ADDED Requirements

### Requirement: Chat responsibilities are composed through stable seams
The web chat surface SHALL separate session lifecycle, streaming state, message composition, preview behavior, and auxiliary input concerns into explicit composition seams.

#### Scenario: Chat behavior is refactored internally
- **WHEN** chat implementation responsibilities are moved into hooks or subordinate components
- **THEN** message sending, streaming, tool rendering, editing, uploads, and preview behavior remain functionally equivalent for users
- **AND** no single page-level module remains responsible for all of those behaviors directly

### Requirement: High-risk chat behaviors remain regression-testable
The system SHALL preserve stable, testable behavior for the chat flows most likely to regress during structural refactors.

#### Scenario: A new session is started from chat
- **WHEN** a user sends the first message in a new chat context
- **THEN** the system creates or resolves the session correctly
- **AND** subsequent streaming and history behavior continue to use that session without duplication or loss
