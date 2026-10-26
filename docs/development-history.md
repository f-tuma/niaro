> Archived development notes. Start with the current [README](../README.md) and [self-hosting guide](self-hosting.md).

# Agent Client — workflow demo

Expo / React Native client for a compatible server, implemented against the v0.2 plan. This delivery is a **test prototype**, not a production beta. The default fixture is deterministic; an optional server-side OpenRouter integration interprets natural-language requests, and an optional Twenty adapter reads TEST-prefixed contacts from a real CRM. Meeting participants can come from the built-in demo directory or verified TEST contacts in CRM. Whisper or explicitly configured Gemini via OpenRouter transcribes recorded requests and replies, sending usable text automatically and offering uncertain recognition for review. The optional local Radicale integration writes real test calendar events without invitations. One-use server pairing and expiring authenticated sessions are implemented.

The server owns work, questions, action proposals and operations. Chat and Tasks share their IDs, components and command layer. Selecting a contact prepares a meeting proposal; only explicit confirmation of its reviewed revision starts an operation. The default fixture simulates it; the configured CalDAV fixture creates and verifies a real test event.

## Current interface

The UI follows the original light mobile references, with a fixed compact header, bottom navigation and a composer above the keyboard. **Questions, contact choices, proposals and their edits stay directly in the main chat.** Choose a contact in one tap; extra contacts and technical details expand in the same card. Tasks and Meetings are summaries that return to the corresponding live card in Chat. The `+` button focuses the composer; Plan a meeting prefills an editable request without sending it. More contains pairing, connection information and language preferences. Once connected, use **Change connection** to show pairing fields again.

Navigation and filters have a sliding selection indicator; buttons give subtle press feedback and content enters with short transitions. The system's reduced-motion preference is respected, including changes while the app is open. Header controls, counters and composer actions share consistent alignment. Long details are grouped with labeled icons and optional explanations expand on demand. Participant, time, calendar and the effect being approved stay visible.

Tap the microphone to replace the text input with recording **inside the same composer**. The bubble keeps its glass background, dimensions and spacing. A soft blue–sky–white shader gradient repeats twice around its outside, with gently changing color spans. The outline fades in and the curve unfolds over 550 ms; three standing wave layers span the available width. Web uses actual low/mid/high speech-band energy; native currently uses recorder amplitude with the same visual layers. Quiet speech is visually amplified; silence stays still. Preparation unfolds the curve and transcription animates it without visible loading text. Errors appear in a separate toast above the bubble, with retry in the existing round button. Reduced motion and a graphics fallback are supported.

Recording normally finishes after speech followed by **1.8 seconds of silence**, or by tapping Done. A two-minute maximum is a fallback; initial silence is discarded after ten seconds of valid metering. The endpoint detector adapts to ambient noise; missing readings or a stalled JS thread never count as sustained silence. This is still an energy heuristic, and changing/loud noise can require Done. Usable transcripts send automatically; uncertain/repeated/limited transcripts stay editable. Cancelling preserves a typed draft. Header microphones open the same inline flow. Voice uses the same conversational context as text; **Reply in chat** targets an explicit question. Siri, wake phrases and background listening remain future work.

Paired proposal actions fill the card width equally. Sign out and Reject use a soft red destructive variant.

Meeting cards show the current participant, date, start time with the device's timezone and duration from structured proposal fields. After a conversational correction, the single live card appears beside the latest linked assistant reply; earlier replies retain their historical text. The live card exposes its short summary and actions in place. Restoring the conversation does not resubmit anything. Technical UTC timestamps remain available in its expandable details.

Editing uses native Android date/time dialogs and compact iOS UIDatePicker controls; the web build uses the browser’s date/time inputs. Values use the device timezone shown beside Time, with the existing UTC protocol unchanged. Picker selection only updates the local draft; Save requests a revised server proposal. Cancellation and Android Back preserve the draft. iOS system localization includes EN/CS; system dialog formatting follows device/browser settings. The new `@react-native-community/datetimepicker` 9.1.0 dependency requires rebuilding an older development client with `npm run android` or, on macOS, `npm run ios`. The emulator build has already been updated.

Continuous chat and picker verification: **395 tests / 50 suites**, lint/types, all-platform JS and Storybook exports; EN/CS browser walkthroughs at 320/393/1001 px; actual Android system date/time selection, cancel/Back and revision-safe saving on a synthetic server. No paid model calls or external CRM/calendar writes. iOS native compilation and device interaction remain unverified.

Transcript review has its own 16-point padding: the heading, editable text, explanation and full-width Send text button share a left edge. Discard sits beside the heading on the right. The editor shows whole lines and scrolls longer text; the recording bubble keeps its original geometry.

The active development preview is [localhost:8085](http://localhost:8085), with the existing local backend on 8793. Start it with `npm run web -- --port 8085` and `npm run server -- .servers/current.json` using the existing private profile (see server profiles below). The default commands below still use ports 8081/8787. Web reload still requires pairing; native sessions persist until expiry.

While a model request runs, chat displays a compact **Working on it** checklist: understanding the request, an actual CRM lookup when applicable, and preparing the result. Completed steps show checks; the active step has a rotating ring (static with reduced motion). A lost status connection is marked unconfirmed, without replaying the request. The result replaces the progress card. Restart the backend after updating to enable the optional [activity endpoint](../docs/protocol.md#request-progress-optional-agent-activity1-2-and-3); no database migration or new dependency is needed. The deterministic fixture may finish too quickly to show intermediate stages.

Recognition review is conditional; the agent still asks for missing information or ambiguous matches after submission. Calendar approval remains separate. Sent text appears in chat immediately while the existing progress card tracks the request. Cancellation before handoff prevents late submission; a sent command continues under the normal session and exact-command retry rules.

The current opt-in Gemini delivery passed **295 tests / 42 suites**, clean lint/types, all-platform and Storybook exports, actual FFmpeg/Silero WAV/WebM/AAC checks and local Whisper regression. A synthetic Czech browser microphone completed silence stop → Gemini → automatic message → correct unapproved meeting proposal, without duplicate replay; English AAC transcription also passed. EN/CS settings identify the cloud service at 320/393/1001 px. The running 8793 test backend now uses Gemini; no calendar or CRM was changed by these tests. Physical microphone accuracy is still unverified, and the Czech sample changed Peter/Petr without a review warning.

The preceding voice reliability delivery passed **268 tests / 39 suites**, lint/types, all-platform exports and real local speech/noise checks. A Chromium synthetic Czech microphone recording passed automatic silence stop → Whisper → real OpenRouter → reviewed TEST proposal → real isolated Radicale event → visible verified result. Replaying the same command made no extra model call or proposal. Test calendars were removed; existing work and CRM were untouched. The separate Czech quality corpus remains **FAIL: 12/20**, including five unreviewed critical-term mismatches. These are lexical mismatches, not five demonstrated wrong calendar actions. Physical microphone accuracy is unverified. See [voice measurements and reproduction](../docs/voice-quality.md).

The preceding UI delivery passed **262 tests / 38 suites**, lint/types, all-platform and Storybook exports. Chromium checks cover EN/CS at 320/393/1280 px, shared composer geometry, the outer border, real microphone analysis with synthetic audio, silence endpointing, auto-send, conditional review, an external error toast, cancellation, retry and GPU loss fallback. Android API 37 checks cover shader rendering, recording, cancellation, Back and background interruption; the development APK was rebuilt with Expo GL. Real local Whisper accepted a synthetic recording longer than 20 seconds and rejected one longer than 120. No paid model call or external calendar/CRM change was made by those UI checks. Physical speech/noise accuracy and iOS device behavior remain unverified.

The request-progress delivery passed **228 tests / 34 suites**, lint/types, all-platform and Storybook exports. Browser QA covered EN/CS at 320/393/1280 px, actual server-stage transitions using controlled synthetic adapters, animated/reduced motion, unavailable status recovery and failed requests. No real CRM write, paid model request or calendar operation was made for this delivery. Native device behavior was not retested.

An expired session shows a single compact toast, **Session ended · Sign in**, with balanced 20-point visual insets. Sign in opens the existing pairing screen; the full explanation remains available there and to screen readers.

UI checks and reference comparison: 169 tests, EN/CS browser checks at 320/393/1280 px, Android emulator keyboard/navigation checks, and web/iOS/Android + Storybook exports. Meetings shows verified existing calendar events; meeting recording remains unavailable.

The subsequent motion/readability pass passed **174 tests / 26 suites**, lint, types, web/iOS/Android and Storybook exports. Browser checks cover animated/reduced motion, precise alignment at 320/393/1280 px, fixed regions during scrolling, EN/CS question selection and synthetic audio through local Whisper to reviewed text. Android emulator checks cover detail disclosure, Back, voice entry and microphone/send placement above the keyboard. No calendar operation was created by these UI checks.

## Run locally

Use Node **22.13+** (verified with 22.23.2), npm and the checked-in lockfile. Commands assume a POSIX shell and the repository root.

```sh
npm ci
```

In separate terminals:

```sh
npm run fixture
```

```sh
npm run web
```

Generate a one-use pairing code in another terminal (same `FIXTURE_DATA_DIR` as the server):

```sh
npm run fixture:pair -- demo-user a
```

Open <http://localhost:8081>. In More → Connection, enter `http://localhost:8787/v1/a`, paste the code into Pairing code and choose Pair with server. The code expires in five minutes and can be used once. The development scripts explicitly allow HTTP only for loopback/private IPv4 destinations. Normal exported application code requires HTTPS.

1. On a fresh install the interface is English. More → Čeština persists the manual choice across reloads; existing server messages keep their original language.
2. Send `Choose Peter` or `Schedule a meeting with Peter next week` (CS: `Naplánuj schůzku s Peterem příští týden`). The server returns a question with two synthetic contacts.
3. Open Tasks → Needs input and tap the summary card. Its detail displays the same question as Chat. The question remains on the server when the client closes. Mobile restores an unexpired session; web reload requires a new code for the same account.
4. Select a contact and send the form, **or** choose Reply in chat and send `Choose Peter Novák` / `Choose Peter Svoboda` (CS: `Vyber Petera Nováka` / `Vyber Petera Svobodu`). These are explicit demo phrases, not general language understanding.
5. Server validation resolves the contact question and prepares a meeting proposal after four seconds. It appears in Chat and Tasks → Needs input. Review the recipient, date, start/end time in UTC, server and revision.
6. Edit details to change the participant or UTC date/time. Save new proposal, then review the current version. Previous confirmation cannot authorize new details. Confirm this meeting starts a pending simulated operation; later server events show execution and completion. Reject proposal closes the work. **No calendar event or email is created.**
7. A pending approved operation can be revised before execution; its old attempt is cancelled and new consent is required. Once execution starts, changes are refused instead of silently altering approved parameters.
8. After uncertain delivery, Retry sends the exact saved command ID/payload. Reopening or rendering never automatically resubmits a business command.

`/v1/b` requires a code issued for workspace B: `npm run fixture:pair -- demo-user b`. A's token cannot read or write B. A second user such as `reviewer` has separate work even at the same URL. Switching stops the previous session and clears local drafts; re-pairing into the same account restores its server work.

Sessions last 30 minutes by default. Native credentials use SecureStore; web credentials last only until reload. Sign out and forget session removes the local credential and requests server revocation. No automatic refresh or business-command resend occurs. See [pairing design and limits](../docs/adr/006-server-pairing-and-session.md).

The current wire profile is `agent-client/0.4-fixture`; update/restart client and server together and pair again. The server preserves older work while adding [typed contact results](../docs/protocol.md#contact-results-profile-04). Pairing is a separate `agent-pairing/1` contract. Older anonymous fixture files and client caches remain untouched but are not exposed through authenticated accounts. See [approval semantics and limits](../docs/adr/005-revision-bound-demo-approval.md).

## Web administration

The local reference server now serves a separate administration at **http://localhost:8793/admin/**. It shows configured services, model/voice metadata, access expiry, and actual registered tools with their permissions. The developer console uses TanStack Router/Query, shadcn, Tailwind v4 and Vite. It includes responsive tables, real detail routes, search, refresh, separate administrator login and a Settings page for EN/CS. Instance adapters still use the server profile. Organization accounts now have workspace-owned Twenty TEST-read connections with encrypted write-only keys, explicit per-tool role grants and a manual read test. Trusted CRM origins are configured by the instance operator. **Better Auth 1.7.6 now provides local account sign-in, organization roles and explicit workspace membership**, with real Accounts and Workspaces pages. First-owner setup requires the recovery key. Workspaces now issue one-use app pairing codes for the signed-in account. Select **Use in chat** on one workspace CRM to expose only its permitted tools to the agent. **Only organization owners/admins** select workspace models and speech recognition profiles in **Models & voice**. The instance operator publishes available profiles; keys, budgets and routing stay server-side. Both workspace selections default off, including previously globally opted-in workspaces after upgrade. See [AI configuration and migration](../docs/server-admin.md#workspace-models-and-speech-recognition). No global CRM/calendar credential is inherited. Existing demo pairing stays separate. OAuth/OIDC remains upcoming. See [account pairing](../docs/server-admin.md#pair-an-app-with-an-account-workspace). Owners and admins now have an **Audit** page for configuration/access changes and scoped tool outcomes from the console and chat, with workspace/result filters and pagination. Records contain metadata only; see [coverage and limits](../docs/server-admin.md#audit-records).

Build with `npm run admin:build`, enable the optional `administration` profile section, and issue an operator key with `npm run server:admin-key -- <profile.json>`. The current development instance is already enabled; its initial recovery copy is `.servers/admin-backup-key.txt` (owner-only, ignored). See [setup, rotation and boundaries](../docs/server-admin.md). Restart the backend after rebuilding administration assets. For accounts, configure `administration.identity` as described in the setup guide; then use **Accounts** with the recovery key to create the first owner and organization.

## Configurable servers

The reference launcher keeps all interpretation, workflow, memory and integration logic on the server. An operator-owned JSON profile selects the instance name, data directory, local port, session lifetime and built-in model/voice/CRM/calendar adapters. The unchanged app renders the same typed cards for every instance. Private integration files remain server-side; a profile never supplies executable UI or inline credentials.

```sh
npm run server:check -- servers/personal.json
npm run server -- servers/personal.json
# Another terminal; pair the app to http://localhost:8794/v1/a:
npm run server:pair -- servers/personal.json demo-user a
```

`servers/team.json` provides a second isolated instance on 8795. Both examples use the deterministic meeting workflow without paid providers. The existing development assistant now uses the private `.servers/current.json` profile on 8793 with its original data and adapter settings: `npm run server -- .servers/current.json`. Stop the previous backend first. `npm run server:pair -- .servers/current.json calendar-user a` restores the existing account.

[Profile format, adapter options and extension points](../docs/server-profiles.md). The server now owns a typed [tool registry and TEST-contact matching](../docs/server-tools.md); the client keeps its existing cards and commands. **370 tests / 47 suites** pass, including server isolation, permission/input validation, contact ambiguity, restart, replay and stale results. Browser QA covers CRM cards → meeting proposal → time correction → contact selection in EN/CS at 320/393/1001 px. No paid calls or external writes were used for this delivery. Arbitrary MCP tools, production permissions and a web configuration builder remain future work.

## Natural-language requests and TEST CRM contacts

The configured backend uses `openai/gpt-4.1-mini` through OpenRouter. Try `Set up a meeting with Peter Novák tomorrow at 14:00 for 45 minutes.` Missing date/time produces a clarification; ambiguous Peter opens the existing contact picker. Times are interpreted in `Europe/Prague`, converted on the server, and displayed as **UTC in the approval details**. Nothing executes until the current proposal is explicitly confirmed. Unsupported actions receive a short explanation.

The server now keeps one active meeting context per account/workspace for **30 minutes of inactivity**, including partial contact/date/time/duration facts, across restart. Try `Set up a meeting with Peter Svoboda.` → `Tomorrow.` → `At eleven thirty for 45 minutes.` → `An hour later.` Follow-ups revise the same unapproved proposal; `with the other one` can resolve its contact choices. An explicitly new meeting starts with empty fields. Changing the topic clears conversational focus without cancelling stored tasks. `Move the last meeting an hour later.` explicitly recalls the most recently created task, including older drafts; approved/completed tasks remain locked. Manual card edits take precedence over remembered facts. This is bounded meeting context, not general long-term memory or a search across arbitrary older tasks. See [ADR 011](../docs/adr/011-conversation-memory.md).

Restart the configured backend to enable memory (`npm run fixture:gemini` retains the current cloud transcription). Stop the previous backend first and back up the complete `.fixture-calendar` directory. No client rebuild or public protocol bump is required; existing stored work loads with an optional private memory field. Do not open extended state with an older server binary. `npm run test:memory` is an **opt-in paid** synthetic 13-message evaluation using the existing key, expiry and shared budget; it has no calendar/CRM adapter. Ordinary `npm run check` uses controlled models and makes no paid calls.

Memory verification: **327 tests / 43 suites**, lint/types clean; a real 13-message CS/EN model sequence passed partial requests, restart, corrections, contact ambiguity, topic reset, midnight rollover and exact-command replay (13 paid calls, API-reported $0.003410, zero external operations). Browser checks at 393×852 CS and 1001×1037 EN verified one updated proposal and current details. Earlier exploratory model failures led to a simpler structured response contract and a server guard for ambiguous bare Peter; this small successful sequence is not a general accuracy guarantee. Gemini ASR and native UI were unchanged.

`Show me the test contacts from the CRM.` reads the real Twenty workspace and displays up to five TEST contacts as native catalog cards. Each card is assembled by the client from validated name, role, primary phone and email fields; missing/invalid optional values are omitted. The UI handles empty results and long values, supports EN/CS, and lets the user select text. The model does not compose these fields or the card layout. Runtime CRM access is GET-only: no edits, deletion, email sending, or model-selected URLs/queries. One synthetic person, **TEST Agent Client 2026-09-24**, was created and re-read for the original verification; existing CRM records were not modified. It has no phone/email, so those rows are absent. A TEST contact with a valid email can now become a proposed meeting participant. Try `Set up a meeting with TEST Jana Example tomorrow at 14:00.` using a name that exists in your test directory, or refer explicitly to a recently shown contact. The server resolves the name, asks for a choice on ambiguity, and uses the CRM email. Missing email or an incomplete directory prevents automatic selection. The original TEST item has no email, so it cannot yet produce a meeting proposal; the app does not fabricate one. Existing records are not modified automatically.

The contact-card delivery passed **210 tests / 31 suites**, lint/types, web/iOS/Android and Storybook exports, and EN/CS browser checks at 320/393/1280 px. Complete, missing, empty, multiple and long results plus snapshot restoration were exercised with synthetic fields; restoring cards causes no CRM call or operation. Earlier text-only CRM replies remain unchanged.

Credentials live only in ignored, owner-only `.openrouter/config.json` and `.twenty/config.json`; see [configuration examples and boundaries](../docs/adr/010-model-and-test-crm.md). The user reauthorized the existing OpenRouter key on September 25. Its current local test window ends at **2026-09-26 00:00 Europe/Prague**, with the same model and persistent **100-request cap per window**, shared by the server and evaluation script, including failures. Previous-window usage is retained. Three live requests verified local Whisper → automatic submission → OpenRouter, Czech clarification and an unapproved meeting proposal; replay made no additional model call. The separate Twenty test window remains expired since September 25 midnight. Expiry blocks new requests locally; it does not revoke remote keys.

```sh
# After calendar/voice setup; stop another backend using the same data directory first:
npm run fixture:integrations
# Other terminal:
npm run fixture:calendar:pair
# Pair to http://localhost:8793/v1/a (Android emulator: http://10.0.2.2:8793/v1/a)
```

`npm run fixture:ai` enables the model without CRM. `npm run test:models` makes 20 paid API calls using synthetic scenarios and writes a private evaluation report. `npm run test:crm` only reads TEST records. The separate `npm run test:crm -- --create-test` command can create the fixed TEST person if absent; it must not be blindly retried after an uncertain response.

Final verification: **203 tests / 29 suites**, lint/types, web/iOS/Android and Storybook exports. Real browser checks passed natural-language proposals, clarification after a CRM query, real TEST contact retrieval, 320/393/1280 px layouts, and **zero operations**. Both evaluated models passed 10/10 synthetic scenarios; this small sample is not a general accuracy guarantee.

## Voice requests and replies (Whisper or Gemini)

After [Radicale setup](#local-radicale-calendar), install the optional local transcriber and start the combined backend instead of `fixture:calendar`:

```sh
npm run voice:install          # CMake/C++/Git/curl/FFmpeg; pinned small (~488 MB) + Silero VAD (~0.9 MB)
npm run fixture:voice          # same .fixture-calendar data and port 8793
# Other terminals:
npm run fixture:calendar:pair
npm run web -- --port 8085
```

Pair to `http://localhost:8793/v1/a`. Use **microphone → speak → silence (or Done)** for a new request. To answer an existing question, select its card’s **Reply in chat** first. Audio uploads after speech and silence, Done, or the two-minute maximum; usable text sends automatically. A low-confidence/repeated/limited transcript stays editable and requires **Send text**. Failed transcription offers an explicit retry. Calendar confirmation remains separate. EN/CS follows More → Language.

Restart both server and client for the optional **`agent-voice/4`** extension; the workflow remains `agent-client/0.4-fixture`, with no data migration. An older voice extension is shown as unavailable. The shader adds SDK-compatible `expo-gl ~57.0.2`. Run `npm install` and rebuild the development APK with `npm run android -- --no-bundler` for native GPU rendering. Older native builds retain the non-GL visual fallback. If the permission dialog interrupts the app, press Start recording again after granting access.

The local quality gate uses Whisper token probabilities, repetition detection and recording length. These are **heuristics, not calibrated confidence or a correctness guarantee**. Unannotated provider responses always require review; the Gemini adapter supplies its own warning heuristics, described below. Silero VAD filters non-speech before Whisper; rerun `npm run voice:install` and restart the backend to install its pinned model. No protocol change or native rebuild is needed for this addition. `npm run test:voice` uses synthetic eSpeak audio through real FFmpeg/Whisper and checks correction of contextual replies, malformed/silent/cancelled input and rejection of pure tone/noise. Synthetic EN/CS names still needed correction and were flagged uncertain. The optional [Czech evaluation](../docs/voice-quality.md) reports remaining unreviewed transcription errors; physical Czech/English speech quality is unverified.

With the default Whisper engine, audio stays on the connected server. With `npm run fixture:gemini`, speech recordings are sent as mono 16kHz WAV to **Google Gemini 3.1 Flash Lite through OpenRouter**, after local FFmpeg validation and Silero speech detection. The voice model is fixed separately from the text agent (`openai/gpt-4.1-mini` in the current test configuration). More → Speech recognition discloses the active engine and processing location in EN/CS. This opt-in uses the same private `.openrouter/config.json`, expiry and persistent request budget as the text agent; a spoken request normally consumes two calls. Cloud errors do not silently switch providers or retry. Use `npm run fixture:ai` to explicitly return to local Whisper. Temporary audio is deleted on normal completion/cancel; a crash may leave files. No TTS or background listening is implemented. [Runbook, protocol and measured limits](../docs/adr/009-local-voice-question-reply.md).

Gemini returns no calibrated confidence score. Unintelligible markers, strong repetition, an unusually short result for at least 15 seconds of detected speech, or reaching the recording limit require review; other usable text sends automatically. These checks can miss incorrect names or numbers. The existing 120-second safety limit, silence stop, cancellation and inline waveform UI remain unchanged. `npm run test:voice:gemini` runs actual FFmpeg/Silero on synthetic WAV, WebM and AAC with a fake cloud response, and proves non-speech, malformed media, cancellation and duration limits do not reach the provider. It makes no paid requests.

An optional **synthetic-only paid ASR benchmark** now compares Callout's `google/gemini-3.1-flash-lite` with the local baseline. The benchmark itself never changes the running app; cloud voice is selected separately with `fixture:gemini`. In one shared 20-case corpus, Gemini with a stricter prompt and local speech gate passed 16 cases versus Whisper's 12; the original Callout prompt passed 11 and hallucinated text for non-speech. Both configurations still have quality failures. See [results, cost, reproduction and remaining work](../docs/voice-quality.md#callout-gemini-comparison--september-25-follow-up). `npm run test:voice:openrouter -- <synthetic-manifest> callout|guarded` consumes the existing private OpenRouter request budget; it never sends workflow commands. The follow-up passed 272 tests / 40 suites and script type checks.

## Local Radicale calendar

The real test integration runs on the **server**, with credentials kept in ignored, owner-only `.radicale/client.json`. It uses its own `.fixture-calendar` data directory and the `calendar-user` / A scope. The original default fixture remains simulated.

```sh
npm run calendar:install       # isolated Python venv; pinned Radicale 3.8.0
npm run calendar:setup         # preserves existing credentials and data
npm run calendar:start        # terminal 1: loopback-only 127.0.0.1:5232
```

```sh
npm run calendar:init         # terminal 2: create the test collection once
npm run fixture:calendar      # terminal 2: app backend on 127.0.0.1:8793
```

```sh
npm run fixture:calendar:pair  # terminal 3: one-use code for calendar-user / a
```

In the app, pair with `http://localhost:8793/v1/a`. The dedicated web preview can run on [localhost:8085](http://localhost:8085):

```sh
AGENT_CLIENT_DEVELOPMENT=1 EXPO_PUBLIC_ALLOW_INSECURE_FIXTURES=1 npx expo start --web --port 8085
```

The existing contact → proposal flow now displays **Agent Client Test**, the calendar URL and the real write effect before confirmation. No attendees or invitation emails are sent. Completion requires reading back the exact event. Lost replies, crashes and manual **Check the same calendar event** reuse its stable identity. Failed verification remains visibly unknown. Old simulated proposals never become calendar writes after enabling the integration.

`npm run test:calendar` runs the real Radicale lost-response/crash/restart checks in its own temporary calendar, then removes that test calendar. The user-facing calendar and reviewed event are retained. For setup details, scope isolation, protocol migration and limits, see [ADR 008](../docs/adr/008-local-caldav-integration.md). CalDAV was introduced in profile 0.3; the current profile 0.4 also adds CRM cards. Restart server/client and pair again after updating an older client. Android emulator can reach the backend at `http://10.0.2.2:8793/v1/a`; the server alone talks to Radicale. Stop services with Ctrl-C; no boot-time service was installed.

## Development builds and phone addresses

The normal mobile path is a development build, not an Expo Go compatibility claim. Install the native SDK/toolchain and use:

```sh
npm run android
# macOS with Xcode:
npm run ios
```

The native commands first regenerate the ignored `android/` or `ios/` project from Expo config. Keep native customizations in config/plugins; generated native edits are not preserved. This also selects the correct normal/audio package when switching variants.

For an already installed development build, run `npm start`. To make the fixture reachable from a phone on the same trusted LAN:

```sh
FIXTURE_ALLOW_LAN=1 npm run fixture
```

Android emulator verification on this workstation used SDK `~/Android/Sdk`, AVD `droid` (Android 17 / API 37, x86_64, 16 KiB pages), JDK 17 and KVM. The SDK tools exist even when `adb`/`emulator` are absent from PATH. The development APK built and installed successfully; Metro loaded the React Native/Fabric `main` entry. To keep the native preview separate from web port 8081:

```sh
npm start -- --port 8084
# In another terminal, with the emulator running:
npm run android -- --port 8084
```

The native ADB walkthroughs passed one-use pairing, SecureStore session restoration, sign-out surviving restart, connection, a shared Chat/Tasks question, required-contact validation, proposal review, explicit approval, separate pending/completed operation states, and Czech persistence after a cold restart with the same operation restored. It also found and fixed an Android keyboard overlap: the screen now reduces its height while typing; scroll the composer to reveal Send when needed. Meetings remains an explicit placeholder. These results cover this emulator and local synthetic fixture; physical devices, iOS and microphone behavior still need verification.

`npm run android -- --no-bundler` also builds/installs using an existing server, but Expo does not allow combining `--no-bundler` with `--port`. The generated APK is `android/app/build/outputs/apk/debug/app-debug.apk`; generated native projects remain ignored. `expo-system-ui` supplies the configured light appearance.

For the local fixture without LAN binding, an emulator can use `http://10.0.2.2:8787/v1/a`. Alternatively, `adb reverse tcp:8787 tcp:8787` makes the app's default `http://localhost:8787/v1/a` reach the host fixture. A reverse mapping for port 8084 can similarly expose Metro. These mappings last only for that connected device; they do not prove physical-device networking.

In More, enter `http://<computer-private-IPv4>:8787/v1/a`, for example `http://192.168.1.20:8787/v1/a`. **localhost on a phone points to the phone.** Android emulator commonly reaches the host at `10.0.2.2`; iOS simulator on the same Mac can use localhost. Check host firewall/network routing if connection fails. LAN binding is opt-in and this server contains synthetic data only.

The development build config allows Android cleartext and iOS local networking only when `AGENT_CLIENT_DEVELOPMENT=1`; the UI also requires `__DEV__` and `EXPO_PUBLIC_ALLOW_INSECURE_FIXTURES=1`. Native networking/ATS behavior on physical devices is not verified here. Do not turn this into an unrestricted release exception; use HTTPS for a real backend.

## Persistence and reset

The server stores authenticated workflow state in `.fixture/workflow.sqlite`. SQLite commits the snapshot, scheduled jobs, ordered events and command receipts together. A process crash before commit leaves the previous state; a crash after commit preserves events for polling and receipts for an explicit retry. Overdue demo work resumes after restart without a connected client. See [transactional storage and crash verification](../docs/adr/007-transactional-workflow-storage.md).

Before upgrading from JSON storage, stop the old server and back up the **whole** data directory. First startup imports all `authenticated/<user>/<workspace>.json` accounts in one transaction and leaves the source files unchanged. Invalid data aborts startup so it can be repaired and retried. After successful import, SQLite is authoritative and the old files are never imported again. Anonymous `.fixture/a.json` and `.fixture/b.json` remain untouched and unassigned. Do not run an older JSON server against the migrated directory.

Use a local disk. A data directory permits one HTTP server; a second server or reset while it is running is refused by an OS-held lock that is released even after SIGKILL. Auth pairing/session files retain their separate persistence model. Workflow storage is still an unencrypted synthetic fixture, not a production identity, retention or external-effect system. The retained event suffix is 1,000 events; older cursors require a snapshot. Receipts are never pruned; the 2,000-receipt stop was removed in October 2026 (NIAR-25): the engine loads the newest 500 and looks older ids up in the table.

To back up or restore, stop the server and copy the entire directory, including auth identity and any SQLite WAL/SHM files. Do not delete a lock file or remove only `workflow.sqlite`. Node 22 emits an expected experimental warning for its built-in SQLite API; no extra dependency or native app rebuild is needed.

Stop the fixture server before resetting:

```sh
npm run fixture:reset
npm run fixture
```

Reset **renames** `.fixture` to a timestamped backup; it does not delete it. `FIXTURE_DATA_DIR=/path` chooses another directory and must also be passed to reset. Use a new endpoint/port or clear this demo application's local site/app storage when resetting server identity; the client intentionally refuses a snapshot that moves its cursor backwards. Do not use this cache for real personal data.

Environment options: `FIXTURE_PORT` (default 8787), `FIXTURE_DATA_DIR`, `FIXTURE_SESSION_SECONDS` (30–3600, default 1800; use 30 for expiry QA), `FIXTURE_ALLOW_LAN=1`, and comma-separated `FIXTURE_ALLOWED_ORIGINS` for a specific alternate web preview origin. Default browser origins are localhost:8081/8082 and 127.0.0.1:8081. There is no wildcard CORS.

## Component catalog

```sh
npm run storybook:web
# or an installed native development build:
npm run storybook
```

Web catalog: <http://localhost:8082>. `Input/InputRequestForm`, `Work/WorkItemCard`, `Work/ActionApprovalCard`, `Connection/Pairing`, and `Foundation/Controls` use the same components and fixture factories as the app/server. States include EN/CS, long text, required selection, sending, network error, conflict, stale, resolved, running and completed. Approval stories also cover changed revisions, rejection, pending/executing operations, failed and unknown results. Select a story in the sidebar. Sending in a story is a passive demonstration callback; it does not contact a server.

Storybook has a separate entry point selected only by `STORYBOOK_ENABLED=true`. Restart Metro when changing entry modes. Its optional channel/MCP server is disabled in these scripts. Generated story imports are recreated before lint/typecheck and by Storybook.

## Checks

```sh
npm run test:calendar          # real local Radicale required; temporary collection is cleaned up
npm run check                  # lint, boundary rules, types, 26 Jest suites (174 tests)
python3 -m unittest discover -s scripts/audio -p 'test_*.py' -v  # 10 emulator-harness tests
npx expo install --check       # compare installed dependencies with Expo SDK
npm run build                  # JS/asset exports for web, iOS and Android
npm run storybook:export       # separate web catalog export
AUDIO_SPIKE=1 npx expo export --platform all --output-dir dist-audio
```

An Expo export is **not** an APK/IPA, device launch, microphone test, or successful native dependency build. The GitHub workflow is prepared but has not run remotely in this workspace.

## Isolated audio test

Build it with `AUDIO_SPIKE=1 npm run android -- --port 8083`, or start Metro for the installed audio app with `npm run audio:spike`. Its package and development link are distinct from the main app. It records locally after explicit permission, stops on background/lock, offers manual playback and restores the last finalized file. EN/CS is supported. Android emulator tests include a decodable 29.768-second recording and saved-file restart; physical microphone quality, iOS, Bluetooth and long production recording remain unverified. A 30-minute foreground emulator run also passed full decoding and restart, but exposed +102.80 MiB process PSS growth for further profiling. A pending journal is written before capture. After force-stop, discovered files can be checked and explicitly recovered; unreadable files remain on disk. A 4.760-second recovered portion was fully decoded and played in the emulator. See the [audio runbook](../spikes/audio/README.md) and [ADR 003](../docs/adr/003-audio-emulator-spike.md) and [recovery ADR 004](../docs/adr/004-audio-recovery-journal.md).

Follow-up memory profiling separated idle/development/release behavior and moved timer updates into a small recorder-status component. Development native heap growth fell from 13.53 to 1.49 MiB in matched 60–300-second windows. The short release comparison did not establish improved native memory. A subsequent 30-minute standalone release run passed full decode, cold-start restoration and manual playback: 1799.99 seconds / 20.90 MiB. Process PSS increased by 8.92 MiB overall with repeated decreases and no net growth in its final ten-minute window. This single emulator run does not establish long-term physical-device stability or prove a leak fix. That audio delivery passed 84 application tests, lint and types; the current project passes 174 tests, including transactional persistence, CalDAV behavior and UI motion.

## Source map

| Directory                                 | Responsibility                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/mobile`                             | Four sections: Chat, Meetings placeholder, Tasks, More                                     |
| `apps/fixture-server`                     | Workflow, SQLite storage, pairing and server-side CalDAV integration                       |
| `packages/protocol`                       | Strict runtime schemas, versions and scope identities                                      |
| `packages/client-core`                    | Authenticated connections, scoped store/cache, revisions/cursors, commands and preferences |
| `packages/design-tokens`, `packages/ui`   | Semantic light theme and shared primitives                                                 |
| `packages/ui-catalog`                     | Validated WorkItemCard, InputRequestForm and ActionApprovalCard                            |
| `packages/i18n`, `packages/test-fixtures` | EN/CS catalogs and synthetic data                                                          |
| `.rnstorybook`, `tests`, `spikes/audio`   | Component examples, tests, isolated audio investigation                                    |

Read [the minimal protocol](../docs/protocol.md), [technical decisions](../docs/adr/001-text-slice.md), [dependency choices](../docs/adr/002-runtime-and-catalog.md), and [audio test path](../spikes/audio/README.md). The existing v0.2 specification and reference images remain the product/design source.
