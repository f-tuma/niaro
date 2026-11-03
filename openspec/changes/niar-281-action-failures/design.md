# Design

## Run status (`mastra-domain.ts` `finalize`)

`finalize` collects `unresolvedFailures()`: failed or unknown receipts with no later success of the _identical_ call. A corrected read has different input, so the original failure stayed "unresolved" and the run ended `failed`.

The final status now reads only the outcome:

| Situation                                                                    | Status               |
| ---------------------------------------------------------------------------- | -------------------- |
| reply delivered, reads failed or not                                         | `succeeded`          |
| a write was refused by the consistency check (`partialWrite`)                | `failed`             |
| an unresolved write is `unknown`                                             | `unknown`            |
| an unresolved write `failed`                                                 | `failed`             |
| no reply: step limit, model, protocol or execution failure (`finishFailure`) | `failed` (unchanged) |
| abort, authority change, restart                                             | unchanged            |

The earlier branches of `finalize` (contact lookup without a matching read, a rejected write after a repair) keep their `failed` status: their reply is a server-written failure, not the model's answer. This matches the legacy planner (`agent-runtime.ts` `finish`), which already counted only writes.

The steps keep their own statuses, so the admin detail is unchanged. `LoopsStore` adds `failedSteps: true` to a `succeeded` summary whose trace has a failed tool step. The SQL projection checks `trace.steps[*].kind = 'tool' AND status = 'failed'`. The console shows it as a neutral (muted) badge next to the existing evidence badges.

## The answer's card (`finalize`, clients)

`finalize` attached `resultCard(failures[0])` to the answer, so a failed read's card ("Action failed") rode along with a correct reply. It also became the native task's `native.action`, which the web (`chat-work.tsx`) and the phone (`WorkItemCard`) render as a card. The diagnosis card is now taken only from an unresolved write (`failedWrite`: failed or unknown). Without one, the answer carries the latest succeeded receipt's card as before, or no card at all.

These paths are unchanged:

- `finishFailure` (no reply) still shows its diagnosis card.
- Approval, sign-in, question and refused-write answers return earlier.

The clients share `presentedNativeAction(work)` (in `packages/protocol`, which both `ui-catalog` and the web may import). It hides a `failed` action card on a `succeeded` task, so the card does not come back through stored tasks either. With the card hidden, the task shows its answer text.

## Classification (`server-integrations/failures.ts` `classify`, `providerFailure`)

The order matters:

1. Existing code-based rules (budget, 429/401/403, codes) run first.
2. `integration_provider_output_invalid` → `response` / `none`.
3. Existing 400/409/422 status and validation codes (`-32602`) → `validation` / `correct_input`.
4. Existing cancellation, response and outage codes.
5. **New:** a real HTTP status ≥ 500 → `provider` / `later`, whatever the text says about input.
6. Access wording in the message → reconnect or permission (unchanged).
7. **New:** a relayed status in the message (`400 Bad Request`, `422 Unprocessable …`, `429 Too Many Requests`, `5xx …`) → correct input, rate limit or later.
8. Input wording (`INPUT_PROBLEM`), extended with "must have (exactly) one …", "requires a … value/argument/parameter/operator" (credential words excluded), "Input validation error" and "MCP error -32602".

`providerFailure` replaces the generic code (or `-32602`) with `integration_provider_output_invalid` when the message is an MCP output validation error. Without that, `-32602` would tell the model to correct an input that was never wrong.

The message stays as before: `diagnosticText` with at most 600 characters, credentials redacted (Bearer/Basic, token and key pairs, exact secret values, URLs), and no HTML or serialized bodies. `failureToolResult` hands it to the model, and `ACTION_FAILURE_INSTRUCTIONS` already says "fix the input from failure.message and call it again once". A write dispatched before the failure keeps `verify_first` (`actionFailure`).

## MCP output validation (finding 5)

Niaro's MCP client (`McpSession` in `discovery.ts`) never validates `structuredContent` against a tool's `outputSchema`. The error comes from the provider's own server: the official SDK's `McpServer` validates its tool's output and, on a mismatch, sends `{ isError: true, content: [{ text: "MCP error -32602: Output validation error: …" }] }` _instead of_ the result. Niaro receives no text or structured content to fall back to. Skipping validation on our side changes nothing either.

What Niaro can do is classify it honestly. It is a provider response defect (`response`, next step `none`, "ask the service's administrator"), not an input to change and not an outage to retry. The provider has to fix its schema (Rybbit's `meta.total` is a string). Nothing is recorded as a warning, because no successful result exists to attach one to.

## Microsoft 365 mail search (`server-integrations/microsoft-graph.ts`)

`graphMailArguments(toolName, input)` runs in `invokeAction` for plain MCP bindings. For `list-mail-messages` and `list-mail-folder-messages` it drops every `orderby` key when a non-empty `search` key is present. Keys are matched as the server reads them: any case, with or without `$`. Other tools and calls without a search are sent unchanged.

Services carry no "hosted built-in" marker, so the rule keys on these tool names. They are the built-in's names, and another server with the same names gets the same Graph-safe behaviour. The receipt records the input the model sent; only the dispatched call differs. Graph returns search matches by relevance.

## Too-large reads (`server-identity/result-budget.ts`)

In `CatalogController.invoke`, a _read_ result over `MAX_RESULT_CHARACTERS` (65,536) goes through `fitReadResult`:

- An MCP text block holding JSON is parsed and fitted as data, then serialized back. The model still reads one valid JSON text block.
- Repeated passes cap every string at `text` characters (start kept, `… [truncated]` appended) and every array at `items` entries (first kept), halving both until the JSON fits. There are at most 12 passes and a depth limit of 24.
- The data the model reads gets `truncated: true` at its top. For an MCP result this is the inner JSON. The marker follows the model projection's existing convention.
- When nothing can be cut (for example many small keys), it returns `undefined`, and the read fails as before with `integration_response_too_large` / `correct_input`.

A write's result is never cut. A dispatched write over the limit stays `unknown` with `verify_first`, as before. The transport's 2 MB stream cap is unchanged: a stream cut mid-way is not safe JSON to fit.

The model's own projection (`projectResult`, 12 KB) is unchanged. Previously the model saw nothing from such a read; it now sees the start of it.

## Security and authority

Approvals, idempotency, server-side authority checks and the budget ledger are untouched. The only new provider text that reaches the model is the already-sanitized diagnostic message. The Graph rule only removes a parameter.
