## MODIFIED Requirements

### Requirement: Connections screen

The web app's Connections screen SHALL list the services acting under the person's own account in the current workspace (`…/catalog/oauth/list`), each with state (connected, expired, not connected, not set up), account, what signing in unlocks and sign-in method, with connect and disconnect. A service's page SHALL list reads and changes apart, each with a switch, and changes with Always ask or Don't ask. A sign-in opens the provider in another tab; the list waits up to ten minutes.

Connections SHALL also list, read-only and in its own **Company account** group, every enabled service the person may use that runs only on the company's account, from the member service projection (`service-catalog`). Every listed service SHALL say whose account its reads and its changes use and SHALL show only the person's own last successful read and last failure. A company-account service SHALL offer no sign-in, switch or approval choice; its page SHALL list the reads and changes the person may run and say that an administrator sets them. When the projection cannot be loaded, the sign-ins SHALL stay usable. The phone SHALL render the same groups from the same projection.

#### Scenario: Connected service

- **WHEN** a person opens Connections after signing in to a service
- **THEN** the service shows as connected with the account name

#### Scenario: Service not set up

- **WHEN** a service needs personal sign-in but its OAuth is not complete
- **THEN** the service shows as not set up and cannot be connected

#### Scenario: Company CRM

- **WHEN** the CRM runs on a company account and the member may run two of its reads
- **THEN** the member sees it under "Company account" with "2 reads" and no sign-in action

#### Scenario: Reads with the company account, changes with the person's

- **WHEN** a service requires personal sign-in for changes only
- **THEN** its row and page say that reading uses the company account and changes use the person's account

#### Scenario: Own activity only

- **WHEN** a colleague's assistant read the CRM after the member's last read
- **THEN** the member sees their own last read time, not the colleague's
