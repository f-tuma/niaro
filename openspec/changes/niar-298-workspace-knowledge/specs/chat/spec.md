## MODIFIED Requirements

### Requirement: Answer receipt line

Under every finished answer the web and the phone SHALL show one muted line from the answer's receipt: counts of service reads and changes, memories, skills, meetings, files and knowledge sources, then "Answered by" the preset and the model. Pressing it SHALL open the items, a source with its passage under its name, with the expanded state exposed. It SHALL show no delivery state and no line for an empty receipt or a server without receipts.

#### Scenario: Answer that read the CRM

- **WHEN** an answer read contacts from Acme CRM and drew on one memory, written by the chat model "GPT Luna"
- **THEN** the line reads "Read 1 · Memories 1 · Answered by GPT Luna" and opens to "Find contacts (Acme CRM)" and the memory

#### Scenario: Nothing recorded

- **WHEN** a receipt has no reads, changes, context items or model
- **THEN** the answer shows no line

#### Scenario: Cited passages

- **WHEN** an answer was given two knowledge passages, from "price-list.pdf" and "Wiki · Procedures"
- **THEN** the line shows "Sources 2" and opens to both names, each with its passage

### Requirement: Answer receipt contents

A receipt SHALL be built only from the server's records of the request, never from the answer's text: succeeded service reads and writes (not waiting approvals, refusals or unknown outcomes), memory saves, open items created or closed, the saved items that reached the model, loaded skills, tagged or read meetings, the person's files, the knowledge passages it was given (at most 10, re-checked for the reader) and the model of the last finished step.

#### Scenario: Write waiting for approval

- **WHEN** an answer proposed a write that still waits for approval
- **THEN** its receipt lists no change for it

#### Scenario: Cited file gone

- **WHEN** the person deletes the chat whose file an answer cited
- **THEN** that answer's receipt no longer lists the passage
