**POV-BR-01 bounded repair delivery**

The two-file repair is implemented and verified. An authenticated settings POST whose body is held across an administrator catalogue edit now reaches the store and returns **409 `output_voice_catalogue_changed`**. An exact replay of the last committed mutation returns the current snapshot with its original personal revision after a later catalogue edit, while a credential revoked during the held replay still returns **401 `auth_expired`**. These are author verification results; independent closure and feature acceptance remain pending with root.

Task `task_45a15ea113f1`, Dispatch `ctx_3316e2382c05`, terminal `term_13e5952f-a8ec-498f-89eb-2bdc8d304189`, on the same previously proven Orca `gpt-6.1-sol` / `xhigh` agent. The current `orca-provenance.json` identifies the exact reused terminal and projected model; launch settings are null in this terminal-reuse receipt, and the prior accepted review receipt remains preserved as the original model/effort provenance. This worker authored the fix after producing the prior finding and cannot supply fresh independent acceptance of it. No nested agent was used.

Only the two authorized repository paths changed:

| Path | Starting SHA-256 | Final SHA-256 |
| --- | --- | --- |
| `apps/server-identity/service.ts` | `a476141bb5618f01272539926fcec08a908152b3b7c62c56a45b2369cb6df268` | `a6df3dd37732759af52231a42977858d97da6381db71319c818b7fd56f7ccedf` |
| `tests/output-voice-http.node.ts` | `fc5b38787de52d85df12b03eadcc7cb379a492e43d7fd96967c93498a557d76e` | `782df9fc09af1a2da79e7b994e0589091af34831f9d3792db9e09fcf269aa02f` |

`repair.patch` is the minimal two-file patch against the explicit repair gate, and `before/` plus `final-source/` preserve exact bytes. Applying it in `patch-check/` reconstructs both final hashes. All **seven accepted S1 pins and the other four S2/S3 pins remain unchanged**, verified against the original freeze and the tested copy; see `before-pins.json`, `final-pins.json`, `freeze-check.json` and `repair-subject.json`. Base HEAD `4e117be13dce08cb1f040d90f699d0b02bab9757` is the coordinator-supplied base; no Git command or index operation was performed.

The cause was the settings callbacks using the general `run` closure, which compares a captured inference/workflow policy epoch. A real administrator route edit advances that epoch before a slow settings body completes, so the generic model guard rejected the request before the settings store could classify its stale catalogue or known receipt.

The production change imports existing `sameScope` and adds `runOutputVoiceSettings` at `apps/server-identity/service.ts:3334`. Only the own-settings read/save callbacks use it. Inside the **existing identity queue**, it checks service shutdown, reauthenticates the captured credential, and requires the current authenticated organization and all four scope fields to match the admitted actor. The unchanged store then rechecks current membership and enforces catalogue, personal CAS and last committed receipt semantics against the current route. No provider, model invocation, preview, remote discovery or workflow command is added.

The general `check`/`run` code and the entire synthesis closure remain **byte-for-byte unchanged**; `guard-preservation.json` records verified section hashes. The new HTTP regression explicitly confirms that a retained runtime can read current own settings after the route change while its general `run` still refuses the old policy with `model_unavailable`. Existing HTTP membership/credential revocation, body bounds, strict payload/profile, CAS/replay and synthesis auth/text/route/epoch/retry/quota/concurrency checks remain in place and pass.

The production regression was written **before** the guard fix. It uses the actual reference HTTP server and real identity authentication with only synthetic data and a transport that fails/counts any forbidden provider call. The helper sends just the first byte of JSON and waits for the actual `mobileAccess` to return before the administrator uses the real authenticated catalogue API; it then releases the rest of the same body. It introduces no replacement settings handler or store.

Recorded red/green evidence:

- `held-http-red.log` and `held-http-red-final.log` ran the new tests with production `service.ts` still at starting hash `a476141bb5618f01272539926fcec08a908152b3b7c62c56a45b2369cb6df268`. Exactly the two added child cases failed: the fresh stale-catalogue mutation expected 409 but received 503 `model_unavailable`, and known-receipt replay expected 200 but received 503. The other ten child cases passed. The parent makes the node:test summary three failures; this is the correct behavioral red rather than a harness, compilation or unrelated failure.
- `red-pins.json` and `red-source/` preserve that red revision. After successful red, the minimal guard fix was applied; `held-http-green.log` passed all 12 children / 13 node:test results, including the revoked-credential known-receipt branch and retained general-runtime refusal. One assertion was then formatted with Prettier; `red-to-final-test-format.diff` shows the sole nonbehavioral test difference from the final red version.
- The **unchanged original independent review probe** was copied only into this repair's isolated test copy and rerun: `original-independent-probe-green.log` passes all three children / four node:test results. It confirms the original held-body reproduction now returns 409, simultaneous mobile/browser CAS still has one winner, and a deliberately dropped response after commit reconciles via GET and exact replay without overwriting a newer choice. This is execution of the preserved probe by the repair author, not a new independent review.
- `backend-final.log` runs the final formatted test and final production bytes together with all five output-voice Node files and unchanged catalogue-speech/speech coverage: **92 tests pass**.
- `speech-regressions-final.log` passes **86 unchanged legacy tests across nine Jest suites**, covering speech HTTP/client, reader/retry, automatic replies, playback and interruption/control logic. Full isolated TypeScript checking, affected-file ESLint, test formatting and architecture boundary checks pass.

Exact commands, UTC starts, working directories, wall durations and exit codes are in `commands.json` and the individual run receipts. All tests/builds ran from `/tmp/niaro-resume-20261031/backend-repair/source`, except the named private patch reconstruction. Existing installed dependencies were reused through symlinks; no dependency was installed. `TMPDIR` points into this repair directory and TSX disk cache is disabled.

| Run | Exit | Seconds | Output |
| --- | --- | --- | --- |
| `isolated-admin-build` | 0 | 1.054 | `isolated-admin-build.log` |
| `held-http-red` | 1 | 10.350 | `held-http-red.log` |
| `held-http-red-final` | 1 | 10.553 | `held-http-red-final.log` |
| `held-http-green` | 0 | 10.450 | `held-http-green.log` |
| `original-independent-probe-green` | 0 | 10.190 | `original-independent-probe-green.log` |
| `repair-lint` | 0 | 3.547 | `repair-lint.log` |
| `repair-format-check` | 1 | 0.173 | `repair-format-check.log` |
| `backend-final` | 0 | 13.894 | `backend-final.log` |
| `types-final` | 0 | 32.301 | `types-final.log` |
| `boundaries-final` | 0 | 0.738 | `boundaries-final.log` |
| `format-final` | 0 | 0.195 | `format-final.log` |
| `lint-final` | 0 | 3.402 | `lint-final.log` |
| `speech-regressions-final` | 0 | 15.160 | `speech-regressions-final.log` |
| `patch-check` | 0 | 0.002 | `patch-check.log` |

The isolated administration build succeeded and created only this repair's private `source/dist-admin`; it supplies the static shell required by actual admin HTTP tests and is not visual evidence. Its bundle-size notice is unrelated to this backend repair. The initial formatting check correctly reported a new assertion's wrapping; that wrapping was fixed and the final check passes. No remaining executed check fails except the deliberately preserved pre-fix reds.

The prior review report, evidence manifest and original probes were preserved; their report/manifest hashes still match the prior delivery. This repair does not mark the canonical finding resolved by independent review, mark any checkbox, register tests, edit package/CI/session/mobile/UI/config files, or claim feature acceptance. Root still owns fresh independent closure of this exact repair subject, registration of the two S2/S3 tests, combined checks, commits and publication.

Limitations: no full `npm run check` or complete CI run, native/device/browser work, real audio/microphone, external/paid provider request, private data or protected server port was used. The HTTP fixtures bind ephemeral loopback ports. Quota, concurrency, deadline, abort and retry results use actual production guards with synthetic transport, not live provider certification. Existing speech spend/durable deduplication gaps and the accepted provider-catalogue inference are unchanged.
