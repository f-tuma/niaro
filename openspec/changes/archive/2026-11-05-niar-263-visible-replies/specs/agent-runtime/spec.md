# Spec Delta

## MODIFIED Requirements

### Requirement: Provider history projection

What the model sees of earlier steps SHALL be projected on every call: calls of the current run show the arguments the model sent (arguments over 4,000 characters replaced by an omission note), rejected calls and calls restored from a checkpoint stay opaque, and earlier turns' calls collapse into one note naming each call and how it ended, with their results dropped. Earlier answers follow `Earlier answers stay visible`.

#### Scenario: Earlier private answer

- **WHEN** a follow-up turn runs after an answer that used CRM data the person can no longer access
- **THEN** the model sees that earlier answer only as "[Prior private response withheld]"

#### Scenario: Earlier call

- **WHEN** a follow-up turn runs after an answer that read CRM data
- **THEN** the model sees the read only as a note naming the call and its outcome, without its result

## ADDED Requirements

### Requirement: Earlier answers stay visible

An earlier answer of the person's chat SHALL stay visible to the model, in the thread's history and in a fresh thread's earlier messages next to the person's own. Checked on every turn, it SHALL be replaced by "[Prior private response withheld]" when a saved item it drew on was forgotten, revised, expired or became unreadable, or a service result it drew on lost access (policy revision, grant or sign-in). Unknown provenance SHALL be withheld.

#### Scenario: Unrelated saved memory

- **WHEN** the person has saved memory, the assistant answered "5837" and the person asks "Jaké číslo jsi napsal?"
- **THEN** the model sees its answer "5837"

#### Scenario: Forgotten memory

- **WHEN** an answer drew on a saved item that the person then forgets
- **THEN** later turns see that answer only as "[Prior private response withheld]"

#### Scenario: Service access

- **WHEN** an answer built on a CRM read is followed by another turn while the read is still accessible, and later by a policy change
- **THEN** the next turn sees the answer, and turns after the policy change see it withheld

#### Scenario: Fresh thread

- **WHEN** a turn of the chat starts a fresh thread
- **THEN** the model gets the person's earlier messages and the assistant's replies that pass the check
