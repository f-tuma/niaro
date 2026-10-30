## MODIFIED Requirements

### Requirement: Model discovery

The system SHALL list a provider's available models on request by calling the provider's `GET /models` from the server with the stored key, returning for each model its ID, name, tool support, image input, audio input and output, context length, kind and list price. Discovery SHALL make no inference request. A malformed provider answer SHALL fail with 502 `integration_response_invalid`, and a provider edited since the request with 409 `catalog_conflict`.

#### Scenario: Provider returns an unexpected body

- **WHEN** the provider's `/models` answer does not match the expected shape
- **THEN** discovery fails with `integration_response_invalid` and the catalog is unchanged

### Requirement: Manual model entry

The system SHALL let an administrator add or edit a model by its provider model ID, name, kind, enabled state and declared capabilities (tool calling, image input, audio input, audio output); a second model with the same ID for the same provider SHALL be refused with 409 `catalog_model_exists`. The server SHALL not infer capabilities from a model's name.

#### Scenario: Duplicate model ID

- **WHEN** an administrator adds `openai/gpt-4o-mini` to a provider that already has it
- **THEN** the server answers 409 `catalog_model_exists`

## ADDED Requirements

### Requirement: Explicit image input support

Discovery SHALL report image input as true only from explicit provider capability metadata, false when an explicit modality list excludes images, and unknown otherwise. Stored models SHALL default to image input disabled unless explicitly verified/configured by an administrator. Capability SHALL NOT be inferred from a model name.

#### Scenario: Provider omits modalities
- **WHEN** a provider lists a model without input modality information
- **THEN** image support is unknown and importing it does not silently enable image input

### Requirement: Image-aware dispatch

Before dispatch, the server SHALL verify that the selected model/provider support the required image input. It SHALL not silently switch providers or discard images. A text-only extraction path SHALL identify its limitations when the request needs visual evidence. Existing model authority, privacy policy and inference-budget admission SHALL apply.

#### Scenario: Text-only chat model
- **WHEN** a request requires interpreting an image but the configured model cannot accept images
- **THEN** the request reports the unavailable capability without an image request to another model
