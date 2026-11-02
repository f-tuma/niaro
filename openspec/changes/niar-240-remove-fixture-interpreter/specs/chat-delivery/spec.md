## ADDED Requirements

### Requirement: Account workspaces only

The app API SHALL serve only account workspaces, addressed by their workspace id and reached with a credential issued through account sign-in. The fixed operator workspaces `/v1/a` and `/v1/b` and their operator pairing codes SHALL NOT exist: any app API route under such a path SHALL answer `404 not_found`, and no command, snapshot or event SHALL be served there.

#### Scenario: Old operator workspace path

- **WHEN** a client calls `GET /v1/a/snapshot` with any bearer token
- **THEN** the server answers `404 not_found` and returns no chat data

#### Scenario: Old operator credential on an account workspace

- **WHEN** a client presents a token issued for an operator workspace to `/v1/<workspaceId>/snapshot` of an account workspace
- **THEN** the server answers `401` and returns no chat data

### Requirement: Removed fixture commands

The command set SHALL NOT contain `input.submit`, `proposal.decide`, `proposal.revise` or `operation.reconcile`. A command of such a type SHALL be refused as invalid (`400 invalid_payload`) without a receipt, without an event and without contacting any calendar, CRM or model. Answers to an agent's question SHALL be sent as `message.send` and SHALL always be handled by the agent runtime.

#### Scenario: Old approval command

- **WHEN** a client sends `proposal.decide` with fresh ids
- **THEN** the server answers `400 invalid_payload`
- **AND** no receipt is stored and the snapshot cursor does not change

#### Scenario: Retrying an old command after upgrade

- **WHEN** a client resends an `input.submit` whose original receipt was stored before the upgrade
- **THEN** the server answers `400 invalid_payload` and performs no effect

#### Scenario: Answer to a question without a runtime marker

- **WHEN** a client answers an open agent question with `message.send` whose `context` names the question but omits `runtime`
- **THEN** the agent runtime validates the question binding and either continues the run or refuses with a conflict
- **AND** the server never interprets the text as a contact choice or a meeting request

### Requirement: Workflow snapshot contents

A snapshot SHALL carry profile `agent-client/0.9`, the scope, the cursor, conversations and work items only. A work item SHALL be an agent run or process run with a `native` binding and SHALL carry no `demo` flag and no input request, proposal or operation references. Events SHALL be `conversation.upserted` and `work_item.upserted` only.

#### Scenario: Snapshot of a workspace with a paused question

- **WHEN** a client reads the snapshot of a workspace whose agent waits for an answer
- **THEN** the snapshot lists the conversation and one work item with its `native.question`
- **AND** the snapshot has no `inputRequests`, `actionProposals` or `operations` field

#### Scenario: Client on the previous workflow profile

- **WHEN** a client that only understands `agent-client/0.8-fixture` reads a snapshot
- **THEN** the snapshot fails the client's profile check and is not applied, so the client shows no partial data

### Requirement: Fixture state migration

On first start after the upgrade the server SHALL migrate workflow storage once, in one transaction, before serving: it SHALL delete all operator-workspace state and remove from account workspaces every proposal, operation, input request, demo work item, fixture job, meeting draft, fixture memory, `crm.contacts` message result and receipt of a removed command. Chats, message text, native work, other receipts and search SHALL stay unchanged.

#### Scenario: Stored contact card

- **WHEN** an account chat holds an assistant message whose result is a `crm.contacts` card
- **THEN** after the migration the message is still in the chat with the same text and no result

#### Scenario: Event cursor across the upgrade

- **WHEN** a client polls events with a cursor it held before the upgrade
- **THEN** the server answers `409 snapshot_required` and the client loads a fresh snapshot

#### Scenario: Older server on migrated storage

- **WHEN** a server version from before this change opens migrated workflow storage
- **THEN** it refuses to start because the storage version is unsupported, and the data stays unchanged

#### Scenario: Interrupted migration

- **WHEN** the server stops during the migration
- **THEN** nothing of the migration is committed and the next start runs it again from the unchanged data

## MODIFIED Requirements

### Requirement: Result type negotiation

Each client SHALL name the message result types it renders with `results=` (comma-separated `type/version`). The baseline `service.action/1`, `service.connection/1` and `card.document/1` SHALL always be delivered; any other result SHALL reach only clients that name it, and the others SHALL receive the same message without `result`, i.e. its text. Malformed or unknown tokens SHALL be ignored, and history pages SHALL never carry results.

#### Scenario: Client without process offers

- **WHEN** a client that does not declare `process.offer/1` receives a message with a process offer
- **THEN** it receives the message text without the offer

#### Scenario: Client still naming contact results

- **WHEN** a client sends `results=crm.contacts/1,service.action/1`
- **THEN** the server accepts the request, ignores `crm.contacts/1` and delivers service action results
