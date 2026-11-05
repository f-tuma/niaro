# Spec Delta

## ADDED Requirements

### Requirement: Chat thread continuity

A new turn of the same chat session SHALL continue the chat's assistant thread unless something the thread used is no longer current: a service result whose authority or policy revision changed, or saved memory it used (see `memory`). A policy change SHALL NOT end a thread that used no service result. A retry of a failed turn SHALL continue the thread. A turn of the same chat that starts a fresh thread SHALL log why, without personal data.

#### Scenario: Follow-up after a save

- **WHEN** the person writes "try it again" after a reply that saved a memory, and nothing the reply used changed
- **THEN** the turn continues the same thread

#### Scenario: Policy change without service data

- **WHEN** an administrator changes a role between two turns of a chat that used no service
- **THEN** the next turn continues the same thread

#### Scenario: Policy change after a read

- **WHEN** the policy changes after a turn that read CRM data
- **THEN** the next turn starts a fresh thread

#### Scenario: Retry

- **WHEN** the person retries a turn that failed
- **THEN** the retry continues the chat's thread and sees its earlier turns
