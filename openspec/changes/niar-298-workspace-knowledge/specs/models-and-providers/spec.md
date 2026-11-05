## MODIFIED Requirements

### Requirement: Model roles

The model policy SHALL map each role to an ordered list of up to 8 catalog models, the first being the primary, or to a tier: `chat`, per-service `service:<id>`, `checker`, `selector`, `background`, `designer`, `web_search`, `voice_input`, `meeting_transcription`, `speech`, `embedding` (workspace knowledge) and reserved `vision` that nothing uses yet. An empty list SHALL turn a role off. A role nobody set SHALL follow another: background, designer and web search follow chat, the checker the selector.

#### Scenario: Background follows chat

- **WHEN** only the chat role has models
- **THEN** widget fills use the chat model and the policy shows background work as inherited from chat

#### Scenario: Role turned off

- **WHEN** a workspace sets the selector to an empty list
- **THEN** service search lists candidates without a selector

## ADDED Requirements

### Requirement: Embedding models

A catalog model MAY have the kind `embedding`, with no tools or audio. The `embedding` role SHALL take only embedding models, of any provider, called through the OpenAI-compatible `POST {provider}/embeddings` with the administrator's model name; other roles SHALL refuse them. No embedding model SHALL be chosen by code.

#### Scenario: Local embeddings

- **WHEN** an administrator adds `nomic-embed-text` of a local Ollama provider as an embedding model and sets it as the embedding role
- **THEN** knowledge embeds with it through that provider's `/v1/embeddings`

#### Scenario: Chat model as embeddings

- **WHEN** an administrator sets a chat model as the embedding role
- **THEN** the save fails with 409 `catalog_model_unavailable`
