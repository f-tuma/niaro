# Design

## D1 Provider shape

`ProviderSettings` (`packages/protocol/service-catalog.ts`) gains optional `preset`, `auth` (`none | bearer | header{header}`), `dialect` (`openai | openrouter`), `free` and `dataHandling` (≤500). They are optional in the schema so stored rows, old bundles and API clients still parse; the server always stores a dialect. `packages/protocol/providers.ts` holds the dialect and auth schemas, `PROVIDER_PRESETS` (address, auth, dialect, free, local; no model), `FREE_MODEL_LIMITS` and the search backend kinds and presets. Preset notes are admin copy (`apps/server-admin/web/provider-copy.ts`, en/cs), because they are display text the administrator edits.

`ServiceCatalogStore.providerSettings` fills a missing dialect on save: the stored one, else the preset's, else OpenRouter's for the canonical OpenRouter address and `openai` otherwise. This keeps API clients and older bundles working; the console always sends one. `free` is never filled. `migrateProviders()` writes a dialect (and the `openrouter` preset) into stored rows once, without bumping the revision, so prices pinned to the provider revision stay current.

Alternative rejected: deriving the dialect from the address at every use. It hid the choice from the administrator and failed for proxies.

## D2 Requests

`apps/server-integrations/provider-request.ts` builds headers (`providerHeaders`: bearer, named header, nothing for `none` or an empty key), endpoints and `isOpenRouterDialect`. Every provider call uses it: chat (`mastra-model.ts`, `models.ts complete`), discovery, transcription, speech, decisions and the provider's web search. OpenRouter's `provider: {data_collection, zdr, require_parameters}` is sent only in the OpenRouter dialect; other servers reject unknown fields.

`saveProvider` with `auth: none` stores no key (`save(…, null)` clears it); `processProviderAvailable` and `speechVoiceRoute` treat a keyless provider as connected.

## D3 Discovery

`listModels` reads `GET /models` (plus OpenRouter's two audio catalogs only in that dialect). The item schema tolerates missing fields: `name` or Anthropic's `display_name`, vLLM's `max_model_len` as context length, image input from `input_modalities`. Without `supported_parameters` tool support stays `null`. A free provider reports a zero list price. In Choose from catalog such unknown chat models are importable (without tool calling) and marked "Unknown, test after adding"; the old "Verify support" detour is gone.

## D4 Capability test

`POST …/catalog/models/test {modelId, revision}` (`catalog-controller.ts`) loads the model enabled or not (`modelForTest`), refuses a stale revision or disabled provider, and runs `testModelCapabilities` (`apps/server-integrations/model-test.ts`). Probes by kind: chat → tools, image input, audio input, audio output; router → tools, image input; transcription → transcription; speech → speech; decision → none. Each probe is one small request:

- tools: one function and `tool_choice: auto`; supported when the reply calls it;
- image: a 16×16 red PNG; supported only when the answer says red (a server that drops images still answers);
- audio input: a half-second tone as `input_audio`; supported on a non-empty answer;
- audio output: streamed `modalities: [text, audio]` with the model's first reviewed voice; supported on any audio delta; skipped without a voice;
- transcription: the tone through `transcriptionRequest`; speech: `/audio/speech` with the first reviewed voice.

HTTP 400/404/405/415/422/501 mean unsupported; 401/403, 429, 5xx and transport errors mean "could not test" with a code. Chat probes go through `budgetedInferenceTransport` under one admin root run `catalog-test/…` (caps: 4 calls, 200k tokens), so enforce mode refuses an unpriced model before dispatch; audio endpoint probes are not ledgered, like voice. Every probe re-checks the administrator and the model revision and counts against the provider's daily limit (`useProvider`). The response changes nothing; the model editor's "Use these results" sets only answered capabilities (never failed or skipped ones) and saving stays with the form. `imageInput` is a new optional declared capability (`normalizeModelCapabilities` drops it for non-chat kinds).

## D5 Free providers

`InferenceBudgetStore.policy()` returns the stored settings plus a zero price for each chat, router or decision model of a free provider without an explicit price, pinned to the current revisions with `FREE_MODEL_LIMITS` (128k input, 16,384 output). `storedPolicy()` is the saved form; `savePolicy` and the controller strip prices equal to the implied ones before validation, so the Usage limits page can round-trip them and the bundle exports only saved prices. `open()` pins the applied prices in the run while the policy digest stays over the saved settings, so editing a catalog model does not stop other running work. Every reader (readiness checks, `unpricedRouteModels`, the Models and Usage limits pages) sees free models as priced without code of its own.

Alternative rejected: an implicit price at reservation time only. Every readiness check and both pages would have needed their own exception.

## D6 Audio

`transcriptionRequest` sends OpenRouter JSON (`input_audio`) or a multipart upload (`file`, `model`, fields; arrays as `name[]`) through the new transport `bodyEncoding: "multipart"` (`encodeMultipart`, checked names, random boundary). Voice input, meeting chunks (verbose JSON, segment timestamps, prompt; the flag-free retry exists only in the OpenRouter dialect), chat interpretation and spoken replies work on any provider; `model()` no longer refuses audio capabilities off OpenRouter. Decision models and the provider's own web search still need the OpenRouter dialect. Speech accepts `audio/mp3` as well as `audio/mpeg`.

## D7 Search backends

Search backends are catalog rows of kind `search` in the organization scope (≤10) with an encrypted key, listed for managers as `searchBackends` with `hasCredential`. `saveSearchBackend` checks the endpoint like a provider and may be saved without a key; `removeSearchBackend` refuses one a policy names (`catalog_search_in_use`). Policy option `webSearch.backendId` (organization default, workspace override) names it; saves refuse an unknown backend (`catalog_search_unavailable`). `budgetedReach` skips the web search role while a backend is chosen.

At use (`mastra-domain.ts`), `resolveSearchBackend` returns the backend and key or throws `catalog_search_unavailable` (disabled, removed, or Brave/Tavily without a key → `web_search_unavailable` for the model). `searchBackend` (`web-access.ts`) calls SearXNG `GET /search?format=json&time_range`, Brave `GET /web/search` with `X-Subscription-Token` and `freshness`, or Tavily `POST /search` with a bearer key and `time_range`, then shares result cleaning with the OpenRouter path (`collectResults`: http(s), no fragment, dedup, clipped, dated window). It is not a model call: no ledger entry, the per-run search limit still applies, the operator log records the backend kind and counts only. Without a backend the OpenRouter web plugin path stays, now by dialect.

## D8 Configuration bundle

`providers` items carry the new fields; `keyRequired` is a boolean that is false only for `auth: none`. Applying keeps fields an older bundle lacks. A new `searchBackends` section (before `modelPolicy`) carries name, kind, address and state, `keyRequired` for Brave, Tavily and a SearXNG with a stored key; the import adds missing backends and lists those needing a key. The model policy and routing sections name the backend (`webSearch.backend`, null for the provider's own search).

## D9 Console

Providers page: `ProviderForm` (`provider-form.tsx`) with preset, key handling, header name, request format, data-handling note and free switch; cards and the provider header show the note and a Free badge. Model editor: image input switch and `ModelCapabilityTest`. Providers page also shows `SearchBackendsSection` (`search-backends.tsx`). Models page: a Web search setting choosing a backend or the provider's own search; `modelFits` takes the provider and no longer limits audio roles to OpenRouter. Free models count as priced on the Models page.

## Verification

`tests/local-providers.node.ts`: presets, dialect save and migration, discovery from a plain list against a local fake server (no key, header key, zero price), the capability test per kind and through the controller (budgeted, counted, zero cost in enforce mode, stale revision), the free zero price (policy, stored, reservation, unmarking), audio over standard endpoints (multipart upload, interpretation without flags, meeting fields, speech), the three search backends, search backend keys, removal and bundle, provider bundle fields. `tests/admin-local-providers.test.tsx`: preset form, Azure header and key placeholder, capability test results and apply, search backend form. Updated: `service-catalog`, `config-bundle`, `model-policy-page` and literal providers in audio and web tests.
