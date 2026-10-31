# QA receipt

Summary: preserved composer review closed on exact frozen bytes; mobile Pet prototype is reviewable and browser-tested. Production files were not edited. Composer normal-app restoration is a separate root-owned guard blocker until root supplies successful restoration evidence.

| Check | Result | Evidence |
| --- | --- | --- |
| Composer exact pins | PASS | fresh-five-pins.json; final-five-pins.json |
| Full frozen source preservation | PASS,1053 files each | composer/resume-source-verification.json |
| Native320/font2 CS+EN | PASS | composer/resume-native-narrow.log; native-matrix.json |
| Native metadata/no-autosend | PASS, synthetic only | composer/explicit-send-result.json; matrix commands=[] |
| Native control geometry/optical | PASS within stated bounds; no aesthetic claim | accurate-control-geometry.json; no-toolbar screenshot |
| Prior test evidence retained | 46 passing tests,30 October, same bytes | independent-composer-tests.log |
| Browser page identity/nonblank/no overlay | PASS | browser/final/results.json and screenshots |
| Responsive and text200% | PASS,24 core combinations | browser/final/results.json |
| Console/page errors/external requests | 0 /0 /0 | browser/final/results.json |
| Main interaction flows |11 PASS | browser/final/results.json |
| Extended keyboard/resize | PASS | browser/final/extended-results.json |
| Exact concept-size capture |853×1844 for all3 | browser/final/concept-scale-*.png |
| Fidelity comparison/copy | Reviewed, deliberate deviations recorded | fidelity-ledger.md |
| Root acceptance/production integration | NOT CLAIMED | design.md next checkpoint |

Environment: Android emulator-5554, existing installed dev.agentclient.demo, frozen Metro8894 + collector8896; static prototype http://127.0.0.1:8895. Browser plugin absent; Orca screenshot timed out without a frame. Existing Playwright with explicitly selected installed Chromium1243 provided final captures. No dependency/browser install.

Material fixes: edit-cancel opener focus, corrected-row focus, dialog title/focus containment, theme radio keyboard controls, long-name wrapping, large-text source spacing and overview stage rhythm. Initial focus timing assertion was corrected to await requestAnimationFrame; the subsequent missing action-opener id was a real prototype defect and was fixed. Native toolbar clipping and parser assumptions were harness artifacts, not production source changes.

Remaining limits: static proposal only; no real API/backend/storage, pagination/conflict/security integration, native profile UI, screen-reader certification, iOS, CJK composition, pet animation/GPU, weather/location/voice-provider execution. A browser430px viewport probe does not replace native keyboard testing. User aesthetic approval and canonical amendments remain root-owned.

Gallery packaging QA:1280/390/320 widths, working embedded Style navigation, all20 links returned200, all images loaded, no overflow or page/console errors (`browser/gallery-results.json`).
