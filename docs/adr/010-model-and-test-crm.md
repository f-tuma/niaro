# 010 — Optional server model and TEST-only Twenty directory

Date: 2026-09-24. Scope: user-authorized one-day testing of OpenRouter and a real Twenty workspace. Existing CRM records must remain unchanged; newly created test items must start with TEST. Follow-up: [profile 0.4](../protocol.md#contact-results-profile-04) now carries typed CRM results for client-owned contact cards.

## Decision

The model proposes an interpretation, never a command or approval. A strict schema permits meeting drafts, answers to an explicitly scoped contact question, short replies, and an optional TEST directory read. [ADR 011](011-conversation-memory.md) adds bounded partial meeting patches and topic reset for contextual requests; the legacy complete-draft schema remains separate. Allowed kinds are restricted separately for contextual requests and contact answers. Server validation rejects extra IDs, execution fields, inconsistent output, tool calls, truncation, missing titles in legacy complete drafts and nonzero seconds. Optional zero seconds are normalized to minute precision without altering the requested time.

The server converts local wall time using its configured IANA timezone. Invalid dates, nonexistent/ambiguous daylight-saving times, past meetings and meetings beyond one year are refused. A meeting without enough information requires clarification; a known time with ambiguous Peter uses the existing contact picker. The initial two participants were synthetic fixtures. The [server-tool follow-up](../server-tools.md) also permits verified TEST CRM contacts with valid email; their fields come from the adapter, not model output.

Inference holds no SQLite transaction. The server rechecks authentication, cancellation and the captured snapshot cursor before committing. One in-flight request per scope and two globally limit overlap. Durable command receipts are checked before inference, so replay of a committed command does not pay for another model call. Failed/aborted inference has no business effects. A provider error preserves the client's exact pending command for manual retry; the client does not automatically resend it.

Approval remains `proposal.decide` for a reviewed revision. A model response, a chat request to approve, a CRM result, or rendering a card cannot create an operation. The optional persisted `meetingDrafts` internal field preserves time/duration across restart and contact selection. Model interpretation initially kept profile 0.3; the contact-card follow-up uses `agent-client/0.4-fixture`. Old databases load without the optional fields. Back up the whole data directory before upgrade and do not open extended state with an older binary.

## Configuration and lifetime

Create directories with mode 0700 and files with mode 0600. Neither key belongs in `EXPO_PUBLIC_*`, client code, fixtures, logs, documentation or a committed environment file. Example shapes (replace placeholders privately, not through the client):

`.openrouter/config.json`:

```json
{
  "apiKey": "REPLACE_WITH_PRIVATE_KEY",
  "model": "openai/gpt-4.1-mini",
  "expiresAt": "2026-09-25T22:00:00.000Z",
  "maxRequests": 100,
  "timeZone": "Europe/Prague"
}
```

`.twenty/config.json`:

```json
{
  "baseUrl": "https://crm.example.com",
  "apiKey": "REPLACE_WITH_PRIVATE_KEY",
  "expiresAt": "2026-09-24T22:00:00.000Z"
}
```

After the user reauthorized the same OpenRouter key on September 25, its local window now ends at Prague midnight between September 25 and 26. The Twenty window remains at the earlier September 24/25 midnight; it was not extended. Expiry blocks new requests locally; it is not remote credential revocation. Configuration loads at process startup. Restart the backend after changing it. The OpenRouter cap persists per expiry window in `.openrouter/budget.sqlite` and counts failed/aborted requests before network I/O; previous-window usage is retained. Tests and the server share it; a restart does not reset it. The cap limits request count, not a precise currency total. Each call has a bounded input, 768 output tokens and a 20-second timeout. Provider price caps are $0.50/M input and $2/M output tokens.

Requests use the fixed OpenRouter HTTPS endpoint, reject redirects, require structured-output support, and request `data_collection: deny` and `zdr: true`. There is no automatic fallback that weakens those restrictions. Errors expose only safe application codes. Runtime logs and client errors do not include raw provider bodies or authorization headers. The current structured meeting context, bounded clarification exchange (up to six messages, 1,200 characters each) and two synthetic contact descriptions are included. Explicit new requests omit the previous meeting/history; expired context does not revive through old raw messages. New CRM responses contain typed fields plus a short count summary. Raw message history receives only that summary. The tool follow-up separately supplies up to five recent CRM IDs/names for 30 minutes, scoped to the account/workspace, so a subsequent meeting request can refer to them. Email/phone are not included in this recent-contact context. Explicit contact-choice options can include the validated email needed to distinguish candidates. Older text-only TEST replies may still appear in bounded history. The opt-in synthetic memory evaluation prints its own bounded synthetic model outputs for diagnosis.

## Twenty permissions in this implementation

The generated workspace OpenAPI schema was checked at `/rest/open-api/core`. Runtime `TwentyTestDirectory` only sends `GET /rest/people`, with `name.firstName[like]:"TEST%"`, depth 0 and limit 20. Returned records are filtered again and reduced to ID, name, job title and validated primary email/phone for the contact card. Additional addresses/numbers and unrelated private fields are discarded. The chat displays at most five cards; it does not claim a complete paginated inventory. Credentials are sent only to the configured HTTPS origin, with no redirects. The runtime contains no CRM mutation method.

The separately invoked provisioning script made one POST containing only the synthetic name and job title, then verified it by GET. Created person: **TEST Agent Client 2026-09-24**, ID `bfdcd207-4745-4bf1-a732-be096058ab6f`. No email address, company relationship, PATCH, PUT, DELETE or upsert was sent. Existing records were not modified. The script's default mode is read-only. Its fixed-name check is not a distributed idempotency guarantee: do not run creation concurrently or blindly retry after a lost response.

This adapter is deliberately not a general CRM agent. The tool follow-up supports bounded TEST-contact matching to a meeting participant. Reading arbitrary contacts, changing records, sending emails, full pagination and production account/permission mapping remain outside this delivery.

## Verification and references

Mocked unit tests cover schema/authority rejection, safe errors, expiry/budget/timeout, DST conversion, cursor conflict, revoked sessions, replay, no side effects, and TEST-only CRM reads. Real checks used synthetic prompts and one TEST CRM item. Browser tests deliberately left proposals unapproved; no calendar writes occurred during this delivery. The composer adds a busy indicator using the existing control; its disabled/accessibility behavior has a component regression test and browser coverage rather than a separate public component story.

Primary references checked during implementation: [OpenRouter quickstart](https://openrouter.ai/docs/quickstart), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [provider selection and privacy](https://openrouter.ai/docs/guides/routing/provider-selection), [model catalog](https://openrouter.ai/api/v1/models), and [Twenty API documentation](https://docs.twenty.com/developers/extend/api). Provider schemas and model behavior still require runtime validation.
