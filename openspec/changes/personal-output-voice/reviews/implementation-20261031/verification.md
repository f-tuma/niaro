# Personal output voice: implementation verification

Status: root accepts the bounded implementation and rendered-UI checkpoint; publication is recorded separately. Date: 2026-10-31. Tracker: NIAR-255. This is a development checkpoint, not full CI, live provider or release certification.

The implementation adds personal mobile/web output-voice selection through the strict scoped settings resource and existing speech path. It retains acknowledged state until success, supports explicit stale-choice Reset and exact retry after uncertain saves, and leaves playing audio untouched. The mobile composer is centered, removes the separate @ action and its reserved width, and keeps typed references above the input and explicit References under paperclip context.

## Revision and review binding

`source-hashes.json` pins the final22 source/test/command files. S1 protocol/catalogue/store was accepted in commit4e117be; its seven files remained unchanged. `final-source-review.md` independently reviewed the preceding22-file freeze with zero concrete findings. Only the four paths in `visual-repair.patch` subsequently changed. `visual-repair-closure.md` independently reviewed that exact four-file repair with zero concrete findings. The other18 subject files retain their reviewed bytes. Original and final hashes are preserved separately; original review results are not relabelled as execution on changed inputs.

The source findings were fixed and reviewed: settings held across catalogue changes now reach current authorization/store CAS rather than the general model-policy failure; mobile passive loading and recovered-load errors are truthful; web passive reconciliation says Loading, while active POST says Saving; the mobile current-voice summary wraps in its own full-width text lane. Author reports preserve behavioral red/green evidence. No general inference/synthesis guard was weakened.

## Actual checks

| Requirement | Executed evidence | Outcome and limits |
| --- | --- | --- |
| Strict contract, catalogue/store, auth/CAS, dispatch/retry/quota/concurrency and cross-surface HTTP | `checks/root-checks/voice-node.{json,log}` |218 Node results passed,0 skipped/failed;12.747s. Real production identity/HTTP/store and ClientSession, synthetic actors and provider transport. Four later presentation/status edits do not touch this backend subject. |
| Voice editors, client, playback, sheet, composer, references, session/auth/preferences | `checks/root-final-checks/voice-jest.{json,log}` |263 tests/18 suites passed on final source;9.502s wall. Existing regression expectations remain except intentional removed composer action and richer accessible summary labels. |
| Shared attachment presentation/device regression | `checks/root-final-checks/attachment-regressions.log` |22 tests/2 suites passed; Jest reported18.953s. No actual camera/file/provider operation. |
| Final four-file independent checks | `repair-closure-commands.jsonl`, `visual-repair-closure.md` |73 affected tests, full types29.748s, scoped lint2.077s and isolated admin build1.040s passed. |
| Exact public-preview candidate | `checks/root-final-checks/admin-preview-build.{json,log}` |Real `npm run admin:build` passed1.175s in isolated HEAD219a97d plus exact final22 files; no unrelated dirty source or profile included. Wrapper changes only the admin-assets directory. |
| Full project command | `checks/root-final-checks/full-check.{json,log}` |`npm run check` exit1 after73.218s:3 inherited historical documentation QA import errors,15 warnings. Its lint-first chain does not execute later stages. No whole-repository or CI green claim. Types/relevant tests/build were executed separately. |
| Test registration | `source-review-commands.jsonl`, `final-source-review.md` |All six voice Node paths occur once in real test:identity/CI extraction. The three Jest suites are discovered normally. CI itself was not run. |
| Actual rendered controls | `ui-original.md`, screenshots and final UI report |Actual web AccountPage/Radix and native VoiceSettings/Card/DetailSheet in existing Android development APK with synthetic scoped HTTP. Original full matrix plus focused exact repaired-subject check. Root inspected repaired CS normal/default-only, CS320/font2 fallback and CS320 web held-GET frames. |

Baseline full-check errors are the old `closure-parent.tsx` import and two old Playwright imports to a removed /tmp tools directory under docs/design/attachments-ui-2026-10-30. They were neither hidden nor repaired in this checkpoint. No dependencies, lockfile, provider activation, recording, paid synthesis, production account reset or credential-vault modification was performed.

## Evidence boundaries

The native harness replaces only its mount/session/storage/HTTP boundaries and uses actual visual primitives and controllers. Normal actual App was restored with root-owned RAM-only synthetic credentials; existing saved credentials and device settings were preserved. Native has graphite tokens under both OS appearances, not an implemented light palette. Web light/dark and phone/desktop/keyboard rendering were checked. TalkBack/VoiceOver, iOS, physical-phone performance, actual private-account persistence and real audio/provider support remain unverified. The catalogue alternatives retain the explicitly accepted upstream-contract inference; unknown routes remain default-only.

Settings mutation receipts are not durable speech deduplication. Existing provider quota/concurrency remain; no new speech spend ledger or replay guarantee is claimed. There is no automatic preview/synthesis on opening or saving settings.

The reports retain original scratch paths as historical provenance; accompanying copied reports, source hashes, selected screenshots and check logs are the bounded repository evidence. A durable external artifact bundle preserves additional reproduction tools. Root owns commit/publication separately and does not archive/sync main specs in this checkpoint.

## Canonical bookkeeping

Tasks are reconciled to observed implementation; six Node suites replace the original planned five after adding real ClientSession→HTTP→store coverage. The design records the settings-only current-authorization guard, which restores the already accepted catalogue-conflict/replay contract while leaving general speech policy guards intact. Proposal/design status changes record execution rather than new product intent. Full-check inheritance and unverified provider/native boundaries remain explicit.

Final UI delivery: `ui-final.md` verifies both findings closed on repaired pins. Bundle SHA-256 is74f3bdcfddb2dcca109b9d5265f245a14dbfa88b4127d41345cd6dbb0c980018 (10,025,280bytes,32 allowlisted screenshots); independently verified before durable copy. Native lease is returned and QA services are closed.
