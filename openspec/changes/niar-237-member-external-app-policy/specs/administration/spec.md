## MODIFIED Requirements

### Requirement: Needs attention

The Overview SHALL show **Needs attention** only when something needs action, in this order: actions that failed today (linking to the Activity log filtered to failures), processes that need a retest (linking to Processes), member-added services and external AI app requests waiting for a decision, enabled services that require personal sign-in which nobody has completed, and AI requests at 80 % or more of today's request limit. Unknown inputs SHALL add no row.

#### Scenario: Requests near the limit

- **WHEN** today's AI requests reach 82 % of the limit
- **THEN** Needs attention shows the 82 % row linking to AI providers

#### Scenario: Nothing to do

- **WHEN** nothing failed, needs a retest, waits for review or sign-in, and requests are below 80 %
- **THEN** no Needs attention section is shown

#### Scenario: External AI app request waiting

- **WHEN** a member's grant or app request waits for a decision in the selected workspace
- **THEN** Needs attention shows the number of waiting requests linking to External AI apps
