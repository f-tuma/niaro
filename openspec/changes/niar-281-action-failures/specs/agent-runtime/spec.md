# Spec Delta

## MODIFIED Requirements

### Requirement: Oversized read results

A read result over 64 KB SHALL be cut to fit before it is stored or passed to the model: long text SHALL keep its beginning and end with `… [truncated]`, long lists SHALL keep their first items, the data SHALL say `truncated: true`, and an MCP text block holding JSON SHALL stay valid JSON. A read whose result cannot be cut to fit SHALL fail, and the model SHALL be told the result was too large and to ask for fewer records or fields or page through it. A write's result SHALL never be cut.

#### Scenario: Large export

- **WHEN** a read returns 200 KB of records
- **THEN** the model receives the first records marked as truncated and can ask for a narrower or next page

#### Scenario: Long mail thread

- **WHEN** a read returns an Outlook message whose quoted history makes it 200 KB
- **THEN** the read succeeds with the newest part of the message, marked as truncated

#### Scenario: Result that cannot be cut

- **WHEN** a read returns more than 64 KB of small fields that cannot be shortened
- **THEN** the model receives a "too large" note and can retry with a narrower request

#### Scenario: Oversized write receipt

- **WHEN** an approved write is sent and its response is over 64 KB
- **THEN** its result is not stored cut, and its outcome is `unknown` with the next step to verify first

## ADDED Requirements

### Requirement: Run status follows the outcome

A chat run that delivers the model's reply SHALL end `succeeded` even when service reads or tool calls failed during it; those steps SHALL stay failed in the run's trace. A write refused by the consistency check or a failed write SHALL end the run `failed`, and an unconfirmed write `unknown`. A run that ends without the model's reply (step limit, model, protocol or execution failure, a lookup or write the server answers itself) SHALL keep its failure status.

#### Scenario: Recovered read

- **WHEN** a CRM read fails because of a wrong sort argument, the model corrects it, the next reads succeed and it answers
- **THEN** the run is `succeeded` and the first read's step is `failed`

#### Scenario: Read that kept failing

- **WHEN** a read fails, the model explains this in its reply and no write was made
- **THEN** the run is `succeeded`

#### Scenario: Failed write

- **WHEN** a write fails and the model answers
- **THEN** the run is `failed`

### Requirement: Failed steps stay out of the person's answer

A delivered answer SHALL NOT carry the result card of a read that failed during the run, and the web and phone apps SHALL NOT show a failed action card on a task that succeeded; failed steps SHALL stay visible to administrators in Runs. An answer SHALL keep a failure card when the run ended without the model's reply or a write failed, was refused or is unconfirmed, and it SHALL keep the cards the person must act on (approval, sign-in).

#### Scenario: Recovered mail read

- **WHEN** a mail read fails, the corrected read succeeds and the model answers
- **THEN** the person sees the answer without an "Action failed" card on the web or the phone

#### Scenario: Failed write

- **WHEN** a write fails and the model answers
- **THEN** the answer still carries the write's failure card
