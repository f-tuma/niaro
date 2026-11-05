# Spec Delta

## MODIFIED Requirements

### Requirement: Web settings

The system SHALL offer per-workspace settings: search engine `exa` (default), `native` or `auto`, results per search 1–8 (default 5), page text 1,000–40,000 characters (default 12,000) and zero data retention (default on). Searches SHALL use the web search role (see `models-and-providers`). The model MAY ask for fewer results or another `maxChars`, never more than the settings and limits allow. Server-wide values MAY be set under `plugins.settings.web`.

#### Scenario: Model asks for more results

- **WHEN** results per search is 5 and the model searches with `limit` 8
- **THEN** at most 5 results are returned

#### Scenario: Own search model

- **WHEN** the web search role has a cheaper OpenRouter model than chat
- **THEN** searches run on that model

### Requirement: Search through OpenRouter

The system SHALL run a search as one chat completion with OpenRouter's web plugin on the canonical OpenRouter provider with a chat or router model, else fail with `web_search_model_unavailable`. Results SHALL come only from the response's URL citations: http(s), deduplicated, title ≤ 200 and snippet ≤ 400 characters; the model's text SHALL never be returned. With `freshness`, results with a known date older than the window SHALL be dropped and undated ones kept.

#### Scenario: Non-OpenRouter chat model

- **WHEN** the web search role follows a chat model on another OpenAI-compatible provider
- **THEN** a search fails with `web_search_model_unavailable`
