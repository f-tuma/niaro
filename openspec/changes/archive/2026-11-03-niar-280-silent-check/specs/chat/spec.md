# Spec Delta

## MODIFIED Requirements

### Requirement: Thinking row

Clients SHALL poll progress from 250 ms after sending, then every 500 ms (250 ms while a draft is present), and SHALL show one "Thinking" row with elapsed seconds that reads "Reading <service>" while a service is read, with the draft drawn below it; the stored message SHALL replace both on completion. Unavailable progress, an offline client and a lost outcome the client is still checking SHALL keep the "Thinking" row; they SHALL NOT be shown as unconfirmed, and unavailable progress SHALL NOT fail or retry the command. Only a request that failed SHALL replace the row with "Request interrupted". Reasoning SHALL never be shown.

#### Scenario: Service read during an answer

- **WHEN** the assistant reads the CRM while answering
- **THEN** the row reads "Reading" with the service's name instead of "Thinking"

#### Scenario: Progress unavailable

- **WHEN** the activity route fails
- **THEN** the chat keeps the "Thinking" row without resending the command
