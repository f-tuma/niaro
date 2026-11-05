# Spec Delta

## MODIFIED Requirements

### Requirement: Assembling data

A second closed step with no tools SHALL turn the reads into the widget type's data under enforced structured output, with the reads again framed as untrusted. The result SHALL be validated against the type's schema again before it is stored. Fills SHALL use the workspace's background model (see `models-and-providers`).

#### Scenario: Assembled data does not fit

- **WHEN** the assembly returns data that fails the type's schema
- **THEN** the fill fails with `hub_fill_invalid` and the last good data stays

#### Scenario: No chat model

- **WHEN** neither the background role nor chat has a model
- **THEN** the fill fails with `catalog_model_required`
