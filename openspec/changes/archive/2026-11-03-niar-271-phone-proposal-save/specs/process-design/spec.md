## MODIFIED Requirements

### Requirement: Proposal card

The `process.proposal` card SHALL show name, kind, readable steps, inputs, outputs, services read or written, assumptions with digests, questions, `hubEligible` (no required input and no write without approval), `addToHub` and `status` `ready`, `questions` or `budget`. The web app SHALL offer **Save and turn on** and **Edit** (the session in `/processes/design`); the mobile app SHALL offer **Save and turn on** and opening it in the web app, show the steps, services, assumptions and questions it acknowledges, and follow the save's status.

#### Scenario: Budget not set up

- **WHEN** the person asks for a process but the budget is not ready
- **THEN** the card has status `budget`, no session, and says to ask an administrator

#### Scenario: Ineligible for the overview

- **WHEN** the proposal has a required input
- **THEN** Add to overview is disabled with the reason

#### Scenario: Save from the phone

- **WHEN** the person presses **Save and turn on** on a `ready` card in the mobile app
- **THEN** the app sends the card's revision, digest and assumptions, shows the save's phases and then that the process is on

## ADDED Requirements

### Requirement: Proposal sign-in readiness

`GET …/process-proposals?sessionId=` SHALL also return, for each service the current proposal uses, `signIn`: `connected` when the person's own connection serves it, `needed` when a run would stop at `connection_required` for them, or `none` when no personal sign-in is needed. It SHALL be computed when read and never stored, and SHALL say signed in, never that the service works.

#### Scenario: Not signed in yet

- **WHEN** a proposal reads a service that needs the person's own sign-in and they have none
- **THEN** the status lists that service as `needed`

### Requirement: Sign-in readiness on the phone card

The mobile proposal card SHALL show each service as signed in, not signed in with **Sign in**, or needing no sign-in, and SHALL read the status again after a sign-in from the card completes.

#### Scenario: Sign in from the card

- **WHEN** a service on the phone card is not signed in and the person completes **Sign in**
- **THEN** the card reads the status again and shows the service as signed in
