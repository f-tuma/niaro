# ADR 008 — Server-side CalDAV integration with local Radicale

Date: 2026-09-24. The user selected a locally installed Radicale server for DEV-015. This delivery creates and verifies actual VEVENT resources, using synthetic contacts in an isolated local calendar. It does not send invitations, use a personal cloud account, or connect a language model.

## Runtime and local setup

Radicale **3.8.0** is installed in `.radicale/venv`, with the resolved Python dependencies pinned in `scripts/radicale-requirements.txt`. Setup creates an owner-only directory, a random password, a bcrypt password file and an explicit `owner_only` access policy. Radicale listens only on `127.0.0.1:5232`. It stores events independently of the application's SQLite database. Installation and auth configuration follow the [official Radicale documentation](https://radicale.org/v3.html). Server iCalendar parsing/serialization uses [ical.js](https://github.com/kewisch/ical.js), pinned to **2.2.1** in the npm lockfile; it is not imported into the mobile UI.

Run from the repository root:

```sh
npm run calendar:install
npm run calendar:setup
npm run calendar:start
```

In another terminal:

```sh
npm run calendar:init
npm run fixture:calendar
```

Then generate a one-use app pairing code:

```sh
npm run fixture:calendar:pair
```

Pair the application with `http://localhost:8793/v1/a` as `calendar-user`. The calendar fixture uses `.fixture-calendar` so the existing `.fixture` demo remains separate. Its default port is 8793, overridable with `FIXTURE_PORT`. The allowed web origins default to localhost:8081 and localhost:8085. For the dedicated web preview:

```sh
AGENT_CLIENT_DEVELOPMENT=1 EXPO_PUBLIC_ALLOW_INSECURE_FIXTURES=1 npx expo start --web --port 8085
```

The configured collection is `http://127.0.0.1:5232/agent-test/meetings/`, named **Agent Client Test**. `.radicale/client.json` contains server-only credentials and the exact fixture scope. It must stay mode 0600, is ignored by Git, and must not be pasted into chat or copied into app configuration. Setup preserves existing files and events. The provisioning command creates only the local collection; it does not create a meeting. Radicale's web UI at `http://127.0.0.1:5232` manages collections; this app is the workflow UI.

Stop each foreground service with Ctrl-C. Back up `.radicale` and `.fixture-calendar` together with both services stopped. Do not reset only the fixture while expecting its existing calendar binding to keep working: a fresh server identity must be deliberately rebound in the server-only configuration. No background system service or automatic boot startup was installed.

## Consent and execution

`FIXTURE_CALENDAR_CONFIG` selects one validated server configuration file. Only its exact connection/server/user/workspace receives a CalDAV proposal; other scopes remain simulated. The proposal records the integration ID, display name, collection URL and `invitations: none` inside its reviewed meeting parameters. The approved operation copies those parameters. Changing or removing a configured destination cannot redirect an existing approval. Editing a simulated proposal after enabling CalDAV also leaves it simulated.

The client shows the destination and explains that confirmation writes a real test event. The synthetic contact appears in DESCRIPTION, with no ORGANIZER, ATTENDEE, METHOD, alarm, or scheduling request. There is no email transport. The server rechecks the current binding before approval and before any network call. Calendar credentials never appear in snapshots, event payloads, command receipts or client configuration.

The flow is contact selection → proposed calendar event → explicit revision approval → durable pending operation → durable executing/claim → CalDAV request → independent GET verification → completed work. A claim commits before network access. Network I/O runs outside SQLite. The worker has one in-flight loop and aborts on server shutdown. A crashed claim becomes eligible after its 30-second lease; it does not depend on a connected client.

The remote resource name and UID are a SHA-256-derived identity bound to the complete authenticated scope, fixed destination, operation ID and idempotency key. Every attempt reads that same `.ics` resource first. A missing resource may be created with `PUT` and `If-None-Match: *`; an existing resource is never overwritten. `412` or `409` requires a readback, not a new identity. This follows the conditional creation approach in [CalDAV RFC 4791 §5.3.2](https://datatracker.ietf.org/doc/html/rfc4791#section-5.3.2).

Success requires a GET containing exactly the expected UID, title, contact description, UTC start/end, confirmed status, parameter fingerprint, a strong ETag, one VEVENT and no unexpected scheduling/recurrence components. A successful PUT alone is insufficient. The public result contains the stable event reference, ETag and verification timestamp. Replaying a command, rendering a card or reconnecting does not create another operation.

An unavailable server, refused credentials, malformed response or divergent remote event produces `result_unknown`; it never claims success or overwrites remote changes. Transient conditions retry the same identity with backoff for up to eight completed attempts. Divergent content/configuration stops automatic retry. After checks stop, the UI provides an explicit **Check the same calendar event** command with the operation's current revision; this resets checks for the same approved identity, not a new operation. A missing resource may again be created conditionally, so it is a reconciliation/retry action, not a general read-only inspection. No delete or update integration is exposed.

Outbound requests reject redirects, have eight-second timeouts and limit event bodies to 64 KiB. Configuration permits HTTPS, or HTTP only to explicit loopback IP addresses. Network deployment, shared calendars with other applications, OAuth/account administration and provider-specific scheduling are outside this local profile. Concurrent deletion/recreation by another calendar editor is not an exactly-once guarantee.

## Protocol and compatibility

The wire profile is **`agent-client/0.3-fixture`** because approved calendar destinations, verified results, error codes and `operation.reconcile` are new contract fields. The internal database payload remains version 2: old snapshots are validated and upgraded to the new profile without adding a calendar target to any old proposal or operation. Legacy v1 migration also remains supported. Existing server session files upgrade their profile on read; old mobile cache/credential schemas require a fresh pairing after updating the app. Restart both server and client JS bundle. `demo: true` continues to identify this synthetic-data profile; the presence of reviewed `parameters.calendar` distinguishes a real local effect from simulation.

## Verification and limits

`npm run check` passed with clean lint/types/boundaries and 140 tests in 20 suites, including the adapter, durable claims, lost replies/restart, conditional-write conflicts, denied credentials, invalid/different remote data, scope/target isolation, claim-write failure, bounded retries/manual reconciliation, legacy simulation safety and EN/CS approval cards. The separate opt-in command below talks to real Radicale and does not run as part of the ordinary mocked/unit test suite:

```sh
npm run test:calendar
```

It creates its own temporary `qa-*` collection, persists an event while dropping its PUT response, restarts application storage and verifies it. It then launches a separate HTTP server, kills that process with SIGKILL immediately after Radicale accepts another PUT, restarts it after claim expiry, verifies the resource and replays the original command. **Exactly two VEVENTs existed for two approved operations.** The runner then deletes only its own temporary collection and cleans up its own processes/data.

Web/iOS/Android application exports (`npm run build`) and the separate Storybook web export (`npm run storybook:export`) also passed. These are bundle checks, not native device tests.

The user-facing test collection is separate and retained for review. A browser walkthrough and the final checks passed. No personal calendar, invitation, physical device test, native iOS build, or production deployment is claimed. The next server integration work should address real account administration and permissions only when a concrete external provider/account is selected; the next project step was the voice/audio path.
