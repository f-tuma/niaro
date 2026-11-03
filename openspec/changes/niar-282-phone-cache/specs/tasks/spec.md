# Spec Delta

## ADDED Requirements

### Requirement: Tasks on the phone before the first answer

The phone's Tasks screen SHALL show the last known first page of the open tab (see `chat` "Phone list cache") until the server's first answer for that tab in the session. Those items SHALL be readable, and their decisions SHALL stay disabled until the server has answered.

#### Scenario: Opening Tasks after a start

- **WHEN** the app starts and the person opens Tasks before the server answers
- **THEN** the open items from the last run are listed and their **Mark as done** and **Remove** wait for the server's list
