# Shared native inference budget

A durable ledger lives in the existing identity database. The native
Mastra chat adapter and the raw Jev verifier use the same guarded transport
wrapper and the same server-owned root run ID. Native command aliases and
authenticated continuations keep that ID. This is a budget per run, not a
workspace-wide spending quota. The existing model-step, inference-call,
action-attempt and provider daily request limits still apply. Custom
agent steps now use that wrapper under their parent process root, with frozen
process limits narrowing the workspace policy.

## Configuration

The initial policy is **observe**, revision 0: record usage and uncertainty
without enabling a financial cap on an existing installation. Its default
declared caps are 1,000,000 tokens and 10,000,000 USD millionths ($10), with no
assumed prices. **Those caps are enforced only in enforce mode.** An owner or
admin explicitly supplies pricing for every selected chat/router/decision
model and switches to enforce.

In the console, open **Usage limits** (`/admin/usage`). **Fill from providers**
copies list prices published by the provider (OpenRouter publishes them for
most models); type the rest, choose **Enforce** and save. The process designer
and custom agent steps run only in enforce mode with a priced model; the
designer says so and links to this page before a message is sent.

The same policy is available through the authenticated account endpoint:

```text
GET /admin/api/identity/catalog/budget?organizationId=<org>&workspaceId=<workspace>
```

POST the complete policy to `/admin/api/identity/catalog/budget`, using the
current revision, the normal account session, same-origin protection and
`X-Agent-Admin: 1`. An operator key alone is insufficient. For example, the
following is a synthetic tariff, not a recommendation or a current model price:

```json
{
  "organizationId": "TEST-org",
  "workspaceId": "TEST-workspace",
  "revision": 0,
  "settings": {
    "mode": "enforce",
    "maxTokens": 10000,
    "maxCostMicros": 10000,
    "prices": [
      {
        "modelId": "TEST-model",
        "modelRevision": 1,
        "providerRevision": 1,
        "maxInputTokens": 2048,
        "maxOutputTokens": 100,
        "inputMicrosPerMillion": 1000000,
        "outputMicrosPerMillion": 2000000
      }
    ]
  }
}
```

Prices are USD millionths per million tokens: 1,000,000 means $1 per million
tokens. Explicit zero is valid for a free tariff. `maxInputTokens` is the
largest request the model may receive (it may be the whole context window);
`maxOutputTokens` is the largest reply. A call reserves its own request size,
not the input ceiling (see below), so a run cap only has to hold the smallest
call: 2,048 input tokens plus the full output ceiling. A separate decision
model needs its own price entry. The server
validates the actual configured model and provider revisions; changing either
requires a fresh policy. Successful policy updates increment its revision and
commit an audit entry atomically. Stale updates conflict.

A run pins its policy revision, digest, organization, workspace and user.
Editing a policy stops further dispatch on already pinned runs with
`catalog_budget_policy_changed`; it does not reset their ledger or reinterpret
their completed receipts. Start a genuinely new command under the new policy.

## Reservations and measured usage

All reservations and settlements run inside the identity queue. An overlapping
model/checker request counts existing in-flight holds before reserving its own
tokens and cost. The final authorization guard persists `dispatched` immediately
before network I/O. SDK retries remain disabled; each actual attempt requires
its own reservation. Cancellation before dispatch releases its hold.

**What a call reserves.** The wrapper reserves after the request body is
known, so each call reserves an upper bound for that request, not the priced
maximum:

- input = the request's estimate (serialized UTF-8 bytes + 1,024), at least
  2,048 (`MIN_INPUT_ALLOWANCE`) and at most the price's `maxInputTokens`;
- output = the price's `maxOutputTokens` (chat requests are clamped to it with
  `max_tokens`);
- cost = the tariff of those input and output tokens.

In enforce mode the call is admitted only when that reservation fits what is
left of the run: `min(policy maxTokens, process maxTokens)` minus measured
usage, unknown holds and other in-flight holds, and the same for cost. The
input allowance is therefore `min(maxInputTokens, token headroom −
maxOutputTokens, cost headroom − output cost converted to input tokens)`.
A request whose estimate exceeds `maxInputTokens` is refused with
`catalog_budget_request_too_large`; one that fits the price but not the run's
remaining headroom is refused with `catalog_budget_exhausted`. Both happen
before dispatch and before an attempt row is written, so neither uses a model
call. With a 200,000 + 8,000 tariff and a 100,000-token process, a 10,000-byte
prompt reserves 11,024 + 8,000 tokens and the run continues with what remains.
A readiness check without a body (process availability, the question budget,
designer sizing and native test verdicts) asks whether a floor call
(2,048 + output ceiling) still fits.

The wrapper records the raw provider usage before SDK/Jev parsing or a later
abort check. Chat usage uses `prompt_tokens`/`completion_tokens`; raw Jev usage
uses `input_tokens`/`output_tokens`. These correspond to the provider formats
documented in [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
and [Jev](https://openrouter.ai/blog/insights/what-is-jev/).
Reported `usage.cost` is preserved as a provider charge, rounded up to USD
millionths. If the provider omits cost but supplies valid tokens, an explicitly
configured tariff can account for them; its source is stored as `tariff`, not
provider billing. Invalid reported cost does not silently fall back to a tariff.
Missing/inconsistent counts or absent pricing remain nullable and `unknown`.

In enforce mode, chat output is clamped to the configured output ceiling.
Serialized request bytes plus 1,024 is a conservative local estimate (one token
is at least one byte in practice). This is not a provider tokenizer or proof
about provider-added context. The decision API receives no invented output-limit
parameter. A provider can exceed a configured estimate or change its charge;
an overrun is recorded and prevents further inference/new action dispatch.
This bounds admission and detects overruns; it cannot guarantee an exact bill
from an external provider.

An attempt whose usage stays unknown (a timeout or lost connection after
dispatch, a successful response without usable usage, a gateway timeout such as
408/504/524, or a restart mid-call) keeps its full reservation as its charge:
its own estimated input plus the output ceiling. That reservation is the
call's upper bound in enforce mode, because the request fit it and output is
clamped to the reserved ceiling, so the run continues within its token, cost
and call caps instead of stopping. A provider rejection without a completion
(any other non-2xx status whose body reports no usage, such as 429 or 500) is
settled as zero: nothing was generated. Observe mode records the same statuses
without enforcing caps.

The already returned provider response and completed business receipts remain
recorded. A budget rejection cannot turn a successful write into failure or
authorize a repeated write. Reading recorded results and declining approval
remain passive. Existing root runs that predate the ledger retain their prior
inference count as unknown history instead of starting with invented zero
usage; that history has no reservation to charge, so such a run stops with
`catalog_budget_usage_unknown` in enforce mode and the person starts a new
request.

The provider's daily request limit is a separate request counter. Reaching it
reports `catalog_provider_limit`, not a ledger code.

## Recovery and inspection

At startup, an undispatched reservation becomes cancelled; a dispatched attempt
without a committed usage result becomes unknown and retains its hold. A crash
after a provider response but before the ledger commit is therefore uncertain.
It is never inferred to be free or automatically resent; its hold stays charged
to the run. Repeated restart, resume and command aliases cannot clear that
charge. There is no automatic unknown-resolution or refund operation.

The ledger uses `agent_inference_policy`, `agent_inference_run` and
`agent_inference_attempt` in the private identity database. Attempt metadata
contains model/revision, kind, status, reserved amounts, actual nullable usage,
cost source and overrun; it does not store prompts, credentials or business
arguments. `InferenceBudgetStore.summary` reports known amounts plus outstanding
holds, alongside unknown counts. A zero accounted amount with unknown calls
must not be presented as measured zero usage. Diagnostic UI/export is not added
here. Include these tables in the existing stopped-server identity backup.

Recovery assumes the existing single identity-server owner/process lock. It
does not add a multi-process lease or provider billing reconciliation. Custom
processes require explicit enforce-mode prices before any graph effect. Their
immutable root digest includes frozen process caps; all child models share
the minimum of workspace/process tokens and cost and the process model-call cap.
The call cap conservatively counts all reservations, including cancelled ones
(a refusal before reservation writes no attempt and is not counted).
Exact approval rejection and terminal recorded output remain passive after a
budget change. See [process execution and memory](service-processes.md).
The historical drain retains its
existing bounded-call behavior; this feature applies to native runs.

Admin-side model calls use the same wrapper under their own per-request root:
"Improve names with AI" during service import is a closed Mastra agent (one
step, no retries, structured output) under `catalog-enrich/<service>/<revision>/<id>`,
and the OAuth adapter recommendation runs under
`oauth-suggest/<service>/<config revision>/<id>`. Voice transcription, spoken
replies and meeting chunk transcription do not use the ledger yet: their
providers bill audio by duration or characters, which the token tariff and
the request-size admission check cannot express.

## Verification

```sh
npm run test:budget
npm run test:identity
node node_modules/typescript/bin/tsc --noEmit
```

Synthetic tests cover actual concurrent holds, cost/token caps, adaptive
reservations (a 200,000-input tariff under a 100,000-token process, headroom
across measured calls, cost-bounded input, oversized prompts refused before
dispatch, unknown usage charged exactly its reservation), pricing and
policy revisions, scope, malformed/missing usage, before-dispatch cancellation,
measured settlement, authenticated HTTP boundaries, audit rollback, actual
Mastra chat plus Jev, continuation aliases and retained successful writes. A
separate worker is killed with SIGKILL after its synthetic provider response
and before settlement; two subsequent restarts retain one unknown attempt
without resending it. Process tests additionally exercise two native agents
under one ledger, narrowed caps, cap-change refusal, final action dispatch guards,
retained confirmed writes and actual parent/child crash cuts. No paid model or
live business endpoint is used.
