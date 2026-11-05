# Spec Delta

## ADDED Requirements

### Requirement: Variables in skills

A personal or company skill's instructions SHALL have the prompt variables (see `agent-runtime`) filled in for the person when the skill is loaded into a turn, by `skill_load` or an @mention. The stored skill and its editor SHALL keep the text as typed.

#### Scenario: Signature in a company skill

- **WHEN** a company skill says "sign as {person.name}, {company.name}" and a member loads it
- **THEN** the model reads that member's name and the organization's name

### Requirement: Slash picker

Typing `/` at the very start of the composer on the web and the phone SHALL open a picker of the mention directory's skills and processes only, labelled "Skills and processes" and operable by keyboard (arrows, Enter or Tab to pick, Esc to close) on the web. A pick SHALL become the same `@Name` tag as `@`, with the same re-check and effect. A `/` elsewhere in the text SHALL be plain text.

#### Scenario: Run a skill with slash

- **WHEN** the person types `/nab`, picks the skill "Nabídky" and sends "@Nabídky pro Acme"
- **THEN** the message carries a skill mention of "Nabídky" and the skill is loaded as know-how

#### Scenario: Services stay with @

- **WHEN** the person types `/` at the start of the composer
- **THEN** the picker lists skills and processes but no services
