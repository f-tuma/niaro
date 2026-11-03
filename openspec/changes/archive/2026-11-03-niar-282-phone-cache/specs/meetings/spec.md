# Spec Delta

## ADDED Requirements

### Requirement: Meeting list on the phone

The phone's Meetings screen SHALL show the last known meeting list (see `chat` "Phone list cache") until the server's first answer in the session, instead of a loading message, and SHALL show and keep every answer of its regular read.

#### Scenario: Opening Meetings after a start

- **WHEN** the app starts and the person opens Meetings
- **THEN** the meetings from the last run are listed at once and replaced by the server's list when it arrives
