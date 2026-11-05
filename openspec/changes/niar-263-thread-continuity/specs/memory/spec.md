# Spec Delta

## ADDED Requirements

### Requirement: Memory changes and chat threads

A chat's thread SHALL end only when saved memory that reached its model was since forgotten, corrected, expired or became unreadable. Saves, learner observations, items the thread never used and other people's memory SHALL NOT end it. A fact saved from the person's own words in that chat SHALL NOT count as used. Pending approvals and runs keep the exact version check (see Memory change invalidates pending work).

#### Scenario: Learner between turns

- **WHEN** the pet learner notices something about the person between two turns
- **THEN** the next turn continues the same thread

#### Scenario: Forgotten memory

- **WHEN** the person forgets a memory the chat's earlier reply used
- **THEN** the next turn starts a fresh thread that never contains it

#### Scenario: Save deleted under the reply

- **WHEN** the person deletes a fact the chat just saved from their message
- **THEN** the chat continues the same thread

#### Scenario: Another member

- **WHEN** another member of the workspace saves or forgets their own memory
- **THEN** this person's chat continues the same thread
