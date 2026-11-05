# Spec Delta

## MODIFIED Requirements

### Requirement: Whole-meeting record

After transcription, one structured call of a closed agent with no memory or business tools, on the workspace's background model (see `models-and-providers`), SHALL receive all transcript segments in order with the meeting's title, local date, weekday, time zone and known attendees and companies, and SHALL produce one summary, important points, decisions, action items and open questions. Processing MUST NOT write to any service or send any message.

#### Scenario: No side effects

- **WHEN** a meeting mentions sending an offer to a customer
- **THEN** processing creates a task at most and sends nothing

#### Scenario: Background model

- **WHEN** the background role has a different model than chat
- **THEN** the meeting record is written by the background model
