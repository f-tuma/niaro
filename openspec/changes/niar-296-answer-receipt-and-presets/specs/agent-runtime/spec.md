## MODIFIED Requirements

### Requirement: Run steps name their model

Each model, selector and checker step of a run SHALL record the model, its role and the reason it served: `primary`, `fallback: <cause>`, or `escalated after checker mismatch` / `escalated after answer check`. A step that moved on to the next model before reaching its provider SHALL end failed. A step served by a member's preset SHALL record role `chat` and the preset's name.

#### Scenario: Fallback recorded

- **WHEN** a chat step moves from model A to model B because A's provider reached its limit
- **THEN** Runs shows A's step failed and B's step with role chat and reason `fallback: provider_limit`

#### Scenario: Preset recorded

- **WHEN** a member sends a message with the preset Thorough
- **THEN** Runs shows its model steps with role chat, reason `primary` and preset Thorough

## ADDED Requirements

### Requirement: Run records for the receipt

A chat run SHALL record, as server facts for its answer's receipt, the catalog model id, route and reason of its last finished model step, the meetings it read with `meeting_read` and the preset it was sent with. These records SHALL hold ids only, never content.

#### Scenario: Escalated answer

- **WHEN** a checker rejects a write and the escalated step writes the final answer
- **THEN** the run records the escalation model with reason `escalated after checker mismatch`
