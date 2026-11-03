# Spec Delta

## MODIFIED Requirements

### Requirement: Main chat sessions

The mobile app SHALL start the main chat empty after an app launch and after four hours in the background, marking the first new request with `session: "new"` (never on an answer to a question). The server SHALL then move the main chat's messages into a read-only session archive (`archived-N`) and clear short-term context before the model reads anything; open work stays available in Tasks. A replayed command SHALL NOT archive twice and an empty chat SHALL write no archive. A task of the earlier session that follows it into the session archive SHALL be served with the archive as an empty, read-only reference, and the person's snapshot, events and commands SHALL keep working.

#### Scenario: Return after a long break

- **WHEN** the mobile app resumes after more than four hours in the background and the person sends a request
- **THEN** the previous main chat appears in the archive as a read-only chat
- **AND** the assistant answers without the earlier session's short-term context

#### Scenario: Task of the earlier session

- **WHEN** the main chat holds a task that read a service and the first message after an app launch starts a new session
- **THEN** the task names the session archive and the archive's messages stay unchanged
- **AND** the phone stays online and receives the answer
