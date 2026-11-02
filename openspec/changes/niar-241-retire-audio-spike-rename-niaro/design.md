# Design

## Context

See proposal.md for the motivation. Where the old names and the spike live today:

- **App identity** (`app.config.ts`): `name: "Agent Client"`, `slug: "agent-client"`, `scheme: "agentclient"`, `ios.bundleIdentifier` and `android.package` `dev.agentclient.demo`, `web.name`, and the `expo-audio` microphone text "Allow Agent Client to record …". Each value has an `AUDIO_SPIKE` variant (`… Audio Spike`, `agent-client-audio`, `agentclient-audio`, `dev.agentclient.demo.audio`, `enableBackgroundRecording: false`). The development flag is `AGENT_CLIENT_DEVELOPMENT`, used in `package.json` scripts and `scripts/mobile-emulator-qa.mjs`, which also prints `exp+agent-client://…`. `android/` and `ios/` are gitignored prebuild output.
- **Redirect schemes**, spread over four places:
  - the server's default app-login target `"agentclient://auth"` in `IdentityService.appLogin` (`apps/server-identity/service.ts`), stored per login request in `agent_app_login.target`;
  - the console account page (`apps/server-admin/web/public-account.tsx`), which compares `result.target === "agentclient://auth"` and assigns the URL;
  - the phone app (`apps/mobile/app-login.ts`, which checks `protocol === "agentclient:"`);
  - personal service sign-in: `service-auth.tsx` assigns `agentclient://service-connected`, and `apps/mobile/ServiceConnection.tsx` listens for it.

  Tests pin both: `tests/app-login.node.ts` and `tests/service-connection-card.test.tsx`.
- **Visible names**: `apps/server-admin/index.html` `<title>`, `web/console-shell.tsx` `Brand` (twice), `web/i18n.ts` `loginTitle` (EN and CS), `packages/i18n` `appName` (EN and CS, currently unused), `service-auth.tsx` "Register Agent Server" (EN and CS), `apps/server-integrations/service-oauth.ts` `client_name: "Agent Server"` (shown by providers on their consent and app lists), and Better Auth `appName: "Agent Server"` in `service.ts`. Also `examples/self-hosted/server.local.json` `name: "Agent Server"`, and `docs/guides/administration.md`.
- **Audio spike**:
  - `spikes/audio/*`, selected as `@app-entry` by `metro.config.js` when `AUDIO_SPIKE=1`;
  - the `audio:spike` script (port 8083);
  - `.rnstorybook/main.ts` (`../spikes/audio/**/*.stories.tsx`);
  - `tests/audio-session.test.ts`, `audio-files.test.ts`, `audio-recovery.test.tsx` and `audio-rendering.test.tsx`;
  - CI `AUDIO_SPIKE=1 pnpm exec expo export … dist-audio` and `python3 -m unittest discover -s scripts/audio`;
  - `dist-audio` in `.gitignore`, `.dockerignore` and `eslint.config.js`;
  - spike-only i18n keys (`audioSpike`, `audioHint`, `audioCheckFile`, `audioHideFile`, `audioInterrupted`, `audioKeepRecovered`, `audioLastRecording`, `audioRetryJournal`, to be confirmed with grep);
  - `scripts/audio/soak.py`, `release_soak.py` and their tests, which drive only the `dev.agentclient.demo.audio[.profile]` packages.
- **Shared code the spike exercised**: `packages/audio/stop-recording.ts` is used by the real meeting capture (`apps/mobile/meeting-device.ts`), and its only tests are the `stop completion event` cases in `tests/audio-session.test.ts`. `packages/audio/coordinator.ts` is covered by `tests/speech.test.ts`.
- **Voice QA tools that stay**: `scripts/audio/generate_voice_quality.py` and `voice-cases.cs.json` (corpus), and `voice-evaluation.ts` (scoring). They are used by `scripts/test-voice-quality.ts` (`npm run test:voice:quality`), `scripts/test-openrouter-voice.ts` (`npm run test:voice:openrouter`) and `tests/voice-evaluation.test.ts`, and documented in `docs/guides/development.md` "Voice QA tools".

## Goals / Non-Goals

**Goals:**

- No person sees "Agent Client" or "Agent Server" in the phone app, the web app, the console or a provider's consent screen for a new registration.
- One source for the app scheme, so the server, console and app cannot drift.
- The spike and its tooling are gone, with no loss of coverage for code the product still uses.

**Non-Goals:**

- Renaming protocol or storage identifiers (see the proposal's Non-goals and D3).
- Supporting old app builds or the old scheme. The pilot allows the break.

## Decisions

### D1. New application ids `dev.niaro.app`, accepting a new app on devices

Choice: `ios.bundleIdentifier` and `android.package` both become `dev.niaro.app`, together with `name: "Niaro"`, `slug: "niaro"` and `scheme: "niaro"`.

Consequences, stated for the release note:

- iOS and Android install Niaro as a separate app. "Agent Client" stays installed until the person removes it. Nothing moves across. Secure-store credentials, AsyncStorage preferences, unsent commands and meeting audio stored locally by the old app stay with the old app.
- Each person signs in once in the new app (browser sign-in). The old app's device session stays valid on the server and holds one of the person's 8 device slots until they remove it on the account page or it passes the idle period (default 30 days).
- Unsent meeting recordings: before removing the old app, open it online and let pending meetings finish uploading.
- Android debug builds are signed with the debug keystore, so no signing change is needed. If an iOS TestFlight or App Store record exists, it needs a new record for the new bundle id.

Why change the ids now rather than keep `dev.agentclient.demo`: the scheme change already makes old builds unable to finish sign-in against an updated server, so everyone reinstalls anyway. The ids contain both the old name and "demo", and they become permanent the moment a build is published to a store. The pilot is the last cheap point. Alternative considered: keep the ids and change only name and scheme. That keeps local data on update, but leaves a wrong permanent id, and a later id change would hit more people.

### D2. One scheme constant, no old-scheme fallback

Add `APP_SCHEME = "niaro"` and the derived `APP_AUTH_URL = "niaro://auth"` and `APP_SERVICE_CONNECTED_URL = "niaro://service-connected"` to `packages/protocol` (next to `AccountWorkspaceId` in `mobile-access.ts`). Use them in:

- `service.ts` (`appLogin` default target);
- `public-account.tsx` (target comparison and redirect);
- `service-auth.tsx`;
- `apps/mobile/app-login.ts` (the protocol check compares against `APP_SCHEME` followed by a colon);
- `apps/mobile/ServiceConnection.tsx`.

`app.config.ts` keeps the literal `"niaro"`, so the Expo config does not depend on app modules. A Jest test asserts that `app.config.ts`'s scheme equals `APP_SCHEME`.

There is no fallback that also accepts `agentclient://`. An old build cannot receive `niaro://` links, so a fallback would only keep the old build half-working: an existing session would still work, but it could never sign in again. Login requests in flight at upgrade carry the old target in `agent_app_login.target` and expire within five minutes.

### D3. Internal identifiers keep their names

| Identifier | Where | Why it stays |
| --- | --- | --- |
| `agent-client/0.x-fixture`, `agent-pairing/1`, `agent-device-session/1` | protocol | Wire contract. NIAR-240 moves the workflow profile and owns that decision |
| `agent-client.*` storage keys | `packages/client-core` | On native the new app id starts empty anyway. On the web, the same origin would lose preferences, chat names and the command outbox if the keys were renamed |
| `x-agent-client-ip` | server ↔ Better Auth header | Server-internal, never sent to clients |
| `Bearer realm="agent-client"`, CalDAV `PRODID`, TEST contact names | fixture server | Fixture code that NIAR-240 removes |
| `dev.agentclient.meetingnotification` | Kotlin package of `modules/meeting-notification` | Not visible. Renaming it means moving the source files and the module config for no user-visible gain. Listed as an optional follow-up |
| `agent-assistant-mailpit` | dev container | Renaming it leaves an old container holding port 1025 on developer machines |

### D4. Visible copy

- EN: "Niaro" for the brand, title and `appName`, "Sign in to Niaro", "Register Niaro" and "Allow Niaro to record a voice request or meeting only after you press Record."
- CS: "Niaro – přihlášení" and "Zaregistrovat Niaro". Existing Czech copy uses "Niaro" only in the nominative ("co Niaro zatím nepodporuje"), so these strings avoid declining it.
- `client_name` and Better Auth `appName` become "Niaro". Services where Niaro registered earlier keep showing "Agent Server" until an administrator registers again with **Detect OAuth → Register Niaro**. This is documented in `docs/guides/administration.md`, and no automatic re-registration is attempted.
- `examples/self-hosted/server.local.json` `name` becomes "Niaro". Story and test sample labels "Agent Client Test" in `ActionApprovalCard.stories.tsx`, `tests/approval-card.test.tsx` and `tests/chat-work-card.test.tsx` become "Niaro Test".

### D5. Spike retirement keeps the shared helper covered

- First move the two `stop completion event (hasError=…)` cases into a new `tests/stop-recording.test.ts` that imports `packages/audio/stop-recording` directly. Then delete the four spike tests and `spikes/audio/`.
- `metro.config.js` keeps the `@app-entry` resolver with the `MEETING_RECORDER_QA` and `NATIVE_JOURNEYS_QA` branches only. `app.config.ts` loses every `audioSpike` conditional, and `enableBackgroundRecording` stays `true` (the current value for the real app).
- `scripts/audio/README.md` is replaced by a short note on the three corpus files that links to `docs/guides/development.md#voice-qa-tools`. The CI `unittest discover -s scripts/audio` step is removed: with no `test_*.py` left, Python 3.12 exits with status 5 ("no tests ran").
- Alternative considered: keep the soak runners and point them at the main app. They were written against the spike's foreground-only recorder, journal and Start screen. The real meeting recorder records in the background with a notification, so the runners would need a rewrite, not a retarget. That is out of scope. If a soak test is needed later, it belongs with `spikes/meeting-recorder`.

## Risks / Trade-offs

- [People keep using the old "Agent Client" app and cannot sign in again] → Release note and pilot message. The old app's existing session still works until it expires or is revoked, so nobody is cut off mid-task.
- [Unsent meeting audio left in the old app] → Release note step: open the old app online before removing it. Uploads resume on their own when the app is online.
- [Server and app updated out of step] → The server and console are one image, and the app build is released together with it. `tests/app-login.node.ts` and the new scheme test fail if the server and app drift apart.
- [Prebuild leftovers keep the old ids in `android/` and `ios/`] → Tasks require `expo prebuild --clean` and a check of the generated `applicationId`, intent filter and `CFBundleURLSchemes`.
- [The id is chosen without a company domain] → See the open question. Changing it again before any store publication costs one more reinstall.

## Migration Plan

1. Release the server image and a Niaro app build together.
2. Pilot users install Niaro, sign in through the browser, let the old app finish pending meeting uploads, remove the old app, and remove the old device on the account page.
3. Administrators who want providers to show "Niaro" register again for the affected services.
4. Rollback: the previous image together with the old app build. The new app cannot sign in against an old server, because the server would send `agentclient://auth`.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test` (with the new `tests/stop-recording.test.ts` and the app-scheme test), `npm run test:identity` (`tests/app-login.node.ts` expects `niaro://auth`), `pnpm admin:build`, `npm run storybook:generate`, `npm run storybook:export`, and `pnpm install --frozen-lockfile` (renamed workspace package).
- `npx expo config --type public` shows `name: Niaro`, `slug: niaro`, `scheme: niaro`, the `dev.niaro.app` ids and the new microphone text, whether or not `AUDIO_SPIKE` is set.
- `EXPO_NO_DOTENV=1 npx expo prebuild --clean --platform android --no-install`. Then check that `android/app/build.gradle` has `applicationId 'dev.niaro.app'` and the manifest has `android:scheme="niaro"`. Do the same for iOS (`CFBundleURLSchemes`).
- Device or emulator journey: install the Niaro build next to the old app, sign in through the browser (the code returns through `niaro://auth`), connect a personal service (it returns through `niaro://service-connected`), and record a short meeting. Check the launcher label "Niaro" and the microphone prompt text.
- UI check, EN and CS at 1440 px and 390 px: console brand mark and tab title, the `/account/login` heading, and **Register Niaro** on a service.
- Grep guard: `rg -i "agent client|agentclient|agent server" --glob '!openspec/**' --glob '!node_modules/**'` returns only the D3 identifiers, the fixture files left for NIAR-240, and the release note text.

## Open questions for the owner

- Final application id: `dev.niaro.app` is the default. If the company prefers its own reverse domain (for example under the owning company's domain), it must be decided before the first store publication. Changing it later means another reinstall.
- Czech sign-in heading: "Niaro – přihlášení" avoids declension. The owner may prefer "Přihlášení do Niara".
- Whether to also rename the Kotlin package `dev.agentclient.meetingnotification` (D3). The default is no.
