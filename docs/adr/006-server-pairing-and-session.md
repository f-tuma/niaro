# ADR 006 — Server pairing and authenticated context

Storage follow-up: [ADR 007](007-transactional-workflow-storage.md) replaces workflow JSON with SQLite and enforces a single HTTP owner. The auth-file limitations below still apply.

Date: 2026-09-24. Status: implemented and tested against the local synthetic reference fixture. This is the bounded DEV-010 delivery, not a production identity provider or permission system.

## Decision and trust boundary

Use the one-use backend pairing option already allowed by ARCHITECTURE §5 (D-04). A trusted server operator runs `npm run fixture:pair -- <synthetic-user-id> <a|b>`. The command creates a random 128-bit, five-minute code bound to that user and workspace. There is no HTTP endpoint that lets an unauthenticated client issue its own code or choose an arbitrary principal. The possession and trusted delivery of this code authorize pairing; this is not password login or verification of a person's real-world identity.

`POST /v1/<workspace>/auth/pair` negotiates `agent-pairing/1` and `agent-client/0.2-fixture` and consumes the code. Its reply contains an opaque random 256-bit bearer token, exact connection/server/user/workspace scope, expiry, and the supported workflow read/write grants. Requests use Authorization headers, not URL tokens. The normal lifetime is 30 minutes; expiration requires a new code. There is no refresh token, automatic re-pairing, external account provider, or calendar authorization in this delivery.

All snapshot, event and command routes authenticate the bearer token. The route must match its workspace, and the engine is selected using the authenticated user and workspace. Strict command bodies cannot override that identity. Body-reading commands authenticate again before execution, because a request can span expiration or revocation. Pairing has a per-address limit of ten requests per minute and bounded in-memory tracking. CORS is an additional browser restriction, not authentication.

Each fixture data directory has its own generated persistent server ID. Authenticated workflow state lives under `authenticated/<user>/<workspace>.json`; identical work/command IDs in another account do not address the original account's work. Anonymous legacy `a.json`/`b.json` files remain untouched and are not adopted by the first paired user. Workers resume authenticated jobs on server startup independently of a client session; logout is not cancellation of approved work.

## Persistence and lifecycle

The server stores only SHA-256 digests of random pairing codes and tokens, with scope and expiry in owner-only files/directories. A grant is renamed as consumed before persisting its session. Ordinary persistence failure restores the grant; a process crash can lose a grant but cannot make the consumed grant redeemable again. Session creation/revocation atomically replaces the single-process session file. Expiration and revocation survive a server restart. This is not multi-process locking or a transactional production database.

The mobile app stores the active endpoint plus credential in Expo SecureStore. Android uses Keystore-backed encrypted preferences; iOS uses Keychain. We select `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and configure Android backup exclusion through the plugin. There is no fallback to AsyncStorage on a keystore error. See the [official SecureStore storage and backup documentation](https://docs.expo.dev/versions/latest/sdk/securestore/), checked for SDK 57; bundled expected SecureStore version is `~57.0.4`.

The web preview keeps the credential only in memory. Reload requires a fresh pairing code. We deliberately do not claim a persistent web login or store a bearer token in localStorage; a production browser application still needs an appropriate authenticated session design.

Before reading a scoped cache on restore, ClientSession validates the saved token and exact scope against `GET auth/session`. Snapshot and pending-command keys include endpoint, connection, server, user and workspace. Anonymous v1 cache keys are not read. Credentials are never included in workflow snapshots or pending commands. Those synthetic workflow caches remain unencrypted and retained; credential security does not make them suitable for personal production data.

Expiry/401/403 hides the store, clears visible pending state, stops polling, forgets the credential and remounts the workspace to discard local drafts. Re-pairing into the same identity can recover an uncertain saved command, but it is never sent automatically. Switching identities stops the old session immediately and guards late responses/vault writes with a generation. A late pairing response is revoked and cannot replace a newer identity. Logout hides local work and deletes the credential, then revokes the server session; failed remote revocation is reported and the token still expires normally. A credential deletion failure is reported separately rather than claiming the credential was removed.

Only a normalized, user-selected endpoint receives its token. Web fetch requests forbid redirects and omit ambient cookies. Native redirect behavior still needs dedicated adversarial verification before production; the local emulator walkthrough is not a guarantee across arbitrary redirects, proxies or transport implementations. HTTPS remains required outside the explicitly enabled local/private-network development exception. Existing integration tokens remain a server concern.

## Verification and limits

`npm run check`: 100 tests in 17 suites, clean lint/types/layer boundaries. Added cases cover unauthenticated routes, expired/used/wrong-workspace codes, cross-user work ID collisions, body scope injection, token expiry/revocation and server restart, persistence failure, rate limiting, scope negotiation before cache access, keystore errors, vault restore/delete, cancellation during pairing, late old responses, and uncertain command handling. ConnectionCard has EN/CS and eight Storybook states.

Chromium at localhost:8081 (1280×1000 and 390×844) passed invalid code → pair Alice → create work/draft → pair Bob without Alice data → logout → re-pair Alice → reload requiring login → real 30-second expiry in CS. Console errors/warnings and horizontal overflow were absent. Browser plugin was unavailable; bundled Playwright 1.62.1 was used. Temporary screenshots and result: `/tmp/agent-auth-desktop.png`, `/tmp/agent-auth-mobile-expired.png`, `/tmp/agent-auth-web-result.json`.

Android development APK with SecureStore built successfully. AVD droid/API 37/x86_64 passed pairing, cold-start credential/data restoration, manual retry after process termination during delivery, logout and another cold start staying signed out. Native screenshots and UI XML remain under `/tmp/agent-auth-native-*`. A separate 30-second native session expired in the UI, hid its identity and offered re-pairing. Native expiry did not create business work; the web expiry test also verified hiding an existing question. Web/iOS/Android application export and separate Storybook web export passed. No physical phone, iOS native build, remote CI, external identity provider or real integration was exercised.

The dependency compatibility check now recommends newer patch versions of the existing pinned Expo (57.0.24 → ~57.0.25) and expo-build-properties (57.0.21 → ~57.0.22). Those unrelated pins were retained; SecureStore matches the installed SDK's bundled version. Native build, tests and exports passed with the current lockfile. Expo install added SecureStore but could not edit dynamic app.config.ts automatically; the config plugin was added explicitly and verified by prebuild/build.

Production identity administration, finer grants, encrypted workflow caches, retention, TLS deployment and durable multi-process server storage remain open. The next implementation step is durable state/event/receipt persistence (DEV-011) before a real calendar effect (DEV-015).
