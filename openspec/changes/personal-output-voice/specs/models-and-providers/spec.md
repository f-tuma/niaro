# Models and Providers Delta

## MODIFIED Requirements

### Requirement: Spoken reply choice

The workspace SHALL allow an optional spoken-reply model: method **Reader** with a `chat` model that has audio output, or method **Text-to-speech** with a `speech` model, plus a Server default voice ID (letters, digits and `._:/-`, default `alloy`) and a zero-data-retention requirement that defaults to on. Without a model spoken replies SHALL be off, which is the default. Reply behavior is specified in `voice`.

#### Scenario: Reader without audio output

- **WHEN** an administrator chooses Reader with a chat model lacking audio output
- **THEN** the save fails with `catalog_model_unavailable`

#### Scenario: Personal voice does not edit routing

- **WHEN** a member saves an advertised personal output voice
- **THEN** only that person's timbre preference changes and the workspace's model, method, privacy requirement and Server default remain unchanged

## ADDED Requirements

### Requirement: Exact output voice catalogue authority

The server SHALL advertise at most 32 personal output-voice alternatives from a reviewed catalogue bound to the exact canonical provider, upstream model, method, format and policy revision. Each option SHALL have a bounded text label and opaque actor-scoped ID. Neither a generic voice example list nor a different model/method's catalogue SHALL establish support. Unknown or unreviewed routes SHALL expose Server default only.

#### Scenario: Reader metadata absent

- **WHEN** the selected reader model has no published per-model voice list and no accepted exact-route server pin
- **THEN** the server exposes Server default only without claiming that alternatives are unsupported

#### Scenario: Reviewed reader pin available

- **WHEN** a reviewed server pin admits alternatives for the exact selected reader route
- **THEN** only that pin's labelled options are advertised, with its current policy revision bound to the catalogue

#### Scenario: Model identifier lacks an exact reviewed entry

- **WHEN** a model identifier is unknown or unreviewed, including an exact version identifier or a model-family wildcard match without its own reviewed entry
- **THEN** it exposes Server default only; a future exact versioned entry may advertise alternatives after its own exact-route review

#### Scenario: Unrelated TTS voice list

- **WHEN** a provider publishes voices for a dedicated text-to-speech model
- **THEN** those voices are not automatically advertised for a chat-audio reader model

### Requirement: Output catalogue isolation and revision

Output catalogue identity SHALL bind organization/workspace/user, provider and model identities/revisions, method, format, privacy policy and compatibility generation. The catalogue revision SHALL also bind current Server default and option mapping. The server SHALL rederive and validate this identity for each personal save and speech use; an opaque ID or revision alone SHALL NOT authorize access or provider routing.

#### Scenario: Another actor reuses an option

- **WHEN** a person submits another actor or workspace's option ID or catalogue token
- **THEN** the save is refused and no preference or routing changes

#### Scenario: Compatible explicit choice and default edit

- **WHEN** only the current Server default changes
- **THEN** stale settings tokens are rejected while still-compatible explicit personal choices remain effective

### Requirement: No personal routing privilege

Personal output-voice settings SHALL use only the currently authorized workspace speech route. They SHALL NOT accept client-selected provider/model identifiers, credentials, raw provider voice IDs, custom voice objects or endpoints. Server default SHALL resolve to the current configured server voice; an invalid personal choice SHALL NOT trigger another model/provider or a capability probe.

#### Scenario: Client requests another provider

- **WHEN** a settings update attempts to specify a provider, model, endpoint or raw voice ID
- **THEN** the server refuses it before any provider call

### Requirement: Output route compatibility lifecycle

Changing the speech provider/model/method, relevant provider/model revision, privacy policy, registry policy or enabled compatibility generation SHALL invalidate old personal catalogue bindings. A switch away and back SHALL NOT resurrect a prior choice. Default-only and unrelated chat-routing edits SHALL NOT invalidate a still-compatible explicit personal voice.

#### Scenario: Provider changed between settings reads

- **WHEN** an administrator switches provider A to B and back to A before the person next reads settings
- **THEN** the old saved catalogue binding is still invalid and effective voice follows current Server default

#### Scenario: Speech disabled and re-enabled

- **WHEN** the speech route is disabled and later re-enabled
- **THEN** an old personal binding does not silently become active again

### Requirement: Catalogue use is passive

Reading or saving personal output settings SHALL use already-reviewed server catalogue data and SHALL NOT make an inference, synthesis, preview or provider-discovery request. Any future catalogue import SHALL validate its exact model/method identity, bounded IDs, labels, provenance and revision on the server before it can be advertised; client-supplied lists SHALL never be trusted.

#### Scenario: Opening settings offline from the provider

- **WHEN** the identity server is reachable and the provider is not contacted during a settings read
- **THEN** the response is derived from current authorized routing and the reviewed server catalogue without an upstream request
