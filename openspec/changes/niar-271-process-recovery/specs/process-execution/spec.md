## ADDED Requirements

### Requirement: Failure sentences and next steps

Each safe failure code SHALL map to one fixed English and Czech sentence and at most one next step (`sign_in`, `run_again`, `retest` or `edit`) in one table shared by the server, the web app and the mobile app. An unknown code SHALL read as a generic sentence naming the code, with no next step. An unconfirmed write MUST NOT offer Run again. A client SHALL show a next step only where this person can take it.

#### Scenario: Missing sign-in

- **WHEN** a person's run stops with `connection_required`
- **THEN** the web run sheet says "A service it uses needs you to sign in." with Sign in, which opens Connections

#### Scenario: Unknown code

- **WHEN** a run stops with a code the table does not know
- **THEN** the apps say "It stopped with code <code>." and offer no next step

#### Scenario: Unconfirmed write

- **WHEN** a run stops with `process_action_unknown`
- **THEN** the sentence asks the person to check the service and no Run again is offered for it

### Requirement: Failure code in the run projection

With detail access, the run projection SHALL carry the run's safe failure code as `failureCode` and write the table's sentence into the run's result. A value that is not a short code MUST NOT be shown.

#### Scenario: Failed output

- **WHEN** a run fails with `process_output_invalid` and the person may see details
- **THEN** its WorkItem carries `failureCode: process_output_invalid` and its result says the result didn't match the declared output

### Requirement: Run again

A finished, failed or stopped process run SHALL offer **Run again** on the web and the phone. It SHALL read the earlier run's admitted input with `GET …/processes/runs`, take a fresh start inventory and open the ordinary start form of the process's **current active version**, filled with that input, and it MUST NOT send anything until the person reviews the form and presses Start, which sends an ordinary new start. A process that cannot start now SHALL say why and open no form.

#### Scenario: Schema changed

- **WHEN** the active version's input schema no longer accepts the earlier input
- **THEN** the form shows field errors for the values that no longer fit, for fields that are gone and for required fields without a value, and nothing is sent

#### Scenario: Newer version active

- **WHEN** the earlier run used version 3 and version 4 is active
- **THEN** Run again opens version 4's form with the earlier input

#### Scenario: Blocked process

- **WHEN** the process is blocked for a missing sign-in
- **THEN** Run again opens no form and the reason is shown
