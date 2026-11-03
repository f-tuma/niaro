# Spec Delta

## ADDED Requirements

### Requirement: List change marks

The server SHALL keep, for each person, a change mark of their Tasks and one of their Meetings, and SHALL return both in the events poll response as `lists: { tasks, meetings }` to clients that ask with `lists=agent-list-marks/1`. Other clients SHALL receive the response unchanged. Marks SHALL be opaque and SHALL NOT reveal anything about the items.

#### Scenario: An older client

- **WHEN** a client polls events without `lists=agent-list-marks/1`
- **THEN** the answer has no `lists` field

### Requirement: What moves a list change mark

The tasks mark SHALL change whenever one of the person's items is created, decided, closed by the assistant or removed with its meeting. The meetings mark SHALL change whenever one of their meetings is created, saved (upload progress, sealing, renaming, a processing step, a transcribed segment, speaker names, deleted sound) or deleted. A server restart SHALL change every mark. Reads, a repeated create and a replayed decision SHALL NOT change a mark.

#### Scenario: An item added by the assistant

- **WHEN** the assistant adds an open item for the person while their phone polls events
- **THEN** the next events answer carries a different tasks mark and the same meetings mark

#### Scenario: A replayed decision

- **WHEN** the phone sends the same decision again after a lost acknowledgement
- **THEN** the server answers from its receipt and the tasks mark stays the same

### Requirement: Tasks on the phone read after a change

The phone SHALL NOT read the Tasks list on a timer while the server sends change marks. It SHALL read it when Tasks starts being followed or its tab or page changes, when the tasks mark differs from the mark of the last read (at most every 5 seconds, the last change included), and on **Refresh**. It SHALL follow the tasks mark also while Tasks is hidden, so the Tasks badge counts the latest change.

#### Scenario: Idle on Tasks

- **WHEN** the person keeps Tasks open and nothing changes
- **THEN** the phone sends no Tasks reads after the first one

#### Scenario: Badge after a change elsewhere

- **WHEN** an item is added on the web while the phone shows the chat
- **THEN** the phone reads Tasks within seconds and the badge counts the new item

### Requirement: Tasks read on opening and on return

The phone SHALL read Tasks when Tasks opens and the last read is older than 2 minutes or predates a change, and when the app returns from the background or the connection returns. It SHALL NOT read Tasks while the app is in the background. With a server that sends no change marks, it SHALL read Tasks at most every 2 minutes while the app is in the foreground.

#### Scenario: Back from the background

- **WHEN** the app returns to the foreground
- **THEN** the phone reads Tasks once

#### Scenario: Quick reopening

- **WHEN** the person leaves Tasks and opens it again within 2 minutes with nothing changed
- **THEN** the phone shows the list without reading it
