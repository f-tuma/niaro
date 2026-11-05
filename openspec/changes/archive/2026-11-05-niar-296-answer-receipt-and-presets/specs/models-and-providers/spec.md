## ADDED Requirements

### Requirement: Member model presets

The model policy SHALL have member presets: whether they are on (off by default) and up to four presets, each an id, an administrator's name and an organization tier. The organization sets a default and a workspace MAY override it. `GET /v1/:workspace/chat-presets` SHALL list the presets a member may pick by id and name only; none while off.

#### Scenario: Turned on for one workspace

- **WHEN** an administrator turns presets on with Fast and Thorough in workspace A only
- **THEN** members of A see Fast and Thorough and members of other workspaces see none

### Requirement: Presets stay within the policy

A preset SHALL reach only its tier's models, the second and later ones only with chat fallback on, and only while the workspace offers it. Saving SHALL refuse a preset whose tier is missing or does not fit chat, and a tier a preset uses SHALL not be removed.

#### Scenario: Unknown preset sent

- **WHEN** a message arrives with a preset the workspace does not offer
- **THEN** the request is answered with the chat role's model and no preset is recorded

#### Scenario: Tier in use

- **WHEN** an administrator removes the tier the Thorough preset uses
- **THEN** the save is refused with `catalog_tier_not_found`

### Requirement: Preset at use

A request sent with an offered preset SHALL answer with the preset's tier and record the preset with the run; a checker escalation SHALL still take precedence once, and unavailable preset models SHALL leave the step to the chat role. Each step SHALL be an ordinary budgeted chat call.

#### Scenario: Thorough request

- **WHEN** a member sends a message with Thorough, whose tier is Strong
- **THEN** the model steps run on Strong's first model and the run records the preset Thorough

### Requirement: Member presets on the Models page

The Models page SHALL have a Member presets section for the organization default and each workspace: an on switch, rows with the preset's name and tier, Add and Remove, and Use default on a workspace that overrides. It SHALL not save a preset without a name or tier, or presets turned on with none.

#### Scenario: No tiers

- **WHEN** the organization has no tiers
- **THEN** the section says to add a tier first and offers no Add
