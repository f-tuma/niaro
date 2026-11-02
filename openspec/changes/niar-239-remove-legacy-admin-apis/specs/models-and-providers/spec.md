# Spec Delta

## MODIFIED Requirements

### Requirement: Speech recognition choice

The workspace SHALL choose speech recognition as off or a catalog model in a mode: **AI interpreter** with an enabled `chat` model that has audio input, or **Direct transcription** with a `transcription` model. A catalog choice without a model SHALL fail with 409 `catalog_model_required`, a model unfit for the mode with 409 `catalog_model_unavailable`. There SHALL be no fallback between modes or models (behavior in `voice`). A saved choice of the retired server profile voice SHALL read as off.

#### Scenario: Direct transcription with a chat model

- **WHEN** an administrator selects Direct transcription with a chat model
- **THEN** the save fails with `catalog_model_unavailable`

#### Scenario: Speech recognition off

- **WHEN** an administrator chooses Off
- **THEN** voice input is unavailable in that workspace

#### Scenario: Workspace that used the server profile voice

- **WHEN** a workspace saved speech recognition as the server profile before the upgrade
- **THEN** after the upgrade the model choice page shows speech recognition as Off, voice input is unavailable, and an administrator can choose a catalog model

#### Scenario: Retired option in a save

- **WHEN** a model choice save names the server profile voice mode
- **THEN** the save fails as invalid input and the stored choice is unchanged
