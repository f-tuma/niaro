# Mobile prototype interaction parity — C2 R2b

Accepted bounded engine revision: `47419eeac962515b7c5f220c968b9c2396415b17`, 2026-10-30. This bundle preserves the independent report and exact source/behavior pins. Scratch paths named in the original report identify the executed session artifacts; they are not portable repository dependencies.

The migration preserves the original prototype gesture cadence, complete face presets, spring/timeline behavior and projected upper-right signs, with native input/lifecycle, reduced-motion and render-budget adapters. F2-1 through F2-5 are closed in the [independent review](independent-review.md). See [the parity ledger](prototype-parity-ledger.md) and [source hashes](source-hashes.json).

Root verified a clean export with six suites / 53 tests and typecheck. The independent reviewer executed four frozen suites / 49 tests, actual Android Home interactions and web keyboard/focus behavior. The report distinguishes real component execution from injected native faults, synthetic input and source comparisons.

Android evidence comes from an emulator with a desktop GPU translator. Host RAF delivery varied; this does not certify physical-phone performance. The configured active/calm/doze budgets are maxima of 30/20/15 fps. Native setup, exact loaded snapshots and capture paths remain in the report.

This acceptance excludes subsequent App/Home viewport ownership and composer references (C1), weather/time (C3), personal output voice (C4), profile persistence and new prototype shapes. The R5 native deletion-error recovery is separately included in the independent review; its source was already committed as `db888b29003f6e243e889222bffcd92da57dd62e`.
