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
