# Spec Delta

## ADDED Requirements

### Requirement: Meetings on the phone read after a change

The phone SHALL NOT read the meeting list on a timer while the server sends change marks (see `tasks` "List change marks"). While Meetings is on screen it SHALL read the list when the meetings mark differs from the mark of the last read (at most every 5 seconds, the last change included), when another record is opened, and on **Refresh**. A meeting that uploads or processes SHALL move through its steps on screen by these reads.

#### Scenario: Idle on Meetings

- **WHEN** the person keeps Meetings open and no meeting changes
- **THEN** the phone sends no meeting list reads after the first one

#### Scenario: Processing on screen

- **WHEN** a meeting on screen is transcribing and the server finishes it
- **THEN** the meetings mark moves, the phone reads the list and the meeting shows as ready without a periodic read

### Requirement: Meetings read on opening and on return

The phone SHALL read the meeting list when Meetings opens and the last read is older than 2 minutes or predates a change, and when the app returns from the background with Meetings on screen. It SHALL NOT read the list while Meetings is hidden or the app is in the background. With a server that sends no change marks, it SHALL read every 15 seconds while a meeting on screen uploads or processes, and otherwise at most every 2 minutes while Meetings is on screen.

#### Scenario: Changed while hidden

- **WHEN** a meeting is renamed on the web while the phone shows Tasks, and the person then opens Meetings
- **THEN** the phone reads the list once on opening
