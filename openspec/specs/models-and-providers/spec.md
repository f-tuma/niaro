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

### Requirement: Model kinds

Every catalog model SHALL have a kind: `chat` (default), `router`, `decision`, `transcription` or `speech`. Discovery SHALL classify a model as `router` when its tokenizer is `Router`, as `transcription` or `speech` from its output modalities, and otherwise as `chat`. `decision` and `transcription` models SHALL have no tools and no audio flags, `speech` models only audio output, and routers no audio flags.

#### Scenario: Transcription model kind

- **WHEN** discovery reads a model whose output modalities include `transcription`
- **THEN** it is imported with kind `transcription`, no tool calling and no audio flags

### Requirement: Model import

The system SHALL import 1–50 unique models per request from a provider's catalog, SHALL skip models already added for that provider, SHALL add the rest enabled, and SHALL refuse the whole batch with 409 `identity_limit` when the organization would exceed 500 models. A changed provider revision SHALL fail with 409 `catalog_conflict`.

#### Scenario: Import with duplicates

- **WHEN** an administrator imports five models of which two are already in the catalog
- **THEN** three models are added and the two existing ones keep their names, enabled state and capabilities

#### Scenario: Catalog full

- **WHEN** the organization has 499 models and an import adds three new ones
- **THEN** the server answers 409 `identity_limit` and adds none

### Requirement: Manual model entry

The system SHALL let an administrator add or edit a model by its provider model ID, name, kind, enabled state, declared capabilities (tool calling, audio input, audio output) and, for speaking models, up to 20 reviewed voices with labels; a second model with the same ID for the same provider SHALL be refused with 409 `catalog_model_exists`. The server SHALL not infer capabilities or kind from a model's name or ID.

#### Scenario: Duplicate model ID

- **WHEN** an administrator adds `openai/gpt-4o-mini` to a provider that already has it
- **THEN** the server answers 409 `catalog_model_exists`

#### Scenario: Decision model by kind

- **WHEN** an administrator enters a model with kind decision
- **THEN** it is stored as a decision model whatever its ID

### Requirement: Model removal

The system SHALL refuse to remove a model that any role, service route, tier or escalation of the organization's default or of any workspace names, with 409 `catalog_model_in_use`.

#### Scenario: Remove the decision model

- **WHEN** an administrator removes the model another workspace of the organization uses as its selector
- **THEN** the server answers 409 `catalog_model_in_use`

#### Scenario: Model in a tier

- **WHEN** an administrator removes a model that only the tier Strong lists
- **THEN** the server answers 409 `catalog_model_in_use`

### Requirement: Chat and service models

The chat role SHALL serve chat turns and service actions, and a workspace's route for a service SHALL override it for that service's actions. A service MAY appear at most once in the overrides; removing a service SHALL drop only its route. Turn behavior is specified in `agent-runtime`.

#### Scenario: Service override

- **WHEN** chat is model A and the CRM service has route B
- **THEN** CRM actions use B and every other request uses A

#### Scenario: Model without tool calling

- **WHEN** an administrator puts a model without tool support in the chat role
- **THEN** the save fails with 409 `catalog_model_unavailable`

### Requirement: Speech recognition choice

Voice input SHALL use the voice input role: a chat model with audio input interprets, a transcription model transcribes; the method follows the model's kind. Without models, the server's own profile SHALL serve when it exists and the server-voice setting is on, else voice input is off. There SHALL be no fallback between methods (behavior in `voice`).

#### Scenario: Direct transcription with a chat model

- **WHEN** an administrator puts a chat model without audio input in the voice input role
- **THEN** the save fails with `catalog_model_unavailable`; a transcription model there transcribes directly

#### Scenario: Speech recognition off

- **WHEN** the role has no models and server voice is off
- **THEN** voice input is unavailable in that workspace, including any server profile

### Requirement: Meeting transcription choice

Meetings SHALL use the meeting transcription role. Without one, meetings SHALL use the voice input model when it is a transcription model, and otherwise recognize the recording minute by minute through voice input (see `meetings`).

#### Scenario: Meeting model set

- **WHEN** a workspace's meeting transcription role has a transcription model
- **THEN** meeting recordings are transcribed with it regardless of voice input

### Requirement: Spoken reply choice

Spoken replies SHALL use the speech role: a chat model with audio output reads, a speech model speaks. A voice setting SHALL name the voice, or follow the model's first reviewed voice; a model without either SHALL be refused with 409 `catalog_voice_required`. Zero data retention SHALL default to on. Without models spoken replies SHALL be off. Reply behavior is in `voice`.

#### Scenario: Reader without audio output

- **WHEN** an administrator puts a chat model lacking audio output in the speech role
- **THEN** the save fails with `catalog_model_unavailable`

#### Scenario: Reader without a voice

- **WHEN** an administrator puts a reader model without reviewed voices in the speech role and leaves the voice empty
- **THEN** the save fails with `catalog_voice_required`

### Requirement: OpenRouter-only functions

Voice input, meeting transcription, spoken replies, decision models and web search models SHALL be usable only on a provider whose base URL is the canonical `https://openrouter.ai/api/v1`; chat, service, background, designer, checker and selector chat models MAY use any OpenAI-compatible provider.

#### Scenario: Transcription model on another provider

- **WHEN** an administrator puts a transcription model of a provider at `https://api.example.com/v1` in the meeting role
- **THEN** the save fails with `catalog_model_unavailable`

### Requirement: Availability at use

The system SHALL check at each use that the chosen model and its provider are enabled and fit the role. Without fallback, an unavailable model SHALL fail with `catalog_model_unavailable` and no other model SHALL be used; with fallback, only as `Role fallback` allows.

#### Scenario: Assigned model disabled

- **WHEN** an administrator disables the chat model of a workspace without fallback
- **THEN** new chat turns report that the model is unavailable and no other model is used

### Requirement: Provider and model pages

The administration SHALL show providers as cards at `/admin/providers`, each provider's models and bulk controls at `/admin/providers/:providerId`, and the model policy at `/admin/routing`. **Choose from catalog** SHALL offer search by name or ID, a tool-calling filter and selection of up to 50 models, marking models already added. Viewing these pages SHALL make no model request.

#### Scenario: Selection cap

- **WHEN** an administrator has selected 50 models in Choose from catalog
- **THEN** further models cannot be selected until one is deselected

### Requirement: Model roles

The model policy SHALL map each role to an ordered list of up to 8 catalog models, the first being the primary, or to a tier: `chat`, per-service `service:<id>`, `checker`, `selector`, `background`, `designer`, `web_search`, `voice_input`, `meeting_transcription`, `speech`, and reserved `embedding` and `vision` that nothing uses yet. An empty list SHALL turn a role off. A role nobody set SHALL follow another: background, designer and web search follow chat, the checker the selector.

#### Scenario: Background follows chat

- **WHEN** only the chat role has models
- **THEN** widget fills use the chat model and the policy shows background work as inherited from chat

#### Scenario: Role turned off

- **WHEN** a workspace sets the selector to an empty list
- **THEN** service search lists candidates without a selector

### Requirement: Model tiers

The organization MAY define up to 8 tiers, each with an ID, an editable name and 1–8 models. A role, service or escalation that points to a tier SHALL use its current models. Saving the organization policy SHALL fail with 409 `catalog_tier_not_found` while any route of the organization or a workspace points to a missing tier.

#### Scenario: Strong tier edited

- **WHEN** chat points to the tier Strong and an administrator replaces Strong's model
- **THEN** the next chat turn uses the new model

### Requirement: Organization default and workspace overrides

The organization SHALL have one default policy and each workspace one set of overrides, each with its own revision. A workspace SHALL inherit every role, service route and setting it does not set; a new workspace SHALL work with the default. A stale revision SHALL fail with 409 `catalog_conflict`. Saves SHALL apply to new requests at once and be audited as `catalog.routing_changed` with the scope.

#### Scenario: New workspace

- **WHEN** an owner creates a workspace in an organization whose default chat role has model A
- **THEN** chat in the new workspace uses model A without any workspace setting

#### Scenario: Two administrators edit the default

- **WHEN** two administrators save the organization default from the same revision
- **THEN** the first save succeeds and the second fails with `catalog_conflict`

### Requirement: Role fit

A saved route SHALL name only enabled models on enabled providers that fit its role, else 409 `catalog_model_unavailable`: tool-capable chat or router models for chat, services, background, designer and escalation; those or a decision model for the checker and selector; chat or router models for web search; audio-input chat or transcription models for voice input; transcription models for meetings; audio-output chat or speech models for spoken replies.

#### Scenario: Transcription model as chat

- **WHEN** an administrator puts a transcription model in the chat role
- **THEN** the save fails with `catalog_model_unavailable`

### Requirement: Role fallback

Each route SHALL have a fallback flag, off by default. With it on, selection SHALL skip models that are disabled, unfit, removed, on a disabled provider or at the provider's daily limit, and a call SHALL move to the next model only when it provably never reached its provider: the daily limit refused it before dispatch, or the connection failed before the request was sent. Each attempt SHALL be its own budgeted call.

#### Scenario: Provider limit reached

- **WHEN** chat has models A and B with fallback on and A's provider is at its daily limit
- **THEN** the turn uses B and its run step says `fallback: provider_limit`

#### Scenario: Timeout after dispatch

- **WHEN** the call to A times out after it was sent
- **THEN** the call is not repeated on B and its usage stays unknown

### Requirement: Background work

Widget fills, opens and prefetches, memory and profile extraction, meeting record extraction and naming imported actions SHALL use the background role, and at dispatch SHALL check that the selected model still serves it unchanged.

#### Scenario: Cheap background model

- **WHEN** the background role has a small model and chat a large one
- **THEN** widget fills and meeting records use the small model and chat the large one

### Requirement: Stored routing migration

On start, routing stored in the old single-choice shape SHALL become a workspace policy that sets each role it decided; an organization without a default SHALL get one from its first migrated workspace, and each workspace SHALL keep only what differs. A web plugin search model naming a catalog model SHALL become that workspace's web search role. The migration SHALL run once.

#### Scenario: Two workspaces

- **WHEN** workspace W1 used model A and W2 model B before the upgrade
- **THEN** the default chat role is A, W1 has no override and W2 overrides chat with B

### Requirement: Models page

`/admin/routing` SHALL be the **Models** page with tabs for the organization default and this workspace: role rows with ordered model chips to add, reorder and remove, the source when inherited, a fallback switch per role, service routes, tiers, escalation and settings. Unavailable models and, in enforce mode, unpriced ones SHALL be marked. Viewing SHALL make no model request.

#### Scenario: Inherited role

- **WHEN** an administrator opens the workspace tab where background work is not set
- **THEN** the row says it is the same as chat and offers Override

### Requirement: OpenRouter audio catalogs

For the canonical OpenRouter base URL `https://openrouter.ai/api/v1`, discovery SHALL also read the transcription and speech catalogs (`?output_modalities=transcription`, `?output_modalities=speech`). Discovery SHALL add no model the provider does not list; a decision model is entered manually.

#### Scenario: No built-in decision model

- **WHEN** an administrator opens Choose from catalog for an OpenRouter provider
- **THEN** only models the provider lists are offered
