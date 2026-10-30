# Independent reference-recovery correction review

**Verdict: ready for the exact joint-r6 correction and affected behavior below; no open material finding.** Root disposition and final native acceptance remain separate. This fresh dispatched review did not reopen the accepted four-branch integration.

## Subject and preservation

Final manifest `/tmp/niaro-orchestration-20261030/joint-main-frozen-review-r6.json`: SHA-256 `dfae92fe8e900bc5eef6edaf87e8af1e59c771d80e29eb67aa71574a844dff63`. Full own patch: `91c94f0d719e561d6a7cfa43d42d287d1781ffa782800914d0b3ff699effb101`; r5→r6 patch: `a0e608041b117a1421ab5bd82ae073c8e9a239a4cf2f82562aad1003ece1d784`.

Runtime SHA `c0bb30033d3dbb22cec93e831344510afdd1b018f965ab0edeb1210abf57fcfd`; App SHA `99f64bf1a7f19e276fa733206c72c6bdf640f6c057d5d640c6fc0508bec5eb89`; final Workspace test SHA `baed07d4f0c5332c341f5c18b979cc96638b727624530c81bb2cd153dbee1a28`. The App equals the independently supplied immutable candidate manifest SHA `1bf8d161b88f836ea8662b475d3c0d69df5ee8e3c2ebf7f89e5939b65421bc9f`.

r5 manifest SHA `52dad833b9647f5880726c0ae607f80f7af4dcd86bc1a0d0391226d6a92396e1`, own patch `0c3dddc35e63d48398de6c89dab83885ea247ae84dd2c5980a17cfa2129076ef`, incremental patch `27c17f425348ba023af0c66eefbccf3401149454bb76aa3e8a0162c538ee167e`. Baseline r4 manifest SHA `8d4ef9499a8e2507fbecd026cfa91754ef5a7e4fdcc192224acd9497a17eb89d`; accepted broader review SHA `15eaa87c9ae3cd81d14b9a65b746779fbff364b0619b3ffcd6475fd57643fff7`.

Independently verified all 150 source rows at r5 intake and final r6, including final bytes/modes. r5 changed only runtime plus two regressions; other 147 r4 rows matched. r6 changes only App and Workspace test from r5; other 148 rows match, including runtime/transport/protocol and backend regression. Both incremental patches, applied to isolated prior-version copies, reproduce their final hashes. HEAD `260b1eef413dc3e6295ef9776c2a5ea868a8ef0f` and index SHA `297e17e9439e4b9a983d65ccf80d7b999d7bb119a1ba8c6664d33e59bdba4de7` remain unchanged. See hash-verification.json, patch-replay.json, r6-hash-verification.json and r6-post-check.json.

## Behavior and boundaries

At `attachments.ts:68`, `:552`, `:630`, an unresolved frozen reference with no acknowledged content or validated terminal refusal exposes explicit recovery even when the transport says retryable:false. Retry replays the same request identity/revision and resumes the ordered suffix. It never sends; the complete ordered intent must be ready for explicit Send. Validated terminal 400/404/409/411/413/415 refusals remain remove-only. A failed Remove while recovering an unknown pin preserves Retry; loss of an actual Remove response after the pin is acknowledged retains only explicit identical Remove. Upload uncertainty/quarantine, command recovery, downloads/saves and native retries are unchanged.

At `App.tsx:1414`, the existing owner-guarded reuse catch avoids creating a duplicate global rejection when a failed row already represents the error. It clears no existing replyError and adds no asynchronous clearing effect. Genuine pre-entry failures retain the global fallback, and newer draft/session/context guards remain. This closes the stale post-recovery/accepted-Send alert without hiding unrelated errors.

Read CONTRIBUTING.md, SPEC review instructions, JMR-01/JMR-02 native findings, canonical attachment design and chat/message-attachments deltas, production runtime/transport/presentation, mobile Workspace/attachment consumer, web chat-next reuse/submit/attachment consumer, final regressions and author reports/red/green evidence. Unchanged web code captures caption/mentions before pinning and retains its owner guards; this review adds no new end-to-end web mention qualification.

## Independent execution and test quality

- **r5 production HTTP regression: 1/1 pass.** `node --import tsx --test --test-name-pattern='production account HTTP/S3 and ClientSession' tests/attachment-memory-integration.node.ts`, with TMPDIR here. Actual account HTTP/workflow/S3 adapter and synthetic transport cover both accepted-B 503 forms, exact replay, zero autosend and exactly three original PUTs.
- **r5 Workspace: 9/9 pass; r6 Workspace: 12/12 pass, five unrelated cases intentionally filtered each run.** Installed Jest `--runInBand --cacheDirectory <owned-dir>/jest-cache --forceExit tests/attachment-client-ui.test.tsx --testNamePattern='actual Workspace'`. Final r6 covers both actions × network/unknown503/validated503false, B/C compound recovery, caption/newer-edit ownership, terminal refusal, stale New chat callback, initial Again ownership, no duplicate alert before/after explicit accepted Send, unrelated identical-text Send error surviving tray mutation, current-scope row error, and genuine pre-entry global fallback. App hash was checked before/after. Known forced-exit/open-handle qualification remains.
- **Independent runtime/transport/presentation boundary probes: 19/19 pass.** `node --import tsx --test /tmp/niaro-reference-recovery-review-20261030/recovery-boundaries.mts`. Covers unknown503, validated503false, network, unknown404, uncertainty409, invalid success/JSON, all six terminal refusal statuses/local removal continuing C, failed Remove followed by compound exact B/C Retry, lost actual Remove/exact repeat, held successful/failed Retry fenced by target switch, and no generic retry for ordinary upload503false. Fixtures reject unexpected effect routes. These r5 executions remain applicable to byte-identical r6 runtime dependencies; they were not relabeled new r6 executions.

Author evidence is separate: inspected and verified hashes for r5 red/green Node20/Jest52 and r6 red/green Jest77/77 plus types/affected lint. The final unrelated-error test deliberately settles its injected never-dispatched Send as rejected before testing later tray mutations; it makes no network/receipt claim. The changed AppState test retains/restores the original function rather than resetting an already mocked native method; original inactivity/background assertions remain. Author full-file execution covers that isolation repair; this reviewer intentionally filtered the picker case. No unaffected broad suite was rerun.

## Findings and qualifications

JMR-01 is closed for exact replay/ordered recovery by r5 and unchanged in r6. JMR-02 is closed for the duplicate global staging alert by the exact r6 catch and independent Workspace execution. No additional material correction finding remains.

Existing accepted r4 lint failure, identity 12-failure equality, historical broad Jest/open-handle qualifications and unimplemented-feature limits remain in force. Node/Jest are not final native acceptance. Astra owns device/emulator evidence; physical-device/iOS/HEIC, hardware capture, live RustFS/Hetzner, semantic processing, model/CRM work and whole-feature/release qualification are unassessed here.

Fresh dispatched independent Codex reviewer, task `task_bd21d607008a`, dispatch `ctx_a3cf58dd8af2`. All reviewer writes are under `/tmp/niaro-reference-recovery-review-20261030`. No source changes, helper agents, dependency installation, device/shared-service mutation, credentials/user data, paid/business calls, stage/commit/push or deployment. Acceptance applies only to this exact pinned correction and scope; root settlement remains pending.
