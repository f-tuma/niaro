## ADDED Requirements

### Requirement: Generate test in the console

The console's Tests tab SHALL offer **Generate test** for the selected frozen version of any process, including one built on the canvas, using `GET /admin/api/identity/catalog/processes/tests/native/generate`, which authorizes like the test tool inventory. It SHALL return the suite the chat path would generate, or the reason none can be made. Generating MUST NOT start a test, call a model or dispatch an action; the person reviews the suite in the editor and starts the test.

#### Scenario: Read workflow built on the canvas

- **WHEN** a person generates a test for a frozen workflow that reads a service and returns the result
- **THEN** the editor holds a suite for that version and no test has run

### Requirement: Generate test refusal

When no suite can be generated, the console SHALL say in one sentence what kind of problem it is and that the test must be written by hand.

#### Scenario: Agent that writes through its own tool

- **WHEN** a person generates a test for an agent that can only write through its own tool call
- **THEN** no suite is generated and the console says the agent steps can't be scripted automatically and the test must be written
