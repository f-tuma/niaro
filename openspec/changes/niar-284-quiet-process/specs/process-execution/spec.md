# Spec Delta

## MODIFIED Requirements

### Requirement: App command recovery

The apps SHALL save each start, approval and answer before sending. A delivery whose outcome is unknown SHALL be resent only as the same exact command, with its saved bytes, `commandId` and `idempotencyKey`, and the client SHALL do that by itself (see "A lost process outcome is checked without the person"). A known outcome whose local saving failed SHALL offer **Save again** without another request. Rendering, a reload or a poll MUST NOT send anything else, and a saved answer SHALL stay visible until the server shows it consumed.

#### Scenario: Lost start in the app

- **WHEN** the app restarts after sending a start without an answer
- **THEN** it shows the saved start as starting, with no button
- **AND** once online in the foreground it posts the same exact start by itself and the run shows as started

#### Scenario: Saved answer survives restart

- **WHEN** the app restarts after a process answer was sent and not yet confirmed
- **THEN** the answer keeps its exact text and is shown as the person's message on its way
- **AND** the client checks it by itself and it stays until the server shows it consumed

## ADDED Requirements

### Requirement: A lost process outcome is checked without the person

When a `process.start`, `process.answer` or process `service.resolve` send ends without a receipt, the client SHALL check it by itself by posting the identical saved command, one request per check: at once while online, again on reconnecting and on returning to the foreground, and at most 2, 4, 8 and 16 seconds apart while the server answers reads but not the command.

#### Scenario: Start whose response was lost

- **WHEN** the server admitted a start but its response was lost
- **THEN** the client's check receives the original admission and the run shows as started
- **AND** the server has exactly one admission and one run for that start

#### Scenario: Answer whose response was lost

- **WHEN** the server recorded a process answer but its response was lost
- **THEN** the client's check receives the recorded receipt and the answer shows as accepted
- **AND** the run receives that answer once

### Requirement: Process checks stay safe

The client SHALL NOT check a process command while offline, in the background or while another request for it is in flight, and SHALL NOT post one whose outcome is already known or whose saved proof is missing. After five failed checks the command SHALL stay working and be checked again only on reconnecting or returning to the foreground.

#### Scenario: Server unreachable

- **WHEN** the server is unreachable for minutes after a start was sent
- **THEN** nothing is posted until the server answers again
- **AND** then one identical start is posted

#### Scenario: Server keeps failing the command

- **WHEN** five checks of a start fail while the server answers reads
- **THEN** the start stays shown as starting and no further check is posted until the app reconnects or returns to the foreground

### Requirement: No unconfirmed process card

While a process start, answer or decision is on its way or being checked, the apps SHALL show it as working: the start as "Starting…" with no button, the answer as the person's message on its way, the decision as being sent on its approval, each with no saved card. They SHALL NOT show "not confirmed" wording, a Retry or the unverified-execution explanation for it. Admin Runs SHALL keep the technical state.

#### Scenario: Start being checked

- **WHEN** a start's response was lost and the client checks it
- **THEN** the launcher shows the process as starting with no Retry and no "not confirmed" wording

#### Scenario: Answer being checked offline

- **WHEN** the server is unreachable after a process answer was sent
- **THEN** the chat shows the answer as the person's message on its way and the header says Offline
- **AND** no saved-answer card, Retry or error is shown for it

### Requirement: A process command that failed

The client SHALL show a process start, answer or decision as failed, with "Couldn't finish. Try again." and **Try again**, only when it knows the delivery failed: the server named a process, model, catalog or inference cause without a receipt, a Stop was not confirmed, or the command could not be saved before it was posted. A refused start or answer SHALL keep its refused display.

#### Scenario: Answer the server could not take

- **WHEN** the server answers a process answer with `503 process_model_unavailable`
- **THEN** the saved answer shows "Couldn't finish. Try again." with Try again

### Requirement: Trying a failed process command again

**Try again** SHALL post the identical saved command once. The client SHALL NOT resend a failed process command by itself, on polls, reconnects or returning to the foreground.

#### Scenario: Try again after a stated failure

- **WHEN** a process answer failed with `503 process_model_unavailable` and the app reconnected and returned to the foreground
- **THEN** nothing was resent by itself
- **AND** Try again posts the identical answer once and it shows as accepted
