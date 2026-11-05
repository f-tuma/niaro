# knowledge Specification

## Purpose
Workspace knowledge: a derived, rebuildable index over the files people send in chat and the service sources an administrator picks, searched by the assistant with every hit re-checked against the asker's current access and cited under the answer. It is not a document store: no folders, no editing.

## Requirements

### Requirement: Derived knowledge index

Each workspace SHALL have a knowledge index of passages from its indexed sources, kept apart from the identity database and derived: dropping it SHALL lose nothing a rebuild cannot restore. It SHALL exist only while the workspace's `embedding` role has a model. Knowledge SHALL never be a document store: no upload outside a chat, folders, editing or sharing.

#### Scenario: Embedding role off

- **WHEN** a workspace has no embedding model and a member sends a file
- **THEN** nothing is embedded, the agent has no knowledge search and the Knowledge sheet says knowledge is off

### Requirement: What is indexed

Files people send in a chat SHALL be indexed for their sender while files are on (the default) and the server reads attached files. A read action SHALL be indexed only when an administrator picks it: at most 20 per workspace, each an enabled read without approval or required input of a shared, enabled service whose reads do not run under each person's own sign-in.

#### Scenario: Nothing picked

- **WHEN** an administrator turns knowledge on by choosing an embedding model
- **THEN** no service source is indexed until one is picked

#### Scenario: Personal service

- **WHEN** an administrator tries to pick a read of a service that reads with each person's own account
- **THEN** it is not offered and a save naming it fails with 409 `knowledge_source_unavailable`

### Requirement: Access labels

Every passage SHALL carry its workspace, its kind, the person who sent its file or the service and action of its source. A search SHALL rank only passages of the asker's workspace, embedded with the current embedding model, that are their own files or sources they may read.

#### Scenario: Another person's file

- **WHEN** Bob sent a price list and Alice asks about prices
- **THEN** no passage of Bob's file reaches Alice

### Requirement: Hits re-checked before use

Before a passage reaches a model or a receipt, it SHALL be re-checked against the asker's current identity and access: still a member, a file still theirs and available to them while files are on, a source still picked and its action allowed to them. A failed check SHALL drop the passage without saying why.

#### Scenario: Access lost

- **WHEN** Carol loses access to the picked Wiki action and searches again
- **THEN** no Wiki passage reaches her

#### Scenario: Chat deleted

- **WHEN** Alice deletes the chat in which she sent a file
- **THEN** her next search finds no passage of that file, before any rebuild

### Requirement: Knowledge search tool

While the workspace has an embedding model, the agent SHALL have `knowledge_search {q, limit≤8}`, at most 4 per request. The question SHALL be embedded with the workspace's embedding model as a model call of the request. Passages SHALL come with their source name, framed as untrusted data; the request SHALL keep only their ids.

#### Scenario: Price question

- **WHEN** Alice asks what installation costs and she sent the price list earlier
- **THEN** the agent may search knowledge, answer from the passage and name "price-list.pdf"

### Requirement: Index passes

Files SHALL be indexed when a chat reads them; saving the settings or importing them SHALL run a pass; **Rebuild index** SHALL drop the workspace's index and build it again. A pass SHALL skip documents whose text, passage settings and model are unchanged, drop removed sources and run one at a time per workspace.

#### Scenario: Nothing changed

- **WHEN** an administrator saves unchanged settings
- **THEN** the pass sends no embedding request

#### Scenario: Model changed

- **WHEN** an administrator picks another embedding model
- **THEN** earlier passages are reported stale and not searched until the index is rebuilt

### Requirement: Index status

The workspace's index status SHALL show the embedding model, passages, documents, last sync, the progress of a running pass, stale passages and recent errors by source name and code, never content. A pass SHALL stop at a provider limit, a missing price, an unavailable model or a refused key.

#### Scenario: Unreadable scan

- **WHEN** a sent image has no readable text
- **THEN** the status lists its file name with `knowledge_empty`
