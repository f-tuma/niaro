## ADDED Requirements

### Requirement: Answer receipt line

Under every finished answer the web and the phone SHALL show one muted line from the answer's receipt: counts of service reads and changes, memories, skills, meetings and files, then "Answered by" the preset and the model. Pressing it SHALL open the items, with its expanded state exposed. It SHALL show no delivery state and no line for an empty receipt or a server without receipts.

#### Scenario: Answer that read the CRM

- **WHEN** an answer read contacts from Acme CRM and drew on one memory, written by the chat model "GPT Luna"
- **THEN** the line reads "Read 1 · Memories 1 · Answered by GPT Luna" and opens to "Find contacts (Acme CRM)" and the memory

#### Scenario: Nothing recorded

- **WHEN** a receipt has no reads, changes, context items or model
- **THEN** the answer shows no line

### Requirement: Answer receipt contents

A receipt SHALL be built only from the server's records of the request, never from the answer's text: succeeded service reads and writes (not waiting approvals, refusals or unknown outcomes), memory saves, open items created or closed, the saved items that reached the model, loaded skills, tagged or read meetings, the person's files, and the model of the last finished step.

#### Scenario: Write waiting for approval

- **WHEN** an answer proposed a write that still waits for approval
- **THEN** its receipt lists no change for it

### Requirement: Receipt model names

The receipt SHALL name the model only by the administrator's display name of the catalog model, and say "fallback model" after a fallback before dispatch or "stronger model after a check" after an escalation. A removed model SHALL leave the model out.

#### Scenario: Fallback

- **WHEN** the chat step moved to the second model because the first provider reached its limit
- **THEN** the line ends "Answered by <second model's name>, fallback model"

### Requirement: Receipt access

A receipt SHALL list only items the person asking can open now: services they may still use, their own meetings and open items, usable skills, memories readable to them and files still available. The API SHALL return only the person's own turns.

#### Scenario: Access removed

- **WHEN** an administrator removes the member's access to the CRM action an answer used
- **THEN** that answer's receipt no longer lists the read

### Requirement: Receipt API

`GET /v1/:workspace/receipts?conversationId=` SHALL return the receipts of the person's latest 40 turns of that chat, each keyed by the request the answer replies to. Clients SHALL read it again when a new answer is stored and show no line when it fails.

#### Scenario: Missing chat id

- **WHEN** the app calls the receipts API without `conversationId`
- **THEN** the server answers 400

### Requirement: Preset picker in the chat

When the workspace offers model presets, the web composer SHALL show a select labelled "Model preset" and the phone a radio group above the composer, each with Default and the offered presets by name. The picked preset SHALL go with the next messages; a preset no longer offered SHALL fall back to Default without a notice.

#### Scenario: Thorough picked

- **WHEN** the member picks Thorough and sends a message
- **THEN** the message is sent with the preset `thorough` and the composer stays empty

#### Scenario: No presets offered

- **WHEN** the workspace offers no presets
- **THEN** neither app shows a picker
