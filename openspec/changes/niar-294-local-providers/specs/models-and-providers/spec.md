# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: Write-only provider keys

The system SHALL store provider API keys encrypted in the identity store, SHALL never return them in any response (only `hasCredential`), SHALL keep the stored key when a provider is saved without a new key, and SHALL remove it when the provider is saved without key handling.

#### Scenario: Edit a provider without retyping the key

- **WHEN** an administrator changes a provider's daily limit and sends no key
- **THEN** the provider keeps its key and `hasCredential` stays true

#### Scenario: Key handling turned off

- **WHEN** an administrator switches a provider with a stored key to no key
- **THEN** the stored key is removed and `hasCredential` is false

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

### Requirement: Manual model entry

The system SHALL let an administrator add or edit a model by its provider model ID, name, kind, enabled state, declared capabilities (tool calling, image input, audio input, audio output) and, for speaking models, up to 20 reviewed voices with labels; a second model with the same ID for the same provider SHALL be refused with 409 `catalog_model_exists`. The server SHALL not infer capabilities or kind from a model's name or ID.

#### Scenario: Duplicate model ID

- **WHEN** an administrator adds `openai/gpt-4o-mini` to a provider that already has it
- **THEN** the server answers 409 `catalog_model_exists`

#### Scenario: Decision model by kind

- **WHEN** an administrator enters a model with kind decision
- **THEN** it is stored as a decision model whatever its ID

### Requirement: Provider and model pages

The administration SHALL show providers as cards at `/admin/providers` with their note and a Free badge, search backends below them, each provider's models and bulk controls at `/admin/providers/:providerId`, a capability test in the model editor, and the model policy at `/admin/routing`. **Choose from catalog** SHALL offer search by name or ID, a tool-calling filter and selection of up to 50 models, marking models already added. Viewing these pages SHALL make no model request.

#### Scenario: Selection cap

- **WHEN** an administrator has selected 50 models in Choose from catalog
- **THEN** further models cannot be selected until one is deselected

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

## REMOVED Requirements

### Requirement: OpenRouter-only functions

**Reason**: Audio works through the standard endpoints of any provider; only decision models and the provider's own web search need OpenRouter, now by the administrator's request format instead of the canonical address.
**Migration**: Replaced by `Provider request format` and `Audio through standard endpoints`; stored providers get a format once (`Stored provider dialect`).
