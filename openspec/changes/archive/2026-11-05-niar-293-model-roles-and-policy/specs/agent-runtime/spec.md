# Spec Delta

## ADDED Requirements

### Requirement: Escalation after a checker rejection

A workspace MAY set escalation to escalate with a tier or models; it SHALL be stop by default, where the chat model handles the rejection as before. When the write checker or the answer checker rejects a step and the run has not escalated yet, the next model step SHALL use the escalation models once. It SHALL count against the same root run's caps; unavailable escalation models SHALL leave the step to the chat model.

#### Scenario: Rejected write escalates

- **WHEN** escalation names the tier Strong and the checker rejects a proposed write
- **THEN** the model step that answers the rejection runs on Strong's model and later steps on the chat model again

#### Scenario: Second rejection

- **WHEN** the escalated step is rejected again
- **THEN** no further escalation happens in that run

### Requirement: Run steps name their model

Each model, selector and checker step of a run SHALL record the model, its role and the reason it served: `primary`, `fallback: <cause>`, or `escalated after checker mismatch` / `escalated after answer check`. A step that moved on to the next model before reaching its provider SHALL end failed.

#### Scenario: Fallback recorded

- **WHEN** a chat step moves from model A to model B because A's provider reached its limit
- **THEN** Runs shows A's step failed and B's step with role chat and reason `fallback: provider_limit`

## MODIFIED Requirements

### Requirement: Decision model as a hint

`find_service` and `find_actions` SHALL use the optional selector only as a hint: when it is confident it returns its choice, when it is not it returns up to three candidate services or the closest actions, and when it sees no fit the model still gets every service. Without a selector they SHALL list the candidates. A search SHALL never return an empty result while services exist.

#### Scenario: No confident fit

- **WHEN** the selector sees no service fitting the need
- **THEN** `find_service` returns all connected services with a note to choose one or say none holds the data

### Requirement: Write consistency check before approval

Before a write is proposed, the runtime SHALL ask the checker, a decision model or any tool-capable chat model, whether the action and its parameters do exactly what the person requested; a confident mismatch SHALL return `checker_mismatch` to the model and the write SHALL NOT be sent or shown for approval. After a write in a request fails this check, no further write SHALL be sent in that request. The checker never approves.

#### Scenario: Invented parameter

- **WHEN** the model proposes a write whose recipient the person never mentioned and the checker flags it
- **THEN** the write is not proposed and the model is told to recheck or ask

#### Scenario: Checker without OpenRouter

- **WHEN** a workspace has no OpenRouter provider and a local chat model in the checker role
- **THEN** writes are still checked before approval

### Requirement: Answer consistency check

The runtime SHALL check the final answer against the turn's receipts with the checker only when the answer carries risk: a write this turn with any outcome, a Tasks item created or closed, an explicit contact lookup, or an unresolved failed or rejected write. A read-only answer SHALL go out without this check. A rejected answer SHALL get one repair round; an unresolved failed or unknown write SHALL then end with the server's own failure reply.

#### Scenario: Read-only answer

- **WHEN** a turn only read data and wrote nothing
- **THEN** the answer is published without a consistency check

#### Scenario: Unsupported success claim

- **WHEN** an answer claims a write succeeded but the receipt failed, and the repair is rejected again
- **THEN** the person receives the server's failure reply for that write
