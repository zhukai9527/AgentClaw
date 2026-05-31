## ADDED Requirements

### Requirement: Desktop workflows prepare sidecar binaries before Tauri validation
The desktop development and build workflows SHALL ensure that required sidecar binaries are generated or validated before Tauri performs resource validation.

#### Scenario: Developer starts desktop dev workflow
- **WHEN** the desktop development command is executed on a supported platform
- **THEN** the workflow builds or validates the expected sidecar binary before invoking 	auri dev
- **AND** missing sidecar resources do not first surface as late Tauri resource-path failures

### Requirement: Sidecar failures are actionable
The desktop workflow SHALL fail with explicit guidance when sidecar prerequisites or generated binaries are missing.

#### Scenario: Sidecar build prerequisites are unavailable
- **WHEN** required tooling or expected sidecar outputs are missing
- **THEN** the desktop command fails with an error that identifies the missing prerequisite or artifact
- **AND** the error tells the developer which step or command is required to recover
