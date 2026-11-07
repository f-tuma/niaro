# Spec Delta

## ADDED Requirements

### Requirement: Pi agent core

The server SHALL run one Pi Durable agent core over its own `node:sqlite` file in the identity directory, readable only by the server's user, opened when the server starts and closed before the identity database when it stops. On start it SHALL resume interrupted work under recovery policy A.

#### Scenario: Fresh start

- **WHEN** the server starts with no agent core file
- **THEN** it creates `identity.sqlite.pi.sqlite` next to the identity database with owner-only permissions

#### Scenario: Reopen

- **WHEN** the server restarts
- **THEN** the agent core reopens with its conversations and tasks as they were stored

### Requirement: Agent core models through Niaro only

Every model request of the agent core SHALL resolve its model role under the workspace's model policy to a catalog model at the time of the request and SHALL be sent only through the server's integration transport with that provider's key. No model SHALL be named in code, and no vendor SDK or direct fetch SHALL reach a provider.

#### Scenario: Policy changed between requests

- **WHEN** an administrator changes the chat role's models while a conversation runs
- **THEN** its next request goes to the newly chosen model

#### Scenario: Hook rewrites the model

- **WHEN** an extension's request hook changes the model in a request body
- **THEN** the request still goes to the model the policy chose

### Requirement: Agent core requests need a scope

The agent core SHALL refuse, before anything is sent, a model request of a conversation that does not name its organization, workspace and member.

#### Scenario: Conversation without a scope

- **WHEN** a conversation without a member scope asks for a model reply
- **THEN** the request is refused and no provider is called

### Requirement: Recovery policy A

After a restart, an interrupted model request MAY be retried at most twice in a run and at most three crashes in a row, each attempt reserved against the budget. An external write SHALL NOT be re-run unless it carries an idempotency key; without one the model SHALL be told the call was interrupted.

#### Scenario: Killed during a model reply

- **WHEN** the server is killed while a model reply streams
- **THEN** after the restart the request is retried once, the killed attempt keeps its budget hold, and one answer is recorded

#### Scenario: Killed after a write without a key

- **WHEN** the server is killed after a write without an idempotency key took effect but before its result was stored
- **THEN** after the restart the write does not run again and the model receives an interrupted result

#### Scenario: Killed after a write with a key

- **WHEN** the same crash happens to a write with an idempotency key
- **THEN** the write runs again with the same key and the service keeps one effect
