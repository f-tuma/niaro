# models-and-providers Specification

## Purpose

How organization owners and administrators connect AI providers, keep the organization's model catalog, and choose per workspace which model serves each function: chat and service actions, speech recognition, meeting transcription, spoken replies and the decision model.

## Requirements

### Requirement: Organization-owned providers

The system SHALL let an organization owner or administrator add, edit and remove AI providers of the organization, each an OpenAI-compatible endpoint with a name, API base URL, enabled state, daily request limit (1–100,000) and an optional API key. An organization SHALL hold at most 50 providers. Members SHALL be refused every provider, model and routing command with 403 `identity_forbidden`.

#### Scenario: Administrator adds OpenRouter

- **WHEN** an administrator saves a provider with base URL `https://openrouter.ai/api/v1` and a key
- **THEN** the provider appears in the organization's catalog with `hasCredential: true` and `requestsToday: 0`

#### Scenario: Member tries to add a provider

- **WHEN** a member sends a `saveProvider` catalog command
- **THEN** the server answers 403 `identity_forbidden` and stores nothing

#### Scenario: Provider limit

- **WHEN** an organization already has 50 providers and an administrator adds another
- **THEN** the server answers 409 `identity_limit`

### Requirement: Provider endpoint policy

The system SHALL accept a provider base URL only when it is HTTPS or its origin is listed in the server's trusted integration origins (Settings, see `administration`); any other URL SHALL be refused with 403 `integration_origin_denied`.

#### Scenario: Local model server not trusted

- **WHEN** an administrator saves a provider at `http://127.0.0.1:11434/v1` while that origin is not trusted
- **THEN** the save fails with `integration_origin_denied`

#### Scenario: Trusted local origin

- **WHEN** `http://127.0.0.1:11434` is a trusted integration origin
- **THEN** a provider at `http://127.0.0.1:11434/v1` can be saved

### Requirement: Write-only provider keys

The system SHALL store provider API keys encrypted in the identity store, SHALL never return them in any response (only `hasCredential`), and SHALL keep the stored key when a provider is saved without a new key.

#### Scenario: Edit a provider without retyping the key

- **WHEN** an administrator changes a provider's daily limit and sends no key
- **THEN** the provider keeps its key and `hasCredential` stays true

### Requirement: Provider daily request limit

The system SHALL count each provider's requests per UTC day and SHALL refuse to dispatch a model request to a provider whose daily request limit is reached with 429 `catalog_provider_limit`; usage limits in money are specified in `inference-budget`.

#### Scenario: Limit reached

- **WHEN** a provider has used all of today's requests and a chat turn needs its model
- **THEN** no request is sent to the provider and the turn reports that the provider's daily request limit was reached

### Requirement: Provider removal

The system SHALL refuse to remove a provider that still has models with 409 `catalog_provider_in_use`.

#### Scenario: Remove a provider with models

- **WHEN** an administrator removes a provider that has two models
- **THEN** the server answers 409 `catalog_provider_in_use` and nothing changes

### Requirement: Model discovery

The system SHALL list a provider's available models on request by calling the provider's `GET /models` from the server with the stored key, returning for each model its ID, name, tool support, audio input and output, context length, kind and list price. Discovery SHALL make no inference request. A malformed provider answer SHALL fail with 502 `integration_response_invalid`, and a provider edited since the request with 409 `catalog_conflict`.

#### Scenario: Provider returns an unexpected body

- **WHEN** the provider's `/models` answer does not match the expected shape
- **THEN** discovery fails with `integration_response_invalid` and the catalog is unchanged

### Requirement: Declared tool support

Discovery SHALL report tool support as `true` only when the model's `supported_parameters` include `tools`, `false` when an explicit list lacks it, and `null` (unknown) when the provider publishes no list. Choose from catalog SHALL import only models that declare tool calling, audio input or output, or a `decision`, `transcription` or `speech` kind; a model with unknown tool support SHALL instead offer **Verify support**, which opens manual entry with tool calling unchecked.

#### Scenario: Unknown tool support

- **WHEN** a provider lists a model without `supported_parameters`
- **THEN** it cannot be selected for import and offers Verify support

### Requirement: OpenRouter catalog additions

For the canonical OpenRouter base URL `https://openrouter.ai/api/v1`, discovery SHALL also read the transcription and speech catalogs (`?output_modalities=transcription`, `?output_modalities=speech`) and SHALL add the decision model `typesafe/jev-1.13` ("TypeSafe: Jev 1.13"), which the provider's model list does not contain.

#### Scenario: Jev offered

- **WHEN** an administrator opens Choose from catalog for an OpenRouter provider
- **THEN** TypeSafe: Jev 1.13 is listed as a decision model

### Requirement: Model kinds

Every catalog model SHALL have a kind: `chat` (default), `router`, `decision`, `transcription` or `speech`. Discovery SHALL classify a model as `router` when its tokenizer is `Router`, as `transcription` or `speech` from its output modalities, and otherwise as `chat`. `decision` and `transcription` models SHALL have no tools and no audio flags, `speech` models only audio output, and routers no audio flags.

#### Scenario: Transcription model kind

- **WHEN** discovery reads a model whose output modalities include `transcription`
- **THEN** it is imported with kind `transcription`, no tool calling and no audio flags

### Requirement: Jev identities on OpenRouter

On the canonical OpenRouter provider, `typesafe/jev-router` SHALL always read as a `router` and `typesafe/jev-1.13` and `~typesafe/jev-latest` as `decision`, whatever kind was stored, keeping their IDs and revisions.

#### Scenario: Jev 1.13 entered manually as chat

- **WHEN** an administrator enters `typesafe/jev-1.13` manually as a chat model on OpenRouter
- **THEN** the catalog stores and shows it as a decision model

### Requirement: Model import

The system SHALL import 1–50 unique models per request from a provider's catalog, SHALL skip models already added for that provider, SHALL add the rest enabled, and SHALL refuse the whole batch with 409 `identity_limit` when the organization would exceed 500 models. A changed provider revision SHALL fail with 409 `catalog_conflict`.

#### Scenario: Import with duplicates

- **WHEN** an administrator imports five models of which two are already in the catalog
- **THEN** three models are added and the two existing ones keep their names, enabled state and capabilities

#### Scenario: Catalog full

- **WHEN** the organization has 499 models and an import adds three new ones
- **THEN** the server answers 409 `identity_limit` and adds none

### Requirement: Manual model entry

The system SHALL let an administrator add or edit a model by its provider model ID, name, kind, enabled state and declared capabilities (tool calling, audio input, audio output); a second model with the same ID for the same provider SHALL be refused with 409 `catalog_model_exists`. The server SHALL not infer capabilities from a model's name.

#### Scenario: Duplicate model ID

- **WHEN** an administrator adds `openai/gpt-4o-mini` to a provider that already has it
- **THEN** the server answers 409 `catalog_model_exists`

### Requirement: Model removal

The system SHALL refuse to remove a model that any workspace of the organization uses as its chat model, a service override, the speech recognition model, the meeting transcription model, the spoken-reply model or the decision model, with 409 `catalog_model_in_use`.

#### Scenario: Remove the decision model

- **WHEN** an administrator removes the model another workspace of the organization uses as its decision model
- **THEN** the server answers 409 `catalog_model_in_use`

### Requirement: Workspace model choice

The system SHALL keep one model choice ("routing") per workspace with a revision, and SHALL apply a saved choice to new requests without a restart. A save with a stale revision SHALL fail with 409 `catalog_conflict`. Provider and model changes SHALL be audited as `catalog.ai_changed` and model choice changes as `catalog.routing_changed`.

#### Scenario: Two administrators edit the model choice

- **WHEN** two administrators save the model choice of a workspace from the same revision
- **THEN** the first save succeeds and the second fails with `catalog_conflict` without overwriting it

### Requirement: Chat and service models

The workspace default model SHALL serve chat turns and service actions, and an optional per-service model SHALL override it for that service's actions. Both SHALL be enabled `chat` or `router` models with tool calling on an enabled provider; a service MAY appear at most once in the overrides. Removing a service SHALL drop only its override. Turn behavior is specified in `agent-runtime`.

#### Scenario: Service override

- **WHEN** the workspace default is model A and the CRM service has override B
- **THEN** CRM actions use B and every other request uses A

#### Scenario: Model without tool calling

- **WHEN** an administrator chooses a model without tool support as the workspace default
- **THEN** the save fails with 409 `catalog_model_unavailable`

### Requirement: Speech recognition choice

The workspace SHALL choose speech recognition as off, the existing server profile (offered only when the server has one) or a catalog model in a mode: **AI interpreter** with an enabled `chat` model that has audio input, or **Direct transcription** with a `transcription` model. A catalog choice without a model SHALL fail with 409 `catalog_model_required`, a model unfit for the mode with 409 `catalog_model_unavailable`. There SHALL be no fallback between modes or models (behavior in `voice`).

#### Scenario: Direct transcription with a chat model

- **WHEN** an administrator selects Direct transcription with a chat model
- **THEN** the save fails with `catalog_model_unavailable`

#### Scenario: Speech recognition off

- **WHEN** an administrator chooses Off
- **THEN** voice input is unavailable in that workspace, including any legacy server profile

### Requirement: Meeting transcription choice

The workspace MAY choose a separate `transcription` model for meetings. Without one, meetings SHALL use the speech recognition model when it is a transcription model, and otherwise recognize the recording minute by minute through speech recognition (see `meetings`).

#### Scenario: Meeting model set

- **WHEN** a workspace chooses `openai/gpt-4o-transcribe` for meetings
- **THEN** meeting recordings are transcribed with that model regardless of the voice-input choice

### Requirement: Spoken reply choice

The workspace SHALL allow an optional spoken-reply model: method **Reader** with a `chat` model that has audio output, or method **Text-to-speech** with a `speech` model, plus a voice ID (letters, digits and `._:/-`, default `alloy`) and a zero-data-retention requirement that defaults to on. Without a model spoken replies SHALL be off, which is the default. Reply behavior is specified in `voice`.

#### Scenario: Reader without audio output

- **WHEN** an administrator chooses Reader with a chat model lacking audio output
- **THEN** the save fails with `catalog_model_unavailable`

### Requirement: Decision model choice

The workspace MAY turn on the decision model ("Service picker") with a `decision` model and a required certainty between 0.5 and 1 (default 0.8). Turning it on SHALL require both a decision model and a workspace default model, else 409 `catalog_model_required`. The decision model SHALL never approve an action or grant access; its use in a turn is specified in `agent-runtime`.

#### Scenario: Decision model without a chat model

- **WHEN** an administrator enables the Service picker with Jev but no workspace default model
- **THEN** the save fails with `catalog_model_required`

### Requirement: OpenRouter-only functions

Speech recognition, meeting transcription, spoken replies, the decision model and web search models SHALL be usable only on a provider whose base URL is the canonical `https://openrouter.ai/api/v1`; chat and service models MAY use any OpenAI-compatible provider.

#### Scenario: Transcription model on another provider

- **WHEN** an administrator chooses a transcription model of a provider at `https://api.example.com/v1`
- **THEN** the save fails with `catalog_model_unavailable`

### Requirement: Availability at use

The system SHALL check at each use that the chosen model and its provider are enabled and fit the function, and SHALL fail with `catalog_model_unavailable` instead of falling back to another model when they are not.

#### Scenario: Assigned model disabled

- **WHEN** an administrator disables the workspace default model
- **THEN** new chat turns in that workspace report that the model is unavailable and no other model is used

### Requirement: Provider and model pages

The administration SHALL show providers as cards at `/admin/providers`, each provider's models and bulk controls at `/admin/providers/:providerId`, and the model choice at `/admin/routing`. **Choose from catalog** SHALL offer search by name or ID, a tool-calling filter and selection of up to 50 models, marking models already added. Viewing these pages SHALL make no model request.

#### Scenario: Selection cap

- **WHEN** an administrator has selected 50 models in Choose from catalog
- **THEN** further models cannot be selected until one is deselected

### Requirement: Model choice page

The model choice page SHALL offer for each function only enabled models that fit it, grouped by provider, and SHALL keep an assigned model that became unavailable visible as unavailable until it is replaced or cleared. **Workspace default** on a service SHALL remove its override and show the inherited model.

#### Scenario: Disabled assignment

- **WHEN** the model assigned to a service was disabled
- **THEN** the model choice page shows it as an unavailable model for that service
