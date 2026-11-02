# Spec Delta

## MODIFIED Requirements

### Requirement: Personal sign-in from the app

The mobile app SHALL start a personal sign-in with `POST /v1/{workspace}/services/start`, follow it with `status` and `cancel`, and open `/admin/service-connect#…` in the system browser. The browser SHALL sign in to the server as the same person (linking the sign-in method first when needed) before redirecting to the provider. After consent the page SHALL exchange the code once and return through `niaro://service-connected`. Only the owner SHALL sign in to an own service.

#### Scenario: Different person in the browser

- **WHEN** the browser is signed in to the server as someone other than the app's person
- **THEN** the sign-in attempt is refused and no connection is stored

#### Scenario: Someone else's own service

- **WHEN** a person starts a sign-in for a service another person added for themselves
- **THEN** the system answers `404 catalog_not_found`

#### Scenario: Return to the app

- **WHEN** the provider consent finishes for a sign-in started in the phone app
- **THEN** the page opens `niaro://service-connected` and the app refreshes the sign-in status
