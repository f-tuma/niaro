# Spec Delta

## ADDED Requirements

### Requirement: Memories from the person's AI app

A memory saved by the person's own AI app over MCP (`mcp-server`, `niaro_memory_save`) SHALL be a private, active memory with the source `external_app` carrying the app's access label and the trust `model_inference`. The phone and web profile and the memory panel SHALL name the app as its source; the person SHALL edit or delete it like any other memory. Its save SHALL be audited as `memory.changed` with source `mcp`.

#### Scenario: Shown with the app's name

- **WHEN** the person's app "Claude Desktop" saves a fact and the person opens their profile
- **THEN** the memory shows "Saved by Claude Desktop" and offers deleting it

#### Scenario: Deleted by the person

- **WHEN** the person deletes that memory in their profile
- **THEN** it is erased like any other memory and the app no longer finds it
