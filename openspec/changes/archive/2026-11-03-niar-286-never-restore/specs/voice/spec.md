# Spec Delta

## MODIFIED Requirements

### Requirement: Transcription failures

Voice errors SHALL use stable codes: `voice_unavailable` when no transcriber is configured, `voice_busy` (429) when more than 16 chat voice requests already wait, `voice_model_limit` when the provider allowance is exhausted, `voice_processing_failed` for a failed or malformed provider answer, and `voice_cancelled` when aborted. A failed transcription SHALL allow an explicit retry. A transcript that could not be sent at all SHALL stay for review; one that was sent and then failed SHALL stay in its chat as a failed message with Try again and SHALL NOT be put into the composer.

#### Scenario: Provider allowance exhausted

- **WHEN** the provider's request allowance is used up
- **THEN** transcription fails with `voice_model_limit`

#### Scenario: Sent and refused

- **WHEN** a spoken message is sent and the server refuses it
- **THEN** the chat shows it as a failed message with Try again and the composer stays empty
