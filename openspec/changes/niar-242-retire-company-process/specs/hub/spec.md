## ADDED Requirements

### Requirement: Retired process widgets

A process widget whose company process is retired SHALL read as failed with `process_retired`, keep its last good output and its time, and not be due on open. A refresh requested on open, by the person or by a view change SHALL start nothing and record `process_retired`. The card SHALL say the process was retired, offer no refresh, keep Remove, and link administrators to the process page.

#### Scenario: Opening the hub after retirement

- **WHEN** a person opens the overview with a `daily` process widget whose process was retired yesterday
- **THEN** the widget shows its last output with "Retired", no refresh starts and no run is admitted

#### Scenario: Refresh pressed on a retired widget

- **WHEN** a client sends an explicit refresh of a retired process widget
- **THEN** no start is prepared, the result reads failed with `process_retired` and the last output stays

#### Scenario: Run waiting at retirement

- **WHEN** a widget's run waits for approval when its process is retired
- **THEN** the card keeps showing "Waiting for you" until the run settles, then shows the retired state

#### Scenario: Restored process

- **WHEN** an administrator restores the process
- **THEN** the widget is due again by its refresh policy and refreshes on the next open

## MODIFIED Requirements

### Requirement: Process widget eligibility

A process widget SHALL show the result of a process the person can start (see `process-execution`) that needs no input and changes nothing unattended: every service action its active version can call is a read or a write that requires approval under the current policy. The server SHALL check this on add and again before every refresh.

#### Scenario: Process that writes unattended

- **WHEN** a person adds, or a refresh would start, a process with a write that runs without approval
- **THEN** it is refused with `hub_process_writes` and nothing starts

#### Scenario: Process needs input

- **WHEN** a process on the hub now requires input
- **THEN** its refresh fails with `hub_process_needs_input`

#### Scenario: Process gone

- **WHEN** the person can no longer start the process
- **THEN** the add is refused or the refresh fails with `hub_process_unavailable`

#### Scenario: Adding a retired process

- **WHEN** a person or the assistant adds a widget for a retired process
- **THEN** the add is refused with `hub_process_unavailable` because the process is not in the start inventory
