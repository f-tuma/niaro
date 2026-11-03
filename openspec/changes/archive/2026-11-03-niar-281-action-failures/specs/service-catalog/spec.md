# Spec Delta

## MODIFIED Requirements

### Requirement: Action failure diagnostics

The system SHALL record with each failed call a bounded diagnostic: code, kind (`validation`, `permission`, `connection`, `rate_limit`, `provider`, `response`, `cancelled`, `unknown`), stage, next step (`correct_input`, `reconnect`, `later`, `verify_first`, `none`), optional HTTP status and message (at most 600 characters) and up to eight field issues. It SHALL prefer a concrete provider `error`/`cause` over a generic wrapper and exclude credentials, headers, cookies, HTML, raw bodies and media.

A provider answer that rejects the request's shape SHALL be `validation` with next step `correct_input`, its sanitized message reaching the model: an HTTP 400, 409 or 422, a `400`/`422` status relayed in an MCP error's text, MCP `-32602` invalid params, and messages naming a wrong, missing or unknown field, value, operator or format. An HTTP 5xx (also when relayed in text) and timeouts SHALL stay `later`, and a relayed 429 SHALL be a rate limit. An MCP output validation error (the provider's tool broke its own output schema) SHALL be `integration_provider_output_invalid` with kind `response` and next step `none`.

#### Scenario: Credentials never in diagnostics

- **WHEN** a provider error body echoes the request's Authorization header
- **THEN** the stored diagnostic does not contain it

#### Scenario: Sort without direction

- **WHEN** Twenty answers `Scalar field "name" requires a direction value (AscNullsFirst, …)`
- **THEN** the failed read's next step is `correct_input` and the model receives that message

#### Scenario: Graph rejection relayed by MCP

- **WHEN** an MCP tool fails with `Microsoft Graph API error: 400 Bad Request - …`
- **THEN** the next step is `correct_input` with Graph's message

#### Scenario: Provider outage relayed by MCP

- **WHEN** an MCP tool fails with `… 503 Service Unavailable …`
- **THEN** the next step is `later`

#### Scenario: Provider output schema violation

- **WHEN** an MCP tool answers `MCP error -32602: Output validation error: Invalid structured content …`
- **THEN** the code is `integration_provider_output_invalid`, kind `response`, next step `none`
