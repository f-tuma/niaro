# Spec Delta

## ADDED Requirements

### Requirement: Output of a meeting run

The output reference of a succeeded run started from a meeting SHALL name its origin as `meeting` with the conversation, request, meeting id and record digest, without the selected task or source bindings. The run's output preview and full output reading SHALL work as for any other run.

#### Scenario: Meeting run finishes

- **WHEN** a process started from a meeting succeeds with output
- **THEN** its task shows the output preview and the person's reads keep working

### Requirement: Output that cannot be referenced

When the server cannot build a succeeded run's output reference, the run's task SHALL still be shown with its output marked unavailable as `invalid`, and the server SHALL log it. Building the reference MUST NOT fail the person's snapshot or events read.

#### Scenario: Unknown origin

- **WHEN** a succeeded run's origin has no shape in the output reference
- **THEN** the task shows with output unavailable and the snapshot is answered
