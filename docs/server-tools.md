# Server tools and TEST CRM meeting participants

The app remains a renderer of its local catalog: `crm.contacts`, `input.choice`, `workflow.progress` and `action.approval`. No CRM/model integration, matching, credentials or workflow decisions were added to the client. Workflow stays `agent-client/0.4-fixture`; JSON server profiles stay version 1.

## Registration and authority

`apps/server-tools/registry.ts` is a server-owned allowlist. A definition provides Zod input/output schemas, a required permission and an implementation. Invocation checks authenticated scope, permission, input and session before IO, then validates output, cancellation and session again. Failures expose bounded error codes, not provider errors. Model/client JSON cannot register implementations, change scope, supply URLs or grant permissions.

`createContactTools` registers two read-only tools when the server has a `ContactDirectory` adapter:

| Tool                  | Arguments                               | Result                                 |
| --------------------- | --------------------------------------- | -------------------------------------- |
| `crm.contacts.list`   | Empty strict object                     | Validated TEST contacts and `complete` |
| `crm.contacts.search` | Exactly one bounded `name` or UUID `id` | Matching TEST contacts and `complete`  |

The current server grants `contacts.read.test` to authenticated sessions using its configured TEST adapter. That adapter is server-wide; this is not a production per-user CRM entitlement system. Disabled CRM registers neither tool. Existing private configuration expiry remains enforced. Additional permissions/tools require trusted server code; there is no remote plugin installation or arbitrary tool-execution endpoint.

`ModelService` selects these tools from the supported interpretation, outside SQLite transactions. It retains bounded request progress, replay-before-inference, concurrency limits, and atomic cursor checking before commit. The model still cannot execute or approve a calendar operation.

## Contact resolution and cards

1. A CRM listing produces the existing client-owned cards, at most five results. Their fields come from the validated provider result.
2. A new meeting patch records partial facts without IO until date/time and identity are present. Unknown names are searched in the TEST directory; a reference to a recently shown CRM ID is freshly verified.
3. One verified match with email creates the existing proposal card. No artificial one-option question is introduced. Several matching contacts produce the existing contact-choice card. Selection by card or spoken answer is checked against that work item's candidates.
4. Zero matches, missing email or a truncated name search asks for clarification and produces no proposal. Missing addresses are never synthesized. An ambiguous participant correction keeps the previous proposal intact, asks for a fuller identity in chat, and retains the pending candidates for the next turn/restart.
5. Canonical contact fields are stored privately per scoped work item. Corrections reuse those fields and the same proposal identity, increment its revision and invalidate old approval commands. A currently approved/closed work item stays locked. Explicit reviewed approval remains necessary to create an operation; generated ICS has no invitation fields.

The model receives only bounded recent IDs/names (up to five, 30 minutes from listing, removed on explicit topic reset). It does not receive their phones/emails through this recent-contact context. Explicit input-choice details may include email to distinguish candidates. The structured output's allowed IDs are computed from current server context/options; unknown IDs and extra execution fields are refused.

The Twenty adapter still performs only the fixed `GET /rest/people` TEST-prefix request, limit 20/depth 0. Search is local, case/accent-insensitive token matching within that bounded response. There is no fuzzy-name confidence score or full pagination. Hitting the raw 20-record cap marks the scan incomplete even if non-TEST rows were filtered out; a partial name match is never presented as globally unique. Finding an exact UUID is unambiguous. Czech name normalization is proposed by the model; matching and canonical identity remain server decisions.

## Run and verify

Use the existing configured server profile with `model: openrouter` and `crm: twenty-test`, then restart it:

```sh
npm run server:check -- .servers/current.json
# After stopping the previous owner and backing up .fixture-calendar:
npm run server -- .servers/current.json
npm run server:pair -- .servers/current.json calendar-user a
npm run check
```

Pair the app with `http://localhost:8793/v1/a`. A valid authorized Twenty test window is required for live lookup. Try a TEST person's name that exists with an email, then change the time conversationally. `Show me the test contacts from the CRM.` followed by an unambiguous reference to a displayed contact also works. The previously created **TEST Agent Client 2026-09-24** has no email; it needs explicitly authorized provisioning before a live meeting test, not an invented fallback.

Database version 2 has additive optional private `meetingContacts`, `recentContacts`, and pending contact-choice context. They do not enter public snapshots as new fields. Existing data loads unchanged. Use a pre-upgrade backup for rollback to an older strict-schema binary.

Verification on September 25: **370 tests / 47 suites**, clean lint/types/import boundaries. Controlled CRM/model tests cover canonical fields, permission and input rejection, missing email, ambiguous/non-TEST/incomplete results, replay, restart, scope, late abort/revocation/cursor conflicts, corrections and revision-bound approval. Browser QA uses the real app and HTTP reference server with synthetic adapters, EN/CS, 320/393/1001 px: listing → unique proposal → time correction → another ambiguous meeting → select second person → canonical email. No page/runtime errors or horizontal overflow. Screenshots were checked after sheet animations completed.

No live Twenty request, paid model call, CRM mutation or calendar write was made in this delivery. Native/physical devices and real-model Czech name resolution were not re-evaluated. The expired Twenty test window was preserved. The next step is an explicitly authorized live TEST contact with email, then end-to-end validation against the real CRM and model.
