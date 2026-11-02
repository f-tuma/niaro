# Proposal

Itsaplan: NIAR-241.

## Why

The product is called Niaro, yet the phone app installs as "Agent Client". The web console's brand mark, page title and sign-in heading say "Agent Client". Providers show "Agent Server" when Niaro registers as an OAuth client. Browser sign-in returns to the app through `agentclient://`. The repository also still carries the isolated audio spike: a second app variant behind `AUDIO_SPIKE=1` with its own ids, Metro port, Storybook stories, Jest tests, a CI export and Android soak runners. The meeting recorder and voice capture in the real app have replaced it. The pilot allows breaking changes and a reinstall of the phone app. This is the cheapest moment to settle the identity before any store listing fixes the ids for good.

## What Changes

- **BREAKING** The app is renamed to **Niaro**: display name, Expo `slug` `niaro`, URL scheme `niaro`, and new application ids `dev.niaro.app` for the iOS bundle and the Android package (previously `dev.agentclient.demo`). Devices treat this as a new app. The old "Agent Client" app stays installed until it is removed, and it does not hand over its stored sign-in, preferences or unsent meeting audio.
- **BREAKING** Browser sign-in returns to the app at `niaro://auth`, and personal service sign-in returns at `niaro://service-connected`. `agentclient://…` is no longer used. The server, the console pages and the app must be updated together. Old builds can no longer finish a browser sign-in against an updated server.
- User-visible "Agent Client" and "Agent Server" are replaced with "Niaro". This covers the console brand mark and page title, the sign-in heading (EN and CS), the microphone permission text, the console button **Register Niaro** (previously "Register Agent Server"), the OAuth client name sent when Niaro registers itself with a service, and the authentication library's application name.
- Developer naming follows: package `niaro`, workspace package `@niaro/server-admin`, environment variable `NIARO_APP_DEVELOPMENT` (previously `AGENT_CLIENT_DEVELOPMENT`), the Expo dev-client link `exp+niaro://…`, and `docs/guides/development.md` (`--scheme niaro`).
- The audio spike is retired:
  - removed: `spikes/audio/`, `AUDIO_SPIKE` in `app.config.ts` and `metro.config.js`, the `audio:spike` script, its Storybook glob, its four Jest files, the CI `dist-audio` export, `dist-audio` ignores, and spike-only i18n keys;
  - removed: the Android soak runners in `scripts/audio/` (`soak.py`, `release_soak.py` and their Python tests) and the CI step that runs them;
  - kept: the voice-quality corpus tools in `scripts/audio/` (`generate_voice_quality.py`, `voice-cases.cs.json`, `voice-evaluation.ts`), because `npm run test:voice:quality`, `npm run test:voice:openrouter` and `tests/voice-evaluation.test.ts` use them;
  - the one shared helper still covered only through spike tests (`packages/audio/stop-recording.ts`, used by meeting capture) gets its own test.

## Non-goals

- Wire protocol and storage identifiers keep their names: profiles such as `agent-client/0.8-fixture` and `agent-pairing/1`, client storage keys `agent-client.*`, the internal `x-agent-client-ip` header, the fixture `WWW-Authenticate` realm, and the Kotlin package `dev.agentclient.meetingnotification` of the meeting notification module. None of them is shown to people. Renaming them would break stored web data or the protocol for no visible gain. NIAR-240 already moves the workflow profile.
- No store listing, icon or splash redesign.
- Fixture-only names (the TEST Twenty contact "TEST Agent Client", the CalDAV `PRODID`) are left for NIAR-240, which deletes that code.
- The meeting recorder QA entry (`spikes/meeting-recorder`, `MEETING_RECORDER_QA`) stays.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `app-pairing`: native apps receive the browser sign-in authorization code through `niaro://auth`.
- `service-sign-in`: after personal sign-in, the page returns to the app through `niaro://service-connected`.

## Impact

- App build: `app.config.ts`, `metro.config.js`, `package.json`, `apps/server-admin/package.json`, `.rnstorybook/main.ts`, `.gitignore`, `.dockerignore`, `eslint.config.js`, `.github/workflows/ci.yml`. The native projects (`android/`, `ios/`, gitignored) must be regenerated with `expo prebuild --clean`.
- Server and console: `apps/server-identity/service.ts` (default app login target, `appName`), `apps/server-integrations/service-oauth.ts` (`client_name`), `apps/server-admin/index.html`, `web/console-shell.tsx`, `web/i18n.ts`, `web/public-account.tsx`, `web/service-auth.tsx`.
- Phone app: `apps/mobile/app-login.ts`, `apps/mobile/ServiceConnection.tsx`, `packages/i18n` (`appName`, spike-only keys).
- Deleted: `spikes/audio/`, `scripts/audio/{soak.py,release_soak.py,test_soak.py,test_release_soak.py}`, `tests/audio-{session,files,recovery,rendering}.test.*`.
- Docs: `docs/guides/development.md`, `docs/guides/administration.md` ("Register Niaro"), `scripts/audio/README.md` (reduced to the voice corpus).
- People: everyone with the phone app installs the new Niaro build and signs in again. Before removing the old app, they let it finish any meeting upload, and they remove the old device from their account page (or let it expire after the idle period). Existing OAuth client registrations at services keep the name "Agent Server" until they are registered again.
- Coordination: lands independently of NIAR-239 and NIAR-240. It shares only single lines with them: the app login target in `service.ts`, and `app-pairing`, where each change edits a different requirement.
