# Tasks

Requirements are referenced as `capability › requirement`, using this change's deltas. Each group leaves `npm run lint`, `npm run typecheck` and `npm test` green.

## 1. Retire the audio spike (no spec change)

- [ ] 1.1 Move the `stop completion event (hasError=…)` cases from `tests/audio-session.test.ts` into a new `tests/stop-recording.test.ts` that imports `packages/audio/stop-recording` directly. Check: `npx jest tests/stop-recording.test.ts`.
- [ ] 1.2 Delete `spikes/audio/`, `tests/audio-session.test.ts`, `tests/audio-files.test.ts`, `tests/audio-recovery.test.tsx` and `tests/audio-rendering.test.tsx`. Remove the `AUDIO_SPIKE` branch from `metro.config.js` and every `audioSpike` conditional from `app.config.ts`, keeping the main app values. Remove the `audio:spike` script, the spike glob in `.rnstorybook/main.ts`, `dist-audio` from `.gitignore`, `.dockerignore` and `eslint.config.js`, and the spike-only keys in `packages/i18n/index.ts` (EN and CS; confirm each with `grep -rnw <key> apps packages`). Check: `npm run storybook:generate`, `npm run storybook:export`, `npm test`, and `rg "AUDIO_SPIKE|audio:spike|spikes/audio|dist-audio"` with no hits outside `openspec/`.
- [ ] 1.3 Delete `scripts/audio/soak.py`, `release_soak.py`, `test_soak.py` and `test_release_soak.py`. Replace `scripts/audio/README.md` with a short note on `generate_voice_quality.py`, `voice-cases.cs.json` and `voice-evaluation.ts` that links to `docs/guides/development.md#voice-qa-tools`. In `.github/workflows/ci.yml`, remove the `unittest discover -s scripts/audio` step and the `AUDIO_SPIKE=1 … dist-audio` export. Check: `npx jest tests/voice-evaluation.test.ts`, and `npm run test:voice:quality -- <manifest>` still starts (corpus tools unchanged).

## 2. One app scheme (app-pairing › Browser consent chooses the workspace; service-sign-in › Personal sign-in from the app)

- [ ] 2.1 Add `APP_SCHEME`, `APP_AUTH_URL` and `APP_SERVICE_CONNECTED_URL` (`niaro`) to `packages/protocol/mobile-access.ts`, and use them in `apps/server-identity/service.ts` (`appLogin` default target), `apps/server-admin/web/public-account.tsx`, `apps/server-admin/web/service-auth.tsx`, `apps/mobile/app-login.ts` and `apps/mobile/ServiceConnection.tsx`. No `agentclient://` remains. Update `tests/app-login.node.ts` (`target` is `niaro://auth`) and `tests/service-connection-card.test.tsx`. Check: `node --import tsx --test tests/app-login.node.ts tests/service-mobile-flows.node.ts tests/service-connect-http.node.ts` and `npx jest tests/service-connection-card.test.tsx`.
- [ ] 2.2 Add a test that an app-login consent for a native start redirects to `niaro://auth` with code and state. Add a Jest test that `app.config.ts`'s `scheme` equals `APP_SCHEME`. Check: both tests pass under `npm run test:identity` and `npm test`.

## 3. App identity and visible names

- [ ] 3.1 In `app.config.ts`, set `name`/`web.name` to "Niaro", `slug` to `niaro`, `scheme` to `niaro`, `ios.bundleIdentifier` and `android.package` to `dev.niaro.app`, and the microphone text to "Allow Niaro to record a voice request or meeting only after you press Record." Rename `AGENT_CLIENT_DEVELOPMENT` to `NIARO_APP_DEVELOPMENT` in `app.config.ts`, the `package.json` scripts and `scripts/mobile-emulator-qa.mjs`, and change its printed dev-client link to `exp+niaro://…`. Check: `npx expo config --type public` shows the new values.
- [ ] 3.2 Rename the package to `niaro` in `package.json` and to `@niaro/server-admin` in `apps/server-admin/package.json`. Check: `pnpm install --frozen-lockfile` and `pnpm admin:build`.
- [ ] 3.3 Console and server copy (design D4): `apps/server-admin/index.html` title, `web/console-shell.tsx` `Brand`, `web/i18n.ts` `loginTitle` (EN "Sign in to Niaro", CS "Niaro – přihlášení"), `service-auth.tsx` "Register Niaro" / "Zaregistrovat Niaro", `packages/i18n` `appName`, `apps/server-integrations/service-oauth.ts` `client_name`, Better Auth `appName` in `service.ts`, `examples/self-hosted/server.local.json` `name`, and the sample labels in `ActionApprovalCard.stories.tsx`, `tests/approval-card.test.tsx` and `tests/chat-work-card.test.tsx`. Update `tests/service-oauth.node.ts` (`client_name`). Check: `npm test`, `node --import tsx --test tests/service-oauth.node.ts` and `pnpm admin:build`.
- [ ] 3.4 Docs: in `docs/guides/development.md`, use `--scheme niaro` and the renamed development variable. In `docs/guides/administration.md`, use "Register Niaro" and add a note that services registered earlier keep the name "Agent Server" until they are registered again. Add the reinstall note to the pilot guide (`docs/guides/pilot.md`): install Niaro, sign in, let the old app finish meeting uploads, remove the old app and its device. Check: `rg -i "agent client|agentclient|agent server|AUDIO_SPIKE" docs README.md CONTRIBUTING.md` returns only the "registered earlier" note.
- [ ] 3.5 UI check, EN and CS at 1440 px and 390 px: console brand mark and browser tab title, the `/account/login` heading, and **Register Niaro** on a service's sign-in settings. Record screenshots in the PR.

## 4. Native build and device journey

- [ ] 4.1 Regenerate the native projects with `EXPO_NO_DOTENV=1 npx expo prebuild --clean --no-install`. Check that `android/app/build.gradle` has `applicationId 'dev.niaro.app'`, that `AndroidManifest.xml` has `android:scheme="niaro"`, and that the iOS `Info.plist` has `CFBundleURLSchemes` `niaro` and `CFBundleDisplayName` Niaro.
- [ ] 4.2 Emulator or device journey (`pnpm android`):
  - the launcher shows "Niaro" next to an installed "Agent Client";
  - browser sign-in completes through `niaro://auth`;
  - a personal service sign-in returns through `niaro://service-connected`;
  - the microphone prompt shows the new text;
  - a short meeting records and uploads.

  Also run `node scripts/mobile-emulator-qa.mjs` with the renamed flag. Record the result on NIAR-241.

## 5. Integration

- [ ] 5.1 Run the full gate: `npm run check`, `npm run test:meetings` and `npm run smoke`. Compare with the known failing set on `main`; the change must not add failures.
- [ ] 5.2 Grep guard: `rg -i "agent client|agentclient|agent server" --glob '!openspec/**'` lists only the identifiers kept in design D3, fixture files left for NIAR-240 and the documented "registered earlier" note.
- [ ] 5.3 Validate the change: `spec openspec --project /home/flamendrin/workspace/niaro -- validate niar-241-retire-audio-spike-rename-niaro --strict`.

## Workflow follow-up

- Release note for pilot users: the new app id, signing in again, finishing meeting uploads before removing "Agent Client", and removing the old device on the account page.
- Optional follow-up issue: rename the Kotlin package `dev.agentclient.meetingnotification` if the owner wants no old name left in native code.
- Archive after review. Archiving does not prove release: the store and pilot rollout is tracked on NIAR-241.
