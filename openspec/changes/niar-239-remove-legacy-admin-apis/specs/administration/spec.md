# Spec Delta

## MODIFIED Requirements

### Requirement: Personal pages under /admin

Members SHALL still reach the personal pages served under `/admin`: connecting a service for themselves (`/admin/service-connect`) and the consent page for an external AI app (`/admin/mcp/consent`); their behavior is specified in `service-sign-in` and `mcp-server`. App sign-in consent is on `/account/login` (see `app-pairing`); `/admin/device` SHALL NOT be served.

#### Scenario: Member confirms an app sign-in

- **WHEN** a member confirms the app's browser sign-in
- **THEN** they do it on `/account/login`, and opening `/admin/device` answers `404` with no confirmation page or device-code API

#### Scenario: Member connects a service

- **WHEN** a member opens `/admin/service-connect` from the app's personal sign-in
- **THEN** the sign-in page opens instead of "Administrators only"
