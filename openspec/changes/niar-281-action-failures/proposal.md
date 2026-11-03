# Proposal

Tracker: **NIAR-281** (agent runs end as Failed far too often)

## Why

The last ten failed runs in production's admin **Runs** (read on 2026-11-03) show that most of them were not failures:

1. **Run status.** A chat run was marked `failed` whenever a service read failed in it, even when the agent recovered and delivered a full, correct reply. Its final Reply step then also showed Failed. Examples: a CRM count question with one failed read and three later successful reads, and an Outlook question with 21 tool calls and a complete answer. The cause is in `finalize` (`mastra-domain.ts`): any unresolved failed receipt, read or write, made the run `failed`. The legacy planner already counted only writes.
2. **Input errors reported as "try later".** The provider rejected the call's shape, but the diagnostic said `kind: provider`, `retry: later`, so the model was not told it could fix its call:
   - Twenty: `Scalar field "name" requires a direction value (…)` (orderBy without direction) and `Filter for field "…" must have exactly one operator`.
   - Microsoft 365: `Microsoft Graph API error: 400 Bad Request - {"error":{"code":"SearchWithOrderBy",…}}`. The MCP server relays Graph's status only inside its error text.
3. **Microsoft 365 mail search.** Graph refuses `$orderby` together with `$search` on messages. The built-in server passes both unchanged, so every sorted mail search failed.
4. **Too-large reads.** An Outlook message with a long quoted history was over the 64 KB receipt limit, so the read failed with `integration_response_too_large`.
5. **Provider output-schema violations.** Spilberk Analytics (Rybbit) `get_goals` answered `MCP error -32602: Output validation error: Invalid structured content …: expected number, received string at meta.total`. The provider broke its own output schema. This was reported as "try later".
6. **`tool_input_invalid`.** This is already `correct_input`. It reaches the model with its field issues, and it is not a receipt, so it never decided the run's status. The run where it appeared failed for the other reasons above.

## What Changes

- **Run status is the run's outcome.** A chat run that delivered its reply is `succeeded` even when reads failed during it. A failed or rejected write still makes it `failed`, and an unconfirmed write `unknown`. A run with no reply (step limit, model or protocol failure, abort, authority change) keeps its terminal status. Failed steps stay failed in the run detail. The Runs list and detail show a muted **Some steps failed** badge on such a succeeded run.
- **Input errors are correctable.** A provider message that rejects the request's shape becomes `kind: validation`, `retry: correct_input`. The provider's bounded, redacted message goes to the model. This covers a relayed `400`/`422` status in an MCP error text, Twenty's "requires a … value" and "must have exactly one …", MCP `-32602` input validation, and the earlier patterns. A relayed or real 5xx and timeouts stay `later`, and a relayed 429 is a rate limit. A dispatched write keeps `verify_first`.
- **Provider output defects.** An MCP "Output validation error" (`-32602` or text) becomes `integration_provider_output_invalid`, `kind: response`, `retry: none`. Niaro has no result to fall back to: the provider's server replaced it with the error before sending (see design).
- **Microsoft 365 mail search.** For the built-in's `list-mail-messages` and `list-mail-folder-messages`, a call with a non-empty `$search` is sent without `$orderby`. Graph then returns the matches by relevance.
- **Too-large reads are cut, not failed.** A read result over 64 KB keeps its start within the budget. Long strings keep their beginning and end with `… [truncated]`, long lists keep their first items, and the result says `truncated: true`. A result that cannot be cut, or a write's result, still fails as before.

## Non-goals

- Changing a failed read's result card in the chat answer. `finalize` still attaches the first unresolved failure's card. See Risk.
- Re-labelling historical runs: their stored status stays as recorded.
- Validating providers' structured content on Niaro's side: the client never did.
- Process runs (`service-process-runtime`) keep their own outcome rules.
