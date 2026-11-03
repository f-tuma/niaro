# Tasks

## 1. Evidence

- [x] 1.1 Map each production failure to its cause in code: `finalize` status, `classify` patterns, the built-in's `$orderby` pass-through, the 64 KB receipt limit, and provider-side output validation (official SDK `McpServer`).

## 2. Run status

- [x] 2.1 `finalize` decides the status from the reply and writes only; failed reads stay failed steps.
- [x] 2.2 `failedSteps` on `LoopSummary`, the SQL projection and the muted console badge (en, cs).

- [x] 2.3 `finalize` attaches only an unresolved write's failure card; the web and phone task cards hide a failed action on a succeeded task (`presentedNativeAction`).

## 3. Failure classification

- [x] 3.1 Relayed HTTP status, Twenty and MCP input wording → `correct_input`; HTTP 5xx → `later`.
- [x] 3.2 MCP output validation error → `integration_provider_output_invalid` (`response`, `none`).

## 4. Microsoft 365

- [x] 4.1 `graphMailArguments` drops `$orderby` from mail list searches before dispatch.

## 5. Too-large reads

- [x] 5.1 `fitReadResult` cuts a read within 64 KB and marks it; writes and uncuttable results still fail.

## 6. Verification

- [x] 6.1 Node tests: classification of the production messages, redaction, write `verify_first`, Graph arguments, result fitting, run status after a failed read, an oversized write, the Runs marker, invalid arguments followed by recovery; an end-to-end recovered read with no failure card on the answer or the task, and web (DOM) and phone card tests.
- [x] 6.2 Lint, typecheck, admin build, full Jest, the focused node suites and `npm run test:identity`.
- [ ] 6.3 After deploy: watch Runs for the reported CRM, Outlook and Analytics questions (not verifiable without production).
