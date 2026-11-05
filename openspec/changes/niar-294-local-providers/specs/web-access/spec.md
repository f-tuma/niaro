# Spec Delta

## ADDED Requirements

### Requirement: Search through a backend

When the model policy names a search backend (see `models-and-providers`), a search SHALL go to it instead of a model: SearXNG's JSON search, Brave's web search with its subscription token, or Tavily's search with its key, with `freshness` passed as their date filter. Results SHALL be cleaned as in Search through OpenRouter. A disabled or removed backend, or Brave or Tavily without a key, SHALL fail with `web_search_unavailable`.

#### Scenario: SearXNG on the local network

- **WHEN** a workspace searches with a SearXNG backend at a trusted origin
- **THEN** the query goes to its `/search` with `format=json` and the results come from its answer

#### Scenario: Backend without its key

- **WHEN** a Brave backend imported from a bundle has no key yet
- **THEN** a search fails with `web_search_unavailable` and no request is sent

## MODIFIED Requirements

### Requirement: Web settings

The system SHALL offer per-workspace settings: search engine `exa` (default), `native` or `auto`, results per search 1–8 (default 5), page text 1,000–40,000 characters (default 12,000) and zero data retention (default on). Searches SHALL use the policy's search backend when one is chosen, else the web search role (see `models-and-providers`). The model MAY ask for fewer results or another `maxChars`, never more than the settings allow. Server-wide values MAY be set under `plugins.settings.web`.

#### Scenario: Model asks for more results

- **WHEN** results per search is 5 and the model searches with `limit` 8
- **THEN** at most 5 results are returned

#### Scenario: Own search model

- **WHEN** the web search role has a cheaper OpenRouter model than chat
- **THEN** searches run on that model

### Requirement: Search through OpenRouter

Without a search backend, the system SHALL run a search as one chat completion with OpenRouter's web plugin on a provider in the OpenRouter format with a chat or router model, else fail with `web_search_model_unavailable`. Results SHALL come only from the response's URL citations: http(s), deduplicated, title ≤ 200 and snippet ≤ 400 characters; the model's text SHALL never be returned. With `freshness`, results with a known date older than the window SHALL be dropped and undated ones kept.

#### Scenario: Non-OpenRouter chat model

- **WHEN** the web search role follows a chat model on another OpenAI-compatible provider
- **THEN** a search fails with `web_search_model_unavailable`

### Requirement: Search costs

A search through a model SHALL be a model call of the run: paid with the provider key, counted against the provider's daily request limit and the `inference-budget`, reserved before the call with the search fee on top of tokens (Exa: $0.004 per requested result; native: $0.05 per call) and settled with the cost the provider reports. A search through a backend and a page read SHALL cost no model call.

#### Scenario: Enforced budget exhausted

- **WHEN** the enforced inference budget cannot reserve a search's tokens and fee
- **THEN** the search is not sent

### Requirement: Privacy

Model searches SHALL be sent with `provider.data_collection: "deny"` and, unless zero data retention is off, `provider.zdr: true`; a backend search and its key go to the backend alone. Page reads SHALL go directly to the site without cookies, sign-in or referrer, with the user agent `Mozilla/5.0 (compatible; Niaro/1.0; reads one page for a person)`. The operator log SHALL record counts, model or backend kind, host, status, sizes, timing and error code, never the query, path or content.

#### Scenario: Log without the query

- **WHEN** the agent searches for a person's medical question
- **THEN** the operator log entry contains the model and result count but not the query
