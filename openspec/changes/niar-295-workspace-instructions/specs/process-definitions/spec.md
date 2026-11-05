# Spec Delta

## ADDED Requirements

### Requirement: Variables in process prompts

An agent step's configured instructions SHALL have the prompt variables (see `agent-runtime`) filled in for the person running the process each time its model is prepared, with `{today}` in the workspace's time zone. Frozen definitions, their digests and the editors SHALL keep the text as typed. Workspace instructions SHALL NOT be added to process runs.

#### Scenario: Personal report

- **WHEN** a process step says "write a summary for {person.name} dated {today}"
- **THEN** the model reads the running person's name and the workspace's current date, and the definition's digest is unchanged
