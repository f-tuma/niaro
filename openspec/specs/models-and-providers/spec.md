# models-and-providers Specification

## Purpose

How organization owners and administrators connect AI providers, keep the organization's model catalog, and choose per workspace which model serves each function: chat and service actions, speech recognition, meeting transcription, spoken replies and the decision model.

## Requirements

### Requirement: Organization-owned providers

The system SHALL let an organization owner or administrator add, edit and remove AI providers of the organization, each an OpenAI-compatible endpoint with a name, API base URL, enabled state, daily request limit (1–100,000), preset, key handling, request format, free choice, data-handling note and an optional API key. An organization SHALL hold at most 50 providers. Members SHALL be refused every provider, model and routing command with 403 `identity_forbidden`.

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

The system SHALL store provider API keys encrypted in the identity store, SHALL never return them in any response (only `hasCredential`), SHALL keep the stored key when a provider is saved without a new key, and SHALL remove it when the provider is saved without key handling.

#### Scenario: Edit a provider without retyping the key

- **WHEN** an administrator changes a provider's daily limit and sends no key
- **THEN** the provider keeps its key and `hasCredential` stays true

#### Scenario: Key handling turned off

- **WHEN** an administrator switches a provider with a stored key to no key
- **THEN** the stored key is removed and `hasCredential` is false

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

The system SHALL list a provider's models on request with the provider's plain `GET /models` from the server with its stored key, returning each model's ID, name, tool support, audio input and output, image input, context length, kind and list price where the provider publishes them. Discovery SHALL make no inference request. A malformed answer SHALL fail with 502 `integration_response_invalid`, a provider edited since the request with 409 `catalog_conflict`.

#### Scenario: Provider returns an unexpected body

- **WHEN** the provider's `/models` answer does not match the expected shape
- **THEN** discovery fails with `integration_response_invalid` and the catalog is unchanged

#### Scenario: Plain model list

- **WHEN** a local server answers `/models` with only IDs
- **THEN** each model is listed by its ID with unknown tool support, kind chat and no context length

### Requirement: Declared tool support

Discovery SHALL report tool support as `true` only when the model's `supported_parameters` include `tools`, `false` when an explicit list lacks it, and `null` (unknown) when the provider publishes no list. Choose from catalog SHALL import models that declare tool calling, audio input or output, or a `decision`, `transcription` or `speech` kind, and chat models with unknown tool support without tool calling, marked to be tested after adding.

#### Scenario: Unknown tool support

- **WHEN** a provider lists a model without `supported_parameters`
- **THEN** it can be selected for import, is marked unknown and is added without tool calling

### Requirement: Model kinds

Every catalog model SHALL have a kind: `chat` (default), `router`, `decision`, `transcription` or `speech`. Discovery SHALL classify a model as `router` when its tokenizer is `Router`, as `transcription` or `speech` from its output modalities, and otherwise as `chat`. `decision` and `transcription` models SHALL have no tools, audio or image flags, `speech` models only audio output, and routers no audio flags.

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

The system SHALL let an administrator add or edit a model by its provider model ID, name, kind, enabled state, declared capabilities (tool calling, image input, audio input, audio output) and, for speaking models, up to 20 reviewed voices with labels; a second model with the same ID for the same provider SHALL be refused with 409 `catalog_model_exists`. The server SHALL not infer capabilities or kind from a model's name or ID.

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

### Requirement: Availability at use

The system SHALL check at each use that the chosen model and its provider are enabled and fit the role. Without fallback, an unavailable model SHALL fail with `catalog_model_unavailable` and no other model SHALL be used; with fallback, only as `Role fallback` allows.

#### Scenario: Assigned model disabled

- **WHEN** an administrator disables the chat model of a workspace without fallback
- **THEN** new chat turns report that the model is unavailable and no other model is used

### Requirement: Provider and model pages

The administration SHALL show providers as cards at `/admin/providers` with their note and a Free badge, search backends below them, each provider's models and bulk controls at `/admin/providers/:providerId`, a capability test in the model editor, and the model policy at `/admin/routing`. **Choose from catalog** SHALL offer search by name or ID, a tool-calling filter and selection of up to 50 models, marking models already added. Viewing these pages SHALL make no model request.

#### Scenario: Selection cap

- **WHEN** an administrator has selected 50 models in Choose from catalog
- **THEN** further models cannot be selected until one is deselected

### Requirement: Model roles

The model policy SHALL map each role to an ordered list of up to 8 catalog models, the first being the primary, or to a tier: `chat`, per-service `service:<id>`, `checker`, `selector`, `background`, `designer`, `web_search`, `voice_input`, `meeting_transcription`, `speech`, `embedding` (knowledge) and reserved `vision`. An empty list SHALL turn a role off. A role nobody set SHALL follow another: background, designer and web search follow chat, the checker the selector.

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

`/admin/routing` SHALL be the **Models** page with tabs for the organization default and this workspace: role rows with ordered model chips to add, reorder and remove, the source when inherited, a fallback switch per role, service routes, tiers, escalation and settings, including the web search backend. Unavailable models and, in enforce mode, unpriced ones SHALL be marked. Viewing SHALL make no model request.

#### Scenario: Inherited role

- **WHEN** an administrator opens the workspace tab where background work is not set
- **THEN** the row says it is the same as chat and offers Override

### Requirement: OpenRouter audio catalogs

For a provider in the OpenRouter format, discovery SHALL also read the transcription and speech catalogs (`?output_modalities=transcription`, `?output_modalities=speech`). Discovery SHALL add no model the provider does not list; a decision model is entered manually.

#### Scenario: No built-in decision model

- **WHEN** an administrator opens Choose from catalog for an OpenRouter provider
- **THEN** only models the provider lists are offered

### Requirement: Provider presets

The provider form SHALL offer presets for OpenRouter, OpenAI, Anthropic, Gemini, Azure OpenAI, Ollama, LM Studio, vLLM, llama.cpp server, LocalAI and custom. A preset SHALL fill the address, key handling, request format, free choice and a data-handling note, and every field SHALL stay editable. Presets SHALL name no model, and nothing in routing SHALL read them.

#### Scenario: Ollama preset

- **WHEN** an administrator picks Ollama
- **THEN** the form fills `http://localhost:11434/v1`, no key, the OpenAI format, free and the note "Runs locally. Nothing leaves the server.", and says the address must be a trusted origin

#### Scenario: Preset then edit

- **WHEN** an administrator picks a preset and changes its address
- **THEN** the provider is saved with the typed address

### Requirement: Provider key handling

A provider SHALL send its key as a bearer token, in a named header (for example Azure's `api-key`) or not at all. A provider without a key SHALL store none, even if one is sent, and SHALL count as connected for availability.

#### Scenario: Azure header

- **WHEN** a provider uses header `api-key`
- **THEN** discovery and model calls send the key in `api-key` and no `Authorization` header

#### Scenario: Local server without a key

- **WHEN** an administrator saves a provider with no key handling
- **THEN** it has `hasCredential: false` and its models serve chat and voice

### Requirement: Provider request format

Each provider SHALL have a request format, `openai` or `openrouter`, chosen by the administrator. OpenRouter's routing privacy flags, JSON audio uploads, audio catalogs, web plugin and decisions API SHALL follow the format, not the address. Decision models and the provider's own web search SHALL need the OpenRouter format; other roles MAY use any provider.

#### Scenario: Decision model on a plain provider

- **WHEN** an administrator puts a decision model of an OpenAI-format provider in the selector role
- **THEN** the save fails with `catalog_model_unavailable`

#### Scenario: No flags for a plain provider

- **WHEN** a chat model with audio input on an OpenAI-format provider interprets a voice request
- **THEN** the request carries no `provider` routing field

### Requirement: Stored provider dialect

A save without a format SHALL keep the stored one, else take its preset's, else use OpenRouter's for OpenRouter's canonical address and `openai` otherwise. On start, providers stored before formats existed SHALL get one this way once, keeping their revision.

#### Scenario: Provider from before the change

- **WHEN** the server starts with a provider at `https://openrouter.ai/api/v1` saved without a format
- **THEN** it gets the OpenRouter format and its revision and prices stay unchanged

### Requirement: Free providers

An administrator MAY mark a provider free (a local server, a free plan); the system SHALL never infer it from the address. Discovery SHALL report a free provider's list prices as zero, and its models' usage SHALL be priced as specified in `inference-budget`.

#### Scenario: Free list price

- **WHEN** an administrator opens Choose from catalog for a free provider
- **THEN** every model shows a list price of zero

### Requirement: Capability test

An administrator SHALL be able to test a saved model (`POST …/catalog/models/test`): one small request per capability of its kind (tools, image input, audio input and output, transcription, speech), each counted against the provider's daily limit, chat probes under the inference budget. Results SHALL be supported, unsupported, failed with a code, or skipped. The test SHALL change nothing; its answers MAY fill the model form.

#### Scenario: Local model test

- **WHEN** an administrator tests a chat model whose server calls the tool, names the red test image and refuses audio
- **THEN** tools and image input are supported, audio input unsupported, audio output skipped without a voice

#### Scenario: Enforced limits without a price

- **WHEN** the workspace stops at limit and the tested chat model has no price
- **THEN** the test is refused with `catalog_budget_price_required` before any request

### Requirement: Audio through standard endpoints

Voice input, meeting transcription and spoken replies SHALL work with any provider: transcription models through `POST /audio/transcriptions` (multipart `file` in the OpenAI format, JSON `input_audio` in OpenRouter's), speech models through `POST /audio/speech`, and audio chat models through chat completions with audio input or output.

#### Scenario: Meeting on a local server

- **WHEN** the meeting transcription role has a transcription model of an OpenAI-format provider
- **THEN** each chunk is uploaded as multipart with `response_format` `verbose_json` and segment timestamps

### Requirement: Search backends

The organization MAY keep up to 10 web search backends (SearXNG, Brave or Tavily) with a name, address, state and a write-only key stored like a provider key. A backend SHALL be refused removal with 409 `catalog_search_in_use` while a policy names it; a policy naming an unknown backend SHALL fail with 409 `catalog_search_unavailable`.

#### Scenario: Backend in use

- **WHEN** an administrator removes the backend a workspace searches with
- **THEN** the server answers 409 `catalog_search_in_use`

#### Scenario: Key never returned

- **WHEN** an administrator saves a Brave backend with a key
- **THEN** the catalog shows `hasCredential: true` and no key

### Requirement: Data-handling note

Each provider MAY have a data-handling note of up to 500 characters written by the administrator, prefilled by a preset; the providers page SHALL show it on the provider's card and page.

#### Scenario: Local note

- **WHEN** a provider's note is "Runs locally. Nothing leaves the server."
- **THEN** its card and page show that note

### Requirement: Member model presets

The model policy SHALL have member presets: whether they are on (off by default) and up to four presets, each an id, an administrator's name and an organization tier. The organization sets a default and a workspace MAY override it. `GET /v1/:workspace/chat-presets` SHALL list the presets a member may pick by id and name only; none while off.

#### Scenario: Turned on for one workspace

- **WHEN** an administrator turns presets on with Fast and Thorough in workspace A only
- **THEN** members of A see Fast and Thorough and members of other workspaces see none

### Requirement: Presets stay within the policy

A preset SHALL reach only its tier's models, the second and later ones only with chat fallback on, and only while the workspace offers it. Saving SHALL refuse a preset whose tier is missing or does not fit chat, and a tier a preset uses SHALL not be removed.

#### Scenario: Unknown preset sent

- **WHEN** a message arrives with a preset the workspace does not offer
- **THEN** the request is answered with the chat role's model and no preset is recorded

#### Scenario: Tier in use

- **WHEN** an administrator removes the tier the Thorough preset uses
- **THEN** the save is refused with `catalog_tier_not_found`

### Requirement: Preset at use

A request sent with an offered preset SHALL answer with the preset's tier and record the preset with the run; a checker escalation SHALL still take precedence once, and unavailable preset models SHALL leave the step to the chat role. Each step SHALL be an ordinary budgeted chat call.

#### Scenario: Thorough request

- **WHEN** a member sends a message with Thorough, whose tier is Strong
- **THEN** the model steps run on Strong's first model and the run records the preset Thorough

### Requirement: Member presets on the Models page

The Models page SHALL have a Member presets section for the organization default and each workspace: an on switch, rows with the preset's name and tier, Add and Remove, and Use default on a workspace that overrides. It SHALL not save a preset without a name or tier, or presets turned on with none.

#### Scenario: No tiers

- **WHEN** the organization has no tiers
- **THEN** the section says to add a tier first and offers no Add

### Requirement: Embedding models

A catalog model MAY have the kind `embedding`, with no tools or audio. The `embedding` role SHALL take only embedding models, of any provider, called through the OpenAI-compatible `POST {provider}/embeddings` with the administrator's model name; other roles SHALL refuse them. No embedding model SHALL be chosen by code.

#### Scenario: Local embeddings

- **WHEN** an administrator adds `nomic-embed-text` of a local Ollama provider as an embedding model and sets it as the embedding role
- **THEN** knowledge embeds with it through that provider's `/v1/embeddings`

#### Scenario: Chat model as embeddings

- **WHEN** an administrator sets a chat model as the embedding role
- **THEN** the save fails with 409 `catalog_model_unavailable`
