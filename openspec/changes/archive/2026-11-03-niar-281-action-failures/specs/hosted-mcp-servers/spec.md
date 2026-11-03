# Spec Delta

## ADDED Requirements

### Requirement: Microsoft 365 mail search order

When the Microsoft 365 built-in's `list-mail-messages` or `list-mail-folder-messages` is called with a non-empty `$search`, the system SHALL send the call without `$orderby` (any spelling, with or without `$`), because Microsoft Graph refuses the two together and returns search matches by relevance. Every other parameter, and calls without a search, SHALL be sent as given.

#### Scenario: Sorted mail search

- **WHEN** the model lists mail with `$search` "from:jane@example.test" and `$orderby` "receivedDateTime desc"
- **THEN** the call reaches the server with `$search` and without `$orderby`

#### Scenario: Sorted list without search

- **WHEN** the model lists mail with only `$orderby`
- **THEN** the order is sent unchanged
