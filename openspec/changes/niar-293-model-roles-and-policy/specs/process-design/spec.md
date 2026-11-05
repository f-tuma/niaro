# Spec Delta

## MODIFIED Requirements

### Requirement: Drafting a process from chat

When a person asks in chat to create a process, or to add something to their overview that no addable process does, the chat agent SHALL be able to call `process_propose {request, name?, addToHub, hubView?, sessionId?}`. It SHALL run the designer on the first priced model of the designer role for a new personal session under the person's authority and budget and end the turn with a `process.proposal` card. Proposing SHALL save nothing.

#### Scenario: Replayed tool call

- **WHEN** the same `process_propose` call is replayed
- **THEN** the same session and turn are returned without new inference

#### Scenario: Answering the designer's questions

- **WHEN** the card has status `questions` and the person answers in chat
- **THEN** the agent calls `process_propose` with that `sessionId` and the session continues

#### Scenario: Designer role without a price

- **WHEN** no model of the designer role has a price
- **THEN** the card says the AI budget is not set up and no model is called
