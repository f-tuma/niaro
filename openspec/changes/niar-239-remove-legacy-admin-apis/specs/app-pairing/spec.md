# Spec Delta

## ADDED Requirements

### Requirement: Only browser sign-in enrolls an app

The system SHALL issue an app credential for an account workspace only through the code exchange of browser sign-in (`POST /v1/auth/app/exchange`) or, for the web app, from its browser session. The retired enrollment paths SHALL answer `404 not_found` and issue nothing: `POST /admin/api/identity/mobile/pairing`, `POST /v1/{workspace}/auth/pair` for an account workspace, `POST /v1/auth/browser/start|poll|cancel` and `POST /admin/api/identity/device/inspect|release|consent`.

#### Scenario: Requesting a pairing code

- **WHEN** an owner signed in to the browser posts to `/admin/api/identity/mobile/pairing`
- **THEN** the system answers `404 not_found` and no code exists

#### Scenario: Redeeming a code for an account workspace

- **WHEN** a client posts any code to `/v1/{workspace}/auth/pair` for an account workspace
- **THEN** the system answers `404 not_found` and issues no credential

#### Scenario: Starting a device-code login

- **WHEN** a client posts to `/v1/auth/browser/start`
- **THEN** the system answers `404 not_found`

#### Scenario: Browser sign-in still works

- **WHEN** a person signs in through `/account/login` and the app exchanges the code with the matching verifier
- **THEN** the app receives a renewable device credential as before

## REMOVED Requirements

### Requirement: Legacy enrollment endpoints

**Reason**: No current app offers the one-use pairing code or the device-code browser login. PKCE browser sign-in ("Sign-in with only the server address") replaced both. The extra paths kept a second consent page (`/admin/device`), their own tables and a code that an owner could hand out without the person's browser.

**Migration**: Apps sign in through `POST /v1/auth/app/start`, `/account/login` and `POST /v1/auth/app/exchange`. Old builds that still offer "Use backup pairing code" must use "Continue with browser". Pending codes and device-code logins are discarded at upgrade. Device sessions that were already issued through these paths keep working until they expire or are revoked.
