# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: OpenRouter catalog additions

**Reason**: Discovery no longer adds a built-in decision model; replaced by `OpenRouter audio catalogs`.
**Migration**: An administrator enters a decision model manually with kind decision.

### Requirement: Jev identities on OpenRouter

**Reason**: Kinds come from discovery or the administrator; no model is recognized by its ID.
**Migration**: Stored models keep their kind; an administrator sets kind decision on a decision model.

### Requirement: Workspace model choice

**Reason**: Replaced by `Organization default and workspace overrides`.
**Migration**: Stored routing migrates as `Stored routing migration` says.

### Requirement: Decision model choice

**Reason**: Replaced by the selector and checker roles (`Model roles`, `Role fit`) and the selector certainty setting.
**Migration**: An enabled decision model becomes the selector; the checker follows it.

### Requirement: Model choice page

**Reason**: Replaced by `Models page`.
**Migration**: The same address shows the Models page.
