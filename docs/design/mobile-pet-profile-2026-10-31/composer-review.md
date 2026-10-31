# Independent bounded composer review — 31 October 2026

Result: no blocking composer-patch defect found in this bounded review. The remaining 320dp/font2 CS and EN native cases and explicit synthetic-send check are complete. The production patch is not modified, committed, published, or aesthetically accepted here. Normal-app restoration encountered a separate root-owned connection guard; see restoration below.

## Exact subject and provenance

Repository context supplied by root: `f-tuma/niaro-pet-mobile-followup`, accepted `4e117be13dce08cb1f040d90f699d0b02bab9757`. No Git/index command was run. Native execution uses the preserved accepted C1R2c full snapshot plus the author's five frozen files, not all concurrent main WIP. The optional DetailSheet dismissal callback seam is included; new voice integration is outside this review.

Authoritative freeze: `/home/flamendrin/.codex/artifacts/niaro-resume-20261031/voice-ui/composer-frozen/hashes.json`, with relative file paths directly under that directory. All five archive, scratch and actual main hashes agree; `fresh-five-pins.json` and final verification record the comparison.

| File | SHA256 |
| --- | --- |
| apps/mobile/App.tsx | adc9b50e4c7e6ed9784b96513e0dff90dbf8ede84e1eb1f0b1431365f7f1a5f1 |
| apps/mobile/ScreenChrome.tsx | 84169effa5e6c464aa834aab9fdc200da860f50a4795e09c412be439a48596e7 |
| packages/ui-catalog/AttachmentPicker.tsx | 75553e0c2e85b34ef49c1ddef0d4e3080ccddf18c7322220b7006139916d6400 |
| tests/conversation-history-mobile.test.tsx | 9422163e01d806f13eec262c0fabe479e4fdb27d49b5ded499892cc406b9fc02 |
| tests/mobile-mentions.test.tsx | 9bc51a3fd443cb69b3804d87895f8f9291a3ced52d362a7320bef95bf5a51b38 |

Both preserved full source copies contain 1,053 manifest-pinned files with zero byte changes (`composer/resume-source-verification.json`). Scratch symlinks reuse installed repository dependencies. Only harness paths, control code and evidence files changed. Archive files remain untouched.

## Behavior and evidence

| Requirement | Evidence/result |
| --- | --- |
| Centered field/actions; no standalone @ or reserved width | `ScreenChrome.tsx` outer frame now justifies the column centrally. App supplies paperclip only on the left, mic/send on the right. Normal native input gains exactly 126 physical pixels = 48dp. |
| Typed @ dynamically filters above input | All four language/size cases pass; `@Re` shows only Review above Composer, following the synthetic attachment tray. |
| Explicit references through paperclip | Paperclip → References → Review uses the owned native sheet, inserts into the retained draft and returns real Gboard focus. Cancel also returns real Gboard with the draft intact. |
| Reference tray/removal and attachments | Reference chip remains within the frame; removal removes mention text and preserves surrounding text. Actual attachment presentation renders the synthetic uploaded TEST-notes.txt state. No upload or filesystem picker integration is claimed. |
| No autosend | All four matrix cases recorded zero application commands through typing, selection, removal, pick and cancellation. |
| Explicit-send metadata | `explicit-send-result.json`: exactly one `message.send`, text `Synthetic @Review  payload`, mentions `[{kind:"process",id:"TEST-review"}]`, language `en`, synthetic conversation-1. No provider/network send occurred. The double space is the intentional inserted reference terminator plus explicitly typed leading space. |
| Caret / late owner / lifecycle | Same pinned production tests preserve captured-caret insertion, stale equal-text draft rejection, retired chip removal, late directory ownership, Modal-show/entrance focus and refusal after background/dismiss/unmount/new owner. No ownership/parser rewrite was introduced. |

The 30 October independently completed run remains valid evidence for the unchanged bytes: 46 tests in conversation-history-mobile, mobile-mentions and detail-sheet, saved in `composer/independent-composer-tests.log`. It was not rerun merely to refresh a date. Normal CS/EN native cases also remain prior evidence. Today's `native-narrow.py` adds both unfinished 320dp/font2 cases. No accepted C2 GPU/performance suite or full repository suite was repeated.

IME qualification: this proves real Gboard visibility, focus return, multiline entry and ASCII native typing on the existing APK. It does not prove Japanese/Chinese composing-span internals, iOS keyboard behavior or every third-party IME.

## Measured geometry and optical review

Bounds are physical-pixel AX rectangles converted using actual density/160. `composer/accurate-control-geometry.json` rejects invalid offscreen rectangles; it does not confuse child icon bounds with button hit areas.

| Measure | Before normal | After normal | After 320dp/font2 blank |
| --- | ---: | ---: | ---: |
| Frame centerY (physical px) | 2066.5 | 2066.5 | 1831.5 |
| Row/action assembly center offset from frame | -6px | 0px | 0px |
| Input width | 214.095dp | 262.095dp | 266.074dp |
| Action rendered size | 43.810 × 43.810dp | same | 44.148 × 43.852dp |
| Native input center relative to action center, single row | +1px | +1px | stacked layout; separate centered input row |

The source specifies 44×44dp actions with 4dp hitSlop. Rasterization differs from 44 by less than one physical pixel; this is not a claim that the visible control is 48dp. At large text the full-width input stacks above the actions, preserving the input node, and both action centers share the same Y. A selected reference row adds height above the input; comparing the input/action assembly to the entire chip-containing frame would be misleading.

Viewed normal before/after, normal CS/EN, narrow blank/multiline/suggestions/selected/pick captures. No @ gap remains, field content is readable, and the row is centered. An additional reproducible ink measurement places the CS placeholder's visible glyph bounding-box center 5.5px (2.10dp) below frame center after the fix, while its native box is 1px below action center. This is documented font-ink geometry, not an assertion of mathematically identical glyph/icon optical centers or user aesthetic approval. No speculative glyph translation was applied.

The initial 320/font2 attachment + suggestion screenshot showed the actions partly behind Gboard because the QA toolbar consumed additional height. `toolbar-control.py` hides only that harness toolbar. The resulting `resume-toolbar-hidden-typed-filter.png/json` shows frame bottom1405 and action bottom1381, fully above the keyboard starting1432; the centered row offset is0. This isolates the probe artifact from the production layout. The production source remained frozen throughout.

Superseded probe issues were harness-only: the archived initial removal-label/language assumptions, today's list-call typo in toolbar-control, and a geometry parser needing the old AX response envelope and valid rectangle filtering. Corrected scripts and final evidence are retained; none is presented as a product failure.

## Native lease and restoration

Fresh inventory: existing emulator-5554 already booted. Fresh 09:18:44UTC baseline: physical1080×2400, physical density420/no override, font1.0, user_rotation0, accelerometer_rotation1, no reverses. Own frozen Metro8894 and collector8896 used only synthetic ports; existing APK/data/account/permissions were preserved. No install, rebuild, reset, sign-out, saved-server edit or provider call was performed.

All five display/rotation settings compare equal after restoration. Fresh baseline reverses were empty after host restart. Root explicitly amended the restoration target in `msg_d83d75492d80` to require normal8087/38683 reverses; those two are present, own8894/8896 are removed. Both own native services are stopped and their ports closed. Root services8087/38683 are healthy. The Orca device helper was stopped and native lease explicitly returned via `msg_66a8b4bb9f67`.

The normal8087 deep link renders `Isolated native QA setup failed. Existing connection was retained.` Evidence: `composer/resume-restored-normal.png/json`, restoration actions/settings/ports. The guard was preserved; root was asked to resolve this normal-entry prerequisite safely. This is not composer failure and not a successful normal-Home restoration claim. Later root restoration evidence, if supplied, is appended separately.

## Reproduction commands and next checkpoint

All paths are under `/tmp/niaro-resume-20261031/mobile-ui`, except read-only archive/dependencies and the exact Orca executable `/home/flamendrin/.config/orca/linux-orca-cli-shim/orca`. Current lifecycle IDs are task_652c4e34fc64 / ctx_802fe36b08fc; archived lifecycle IDs were not reused.

- From composer: `python3 collector.py` on8896.
- From composer/native: `TMPDIR=/tmp/niaro-resume-20261031/mobile-ui/composer EXPO_OFFLINE=1 node /home/flamendrin/workspace/niaro/node_modules/expo/bin/cli start --dev-client --port 8894 --host localhost`.
- Only own adb reverses8894/8896; existing agentclient development deep link to localhost8894.
- `python3 -u native-narrow.py`, `python3 -u explicit-send.py`, `python3 -u toolbar-control.py`, `python3 geometry.py`.
- Exact settings/reverse commands and outputs: `composer/resume-restoration-actions.json`.

Root's next checkpoint is to inspect the normal before/after and no-toolbar narrow screenshots, accept or request a precise optical change, resolve normal-entry restoration, and integrate the pinned author change through its own acceptance process. This report supplies bounded review evidence, not production feature completion.

### Root acceptance of restoration handoff

Root message `msg_333d93f5fbc8` accepted the exact settings/reverse restoration and honest guard screenshot, took exclusive native ownership, and directed this worker to complete A/B without further emulator access. Root is preparing a separate safe scratch preview entry with RAM-only credentials and will provide its own final visible-App proof. No additional emulator action was performed after lease return.
