# Spec Delta

## MODIFIED Requirements

### Requirement: Voice input capabilities

The server SHALL report voice input at authenticated `GET /v1/{workspace}/voice` as profile `agent-voice/5` with `enabled`, the engine and model, where audio is processed (`connected_server` for the local engine, `cloud` otherwise), the languages `en` and `cs`, and a maximum of 120 seconds. A cloud engine SHALL name the model of the voice input role or of the server profile's configuration; no model is built in.

#### Scenario: Cloud transcription disclosed

- **WHEN** the workspace's voice input role has a cloud model
- **THEN** the capabilities say `processing: "cloud"` and name the model

#### Scenario: Server profile without a model

- **WHEN** the server's own cloud voice profile has no configured model
- **THEN** voice input through it is unavailable
