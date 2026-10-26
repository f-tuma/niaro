# Services, actions and AI routing

The console is served by the same Node process at `/admin/`. The client contains typed cards and command transport; credentials, action discovery, permissions, model requests and execution belong to the server.

## Console flow

1. **People / Workspaces:** create a company and workspace; add members and workspace access. Choose the current company/workspace once in the sidebar.
2. **Services → Add service:** choose **Configure with assistant** or **Configure manually**, then save the service's name, purpose, API/MCP URL and authentication in the service form. Both use the same form; the assistant path continues into the native process designer after the connection is saved. The icon defaults to the website favicon; choose **Custom symbol** to override it. Keys are write-only and encrypted in the identity database.
3. **Discover actions:** read OpenAPI or MCP tools. Twenty MCP first shows its searchable action catalogue with category filters and **Select all matching actions**. Choose any number from the catalogue; the server processes the selection in bounded batches and the console automatically continues, showing cumulative progress. Optional AI enrichment improves new names/descriptions using the assigned model; the console then asks for five new actions per request and shows "Describing actions: n of m" between them. Discovery runs in the background of the console: closing the sheet or leaving the service keeps it going, and the service's setup checklist shows the same progress. Imported actions are disabled drafts with no grants and confirmation required. Existing actions are not overwritten on rediscovery. An MCP tool labelled `readOnlyHint`, and a Twenty record read (`find_many_*`, `find_one_*`, `group_by_*` in its `DATABASE_CRUD` category), still arrives as a write; the result and the setup checklist offer **Mark as reads** for those tools, an explicit administrator choice. Marking turns them on as reads without approval and, when none of them was granted yet, grants them to the service's audience (everyone by default), so the agent and overview widgets can use them right away.
4. **Action editor:** edit name, description, binding, JSON input schema, effect, confirmation policy, enabled state and access. Grant organization/workspace roles or individual users; an explicit user denial wins. Services also have an Access gate that must pass before any action grant. Create and assign custom roles in Settings → Workspaces → Roles. Delete only after reviewing the inline confirmation.
5. **AI providers:** add an OpenAI-compatible endpoint and key; choose models from its catalog or enter an ID manually. Tool support is imported when declared by the provider; otherwise an administrator must verify and enable it explicitly. Models and credentials belong to the company, and only owners/admins can change them.
6. **Model routing:** choose the workspace router, speech transcription, optional Decision mode and per-service models. The router chooses an authorized service; that service's model chooses an action and prepares its arguments. Changing the selection changes the actual outgoing model ID.
7. **Chat:** enabled/authorized actions are available to the assistant. Actions requiring confirmation produce a native card in chat with parameters and Approve/Cancel. The server resolves the existing operation; the client does not infer or execute API calls.

The console starts with an empty service catalog. Connect each service through **Add service**; providers and models use **AI providers**. No built-in connector or legacy profile editor is exposed. Old connector/tool URLs redirect to Services, and the old AI URL redirects to Model routing. Recovery-key login opens account setup. Existing server-side adapter configuration and stored work remain intact for compatibility; they are not imported into the catalog automatically.

## Service setup and process overview

Service cards show purpose, host and a process count from one shared workspace
inventory. Opening a service starts on **Overview**: purpose, connection settings,
credential presence and available processes. **Configure with assistant** is also
in the service menu and opens the same setup flow used after adding a connection.
**Add process** and **Design changes** enter the existing native Mastra designer;
the model runs only after an explicit conversation message. Connection settings,
credentials and action discovery remain explicit human controls.

Choose a process to see its current draft and revision, exact active artifact,
latest saved version, test state and immutable history. **Draft** and **Saved
version** have separate definition previews: purpose, inputs, outputs, actions,
confirmation rules, models, memory and workflow steps. An older active version
outside the latest 20 history entries is fetched by its exact version. A newer
untested or failed version never borrows an older version's passing test state.
The test/version console provides the rest of the paginated history and private
test evidence. A controlled passing test does not establish live connection or
model quality.

Paused services stay paused; the assistant cannot implicitly enable them.
Personal sign-in (e.g. for a [hosted](hosted-servers.md) Microsoft 365 server) is
set up on the service's **Access** tab after it is saved, or with one click from
the setup checklist. Existing connections need no migration.

### Setup checklist

Administrators see **Setup** at the top of the overview: one row per step, each
_done_, _needs action_, _failed_ or _waiting_ for an earlier step, with one line
saying why and the button that fixes it.

| Step         | Done when                                                                                                                                                | Fix offered                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Address      | `catalog/probe` reached it (an MCP `initialize`, or any HTTP answer below 500 for OpenAPI)                                                               | Edit connection; Settings when the origin is not allowed                                                         |
| Sign-in      | none, a stored shared key, or personal sign-in with an enabled method / the service's own OAuth, requesting every permission the hosted definition lists | Edit connection; Add sign-in method (fields, redirect URL and permissions listed); Use _method_; Add permissions |
| Actions      | the service has actions; shows "Describing actions: n of m" while discovery runs                                                                         | Discover actions; Continue after an interrupted import                                                           |
| Access       | some actions are on and at least one read granted to someone can run unattended (what overview widgets use)                                              | Choose actions; Turn on reads (n) for MCP read-only labels and Twenty record reads; Find reads; Choose who       |
| Your account | (personal sign-in only) the administrator's own account is connected                                                                                     | Connect, in the app's Connections                                                                                |
| Test         | an enabled read without required inputs answered                                                                                                         | Test (runs it once, shows the result or the reason)                                                              |

A hosted server's definition can carry the sign-in it needs (`onboarding`); the
checklist then names the missing method, for example "Needs a Microsoft sign-in
method", until it exists, and **Use _method_** saves the personal sign-in.
A sign-in that lacks some of the definition's permissions (for Microsoft 365,
`Calendars.ReadWrite Mail.ReadWrite Mail.Send`) names them: the provider
would refuse every read with 403. **Add permissions** adds them; everyone
then signs in again to grant them. A failed test names the provider's
reason, and a 401/403 says the service refused access.
A refused sign-in save shows the server's reason (no method chosen, the method
is off or not OpenID, the service's own OAuth needs HTTPS) instead of a generic
failure.

## Guide: add an MCP service

1. **Services → Add service → Configure manually**, protocol MCP, the server's
   URL (`https://…/mcp`). A private or plain-HTTP address must be listed first in
   **Settings → Allowed addresses → Service addresses**. An installed connector needs none of
   this: its row has **Create service** ([Installed connectors](hosted-servers.md)).
2. Authentication: the server's shared key (Bearer or an `X-…` header), or
   _None_ when each person signs in with their own account (step 4).
3. On the service's overview, follow **Setup**: the address answers, then
   **Discover actions**. Leave "Name new actions with AI" off for a quick
   import; with it on, progress shows while each slice is described.
4. Personal sign-in: **Access** tab, _When to require_ "For every action",
   _Sign-in with_ an organization sign-in method (Microsoft or Google) or the
   service's own OAuth (HTTPS only), and the permissions to request.
5. **Actions** tab: turn on what the assistant may use and who may use it.
   Overview widgets read only reads that run without approval: mark the
   service's read tools as reads (**Mark as reads** after discovery, or the
   action editor's effect).
6. **Test** in the checklist runs one read; under personal sign-in connect your
   own account first (the checklist links to the app's Connections).

## Guide: connect Microsoft 365

Microsoft 365 runs as a built-in [hosted server](hosted-servers.md); each person
reads their own mail and calendar with their own Microsoft account.

1. **Hosted server.** Administration → Hosted → Add server → Microsoft 365,
   wait for _Running_ (the first start installs the pinned package).
2. **Microsoft Entra app registration** (entra.microsoft.com → App
   registrations → New registration), single tenant:
   - Platform _Web_, redirect URIs (both, on your public address):
     `https://<server>/admin/auth/callback/<sign-in method id>` (shown when you
     add the sign-in method in step 3) and `https://<server>/admin/service-connect`.
   - Certificates & secrets → New client secret; copy its value.
   - API permissions → Microsoft Graph → Delegated: `openid`, `profile`,
     `email`, `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`,
     `Calendars.ReadWrite`; grant admin consent for the tenant.
   - Note the Application (client) ID and the Directory (tenant) ID.
3. **Sign-in method.** Administration → Sign-in methods → Add → Microsoft:
   client ID, client secret, tenant ID, enabled. Copy its callback URL into the
   app registration (step 2).
4. **Service.** Back in Hosted, the server's row → **Create service**. With the
   Microsoft method in place, the service is created with personal sign-in for
   every action and the Graph permissions `Calendars.ReadWrite Mail.ReadWrite
Mail.Send`; otherwise its checklist says "Needs a Microsoft sign-in method"
   and, once the method exists, **Use _method_** finishes it.
5. **Actions.** Setup → **Discover actions**, then **Mark as reads** for the
   tools the server labels read-only (list mail, list events, …), and turn on
   the actions people may use (**Actions** tab).
6. **Connect.** Each person opens Connections in the app (or the checklist's
   **Connect**) and signs in with Microsoft; **Test** in the checklist then
   reads their mail.
7. **First widget.** In the app's Overview → Edit → Add → _Inbox_ or
   _Calendar_; Microsoft 365 is offered as a source once it has reads. A widget
   that cannot fill says why and offers the fix (connect the account, a model
   for the overview, the service) — see [Hub](hub.md#when-a-widget-cant-fill).

Owners/admins manage processes. A person who can open the console through a
different organization but is only a member of this workspace sees its permitted
service without management controls or process metadata requests. Session, role,
organization and workspace boundaries reset the setup state and abort stale
reads. Opening, selecting, reloading and reading history do not run inference,
test, activate a version or dispatch a business action.

EN/CS browser QA used actual isolated reference-server HTTP and synthetic native
model/action boundaries: desktop 1440×1000, mobile 360×844, dark and reduced motion,
both setup paths, partial sign-in failure/repair, global administration denial and
scoped member access. No live OAuth provider, CRM, model or physical Android
acceptance is claimed. See the [process contract and QA](service-processes.md#service-setup-and-lifecycle-overview).

## Working with long lists

The desktop sidebar and section header stay visible while the page scrolls. On phones, company/workspace selection and navigation move into the menu drawer. New page navigation starts at the top; browser Back uses the router's saved scroll position. Supplemental explanations use focusable help buttons (hover, keyboard focus or tap); errors and confirmation consequences stay visible.

- **Services → Actions:** search by name, description or API binding, filter enabled/paused actions, and page through 25 rows at a time. Select the page or all matching actions; selections survive filtering and paging. **Edit selected** changes only the fields explicitly chosen: enabled state, confirmation policy or allowed roles (the command also takes the effect, which **Mark as reads** uses; an HTTP action other than GET stays a write). Individual user overrides and action bindings remain unchanged. The server checks the service and every selected action revision before applying the entire batch in one transaction. A stale selection changes nothing; use **Reload saved version** and select again. Only owners/admins can submit these edits.
- Individual actions and provider models open in a side panel with a scrolling form and visible save controls. Closing returns focus to the originating item, or to search when that item is no longer present. Validation errors are displayed inside the panel.
- **AI providers:** search and page through saved models. Select multiple models to enable/pause them. These existing per-model commands run sequentially; a failure stops the queue and leaves unfinished models selected. Completed changes remain saved. This differs from the atomic action batch.
- **People / Workspaces:** search names and email addresses, filter account roles, and expand membership only for the workspace being edited. Select/clear the visible members, then explicitly save. Partial failures retain completed changes and keep the remaining draft. Administrators' inherited workspace access is not edited here.
- **Audit:** compact mobile rows open the same detail panel as the desktop table. On phones the filters live behind one Filters button. Pagination stays within reach.

## Selecting and assigning models

In **AI providers → Choose from catalog**, search by name or API ID, filter by tool capability, and select up to 50 models per import. The catalog is paginated in a bounded-height list; changing search/page preserves the selection. Already added models are marked and cannot be duplicated. Import preserves existing names, enabled state and tool declarations. The company stores at most 500 models; a batch that exceeds that limit writes nothing.

Discovery reads the configured OpenAI-compatible `GET /models` endpoint on the server. The console displays optional context length. `supported_parameters` containing `tools` enables tool calling; an explicit list without it marks the model unsupported. Missing metadata remains unknown. **Verify support** opens the manual form with the capability unchecked; it does not probe the model or infer capability from its name. Text-only/unknown models cannot be bulk-selected for service execution. Current discovery accepts one bounded response of up to 5,000 records; provider-specific remote pagination and other provider API dialects are not implemented.

**Model choice** sets a workspace default and optional service overrides. The workspace default is required to select the service; its override then selects the action and arguments. **Use workspace default** removes the override and shows the effective inherited model. A service can also be configured through its **Model** tab. Only enabled providers/models with tool support appear in assignment choices, grouped by provider, with search when there are more than eight choices. A disabled existing assignment stays visible as unavailable until replaced or cleared. Saving is revision-checked, and a refreshed catalog does not silently overwrite an edited routing draft.

`POST /admin/api/identity/catalog/models` returns `{models: [{model, name, tools: boolean | null, contextLength: number | null}]}`. The new `importModels` catalog command accepts `providerId`, `providerRevision` and 1–50 unique `{model, name, tools}` entries plus the existing organization/workspace scope. Both operations require current owner/admin authority. Imports are transactional and audited. No database migration or native workflow protocol version change is required.

Model selection does not make an inference request. Verify the normal flow with `npm run test:identity`; rebuild the console with `npm run admin:build` and restart the configured server to serve updated assets. Saved model/routing changes take effect immediately without another restart. Tests use synthetic transports; live model quality and cost are separate checks.

## Service icons

`iconSource` is `favicon` by default, including existing catalog records without this additive field. `custom` explicitly selects the existing `icon` symbol. The same symbol is the fallback if an automatic icon cannot be loaded. Editing the URL shows a debounced preview before saving; cards, details and routing use the saved service URL.

The authenticated server reads the origin’s `/favicon.ico`, then up to three same-origin `icon` or `apple-touch-icon` links from its homepage. It never sends the service API key, cookies or a referrer and does not use a third-party favicon lookup service. Current formats: bounded PNG, ICO and GIF; SVG, other-origin assets, redirects, unsupported images and offline sites fall back to the symbol. API-only hosts may therefore require a custom symbol.

The resolver reuses pinned-address transport, HTTPS/private-origin policy and cancellation. Each response is limited to 128 KiB, dimensions to 1024×1024 and total discovery time to six seconds. A separate queue allows four icon fetches and up to 128 pending requests, so rendering cards does not consume action/discovery slots. Up to 64 scoped in-memory entries cache successes for six hours and misses for ten minutes. No favicon blobs are stored in the database.

`POST /admin/api/identity/catalog/icon` accepts the catalog organization/workspace plus either `serviceId` or a preview `url`, and returns `{dataUrl: string | null}`. URL previews require owner/admin; saved icons require current catalog visibility. Authorization is checked before cache reads, every outbound request and final delivery. The client receives only validated raster data URLs, keeping the existing same-origin CSP.

## Supported discovery and execution

- OpenAPI **3.0/3.1 JSON**, relative HTTP paths, GET/POST/PUT/PATCH/DELETE, scalar path/query parameters and JSON bodies. The configured API base must agree with the document's server URL. An explicit document URL must remain under the same origin and base path.
- Local `$ref` expansion with cycle/depth/node/byte bounds. Unsupported operations are reported and skipped. YAML, external refs, callbacks, server variables, multipart bodies and arbitrary documentation scraping are not implemented.
- Remote MCP **Streamable HTTP**, protocol `2025-06-18`, initialize/initialized, paginated tools/list and tools/call; JSON and bounded SSE responses. No local stdio processes, command installation, sampling or MCP OAuth flow. Tool annotations do not grant permission or bypass approval: `readOnlyHint` is reported to the administrator (`readOnly` in the discovery response) and applied only through **Mark as reads**.
- Twenty MCP's progressive catalogue is recognized by its server identity and catalogue tools. Discovery calls `get_tool_catalog` and `learn_tools` for metadata only. A saved action pins a concrete `catalogTool` within `execute_tool`; user/model arguments cannot replace that target. General MCP discovery stays on `tools/list`.
- Local canonical JSON Pointer refs (`$defs`/`definitions`) support recursive MCP filters with schema/input depth, size, node and validation-work bounds. Remote refs, ambiguous URI fragments and recursion without consuming input are rejected. Unsupported/missing schemas return typed per-action reasons and a bounded schema path, shown in a collapsible EN/CS summary. Raw compiler errors and schema values are never included in these diagnostics.
- API authentication: none, Bearer or a custom `X-…` header. Provider authentication: Bearer. OAuth credentials for individual services require a future adapter.
- Bounded JSON Schema object inputs, including root `anyOf`/`oneOf` alternatives that each describe objects. The original schema and local-reference base are preserved. Union width uses the total schema budget instead of an eight-variant cap: 32 KiB serialized schema, 1,000 schema nodes, depth 12; inputs have a 64 KiB transport/argument limit, 10,000 nodes and depth 32. Validation preflight counts repeated evaluations (10,000 visits, depth 128) to bound recursive alternatives.
- `pattern` uses [RE2JS](https://github.com/le0pard/re2js) through [AJV's custom regex engine](https://ajv.js.org/options.html#code-v7), never a native backtracking fallback. Supported syntax: ASCII literals/classes/ranges, anchors, groups, alternatives, quantifiers, escaped punctuation and `\d`/`\D`/`\w`/`\W`. Bare dot preserves ECMAScript line-terminator exclusions; legacy literal braces such as `^{{[^{}]+}}$` are normalized without editing the stored schema. Unsupported escapes, lookarounds, backreferences, inline flags and POSIX classes are rejected explicitly. Unicode input is supported. Each pattern is at most 512 characters / 4,096 compiled instructions, with a conservative repetition-expansion check before allocation and a total of 16,384 compiled instructions per schema; repeated matching has an additional 4-million instruction-character preflight budget. AJV instances are scoped to a validator to avoid retaining all discovered schemas indefinitely.
- No remote schema references or executable format validators. `format` remains descriptive metadata; concrete `pattern`, type, length, required fields and other supported constraints are enforced.
- AI discovery edits presentation only; endpoints, schemas and policy come from the validated API definition and administrator configuration. The model cannot approve a call, select arbitrary URLs or grant itself a role.
- A generic chat turn runs at most one action. Successful results use server-selected contact, event, record-list, detail or text presentations inside the action card (see below). Multi-action plans are not implemented.

Twenty selections are checked against a fresh catalogue. Each request learns at most 20 selected operations (schema requests in groups of four; AI labels in groups of five), then returns a continuation with remaining names and the resulting service/policy revisions. The console follows it automatically. Each batch commits atomically; incomplete AI responses leave that batch untouched, and **Continue import** retries its remaining work. Previous successful batches stay saved. Refreshing/leaving the page stops further batches; selecting the catalogue again skips saved actions. A connection or permission change requires a fresh selection. Discovery allows 120 seconds per request, with a 125-second browser deadline. AI responses must cover each index exactly once; plain JSON and a single JSON Markdown block are accepted. Existing actions do not consume AI labeling requests. The additive optional `issues` array in discovery responses carries `action`, a typed `reason`, and optional `path`/`keyword`; legacy `warnings` names remain for compatibility and progress counting. The console accumulates reasons across batches.

After upgrading schema support, run `pnpm install --frozen-lockfile`, rebuild the console with `npm run admin:build`, and restart the server with its existing profile. Reopen **Load actions** and select the remaining entries; previously imported actions stay unchanged. No database migration is needed.

## Authority and failure semantics

Workspace membership is required for every request. A role grant **or** individual allow enables an action; individual deny overrides both. Owners/admins may configure actions but do not bypass their execution policies. For services that need the person's own sign-in (for every action, or for changes), the person manages those actions instead: the service access gate decides who may connect, an administrator-disabled action is unavailable to everyone, and within that each person's own on/off and approval apply, never the action's roles or approval. See [who manages the assistant's permissions](service-authentication.md#who-manages-the-assistants-permissions). Disabling a service/action or revoking membership is checked again at dispatch. Optimistic revisions prevent stale edits or stale approval.

The organization **policy epoch** retires work in progress (chats, pending approvals, connector and test runs) that was admitted under authority someone may no longer have. It moves only when a change can take authority away: a member's role changes or they are removed, workspace access or a workspace role changes, a catalog entry that existed before is removed or changes anything beyond its name, description or icon (credentials, URL, enabled state, roles, user overrides, approval, bindings, routing), sign-in provider changes, or service sign-in settings other than the hint change. Accepting an invitation, creating a workspace, adding services, actions, providers or models, importing actions (they arrive disabled) and renaming things keep it. A person changing their own choices for a personal-sign-in service keeps it too: it is audited, bumps only their own revision for that service, and dispatch rechecks it. Declining a pending approval is passive and is never refused because the epoch moved.

Secrets use AES-256-GCM with scope/record-bound authenticated data and a key derived from the private identity secret. Secrets never enter browser catalog DTOs, prompts or audit details. Model providers receive the user's current message, a bounded recent history and authorized action metadata. The selected service receives validated action arguments.

Each operation has a durable scoped receipt and immutable arguments. Retries read that receipt rather than repeating the write. A timeout/interruption after a possible write becomes **unknown**, not success or automatic retry. Restart converts interrupted writes to unknown. Verify the external service before starting a new request. Results can still be recovered after model or service configuration changes. Full parameters remain on the server; completed chat cards omit the review payload.

Failures now retain a bounded diagnostic alongside the receipt: error code, category, execution phase, optional HTTP status and reported message, up to eight field issues, and a suggested next step. Local schema rejection names the field without copying its value. HTTP and MCP errors preserve allowlisted diagnostic evidence, including JSON-RPC and nested error envelopes; credentials, headers/cookies, HTML, raw bodies and media are excluded. Provider messages remain untrusted data and grant no permission. The same evidence reaches the agent and checker, including after approval; read-only chat cards and Loops explain the cause and next step. Old completed failures without a recorded cause explicitly say it is unavailable.

The diagnostic projection prefers a concrete `error` or `cause` over a generic wrapper message, including the native Twenty MCP `ToolOutput` shape. HTTP `messages[]` remain readable rather than being replaced by an exception name such as `BadRequestException`. Sanitization and limits apply before choosing the message. Twenty's [create service](https://github.com/twentyhq/twenty/blob/dca6b57ff995e38ead9f09a95306c8628f860ee4/packages/twenty-server/src/engine/core-modules/record-crud/services/create-record.service.ts#L96-L112) illustrates why the wrapper alone is insufficient. Previously saved generic messages cannot recover a discarded cause.

MCP initialization is authorized separately from the actual `tools/call`: a failed handshake before the action is sent is **failed**. After a write request is sent, an error remains **unknown**, even when the provider reports input rejection, because a generic transport cannot prove that no partial effect occurred. The next step is verification, not an automatic corrected retry. The model planner blocks further writes in that task while an earlier write has an unknown outcome; read-only verification remains available. A new explicit request starts a separate turn, while the old receipt keeps its original status. Replay never dispatches again. Losing access during execution suppresses provider details and retains only a safe permission error.

For an unresolved failed or unknown write, the reply checker must affirm that the final reply is supported with sufficient confidence; a missing or uncertain decision does not approve the claim. It receives bounded canonical action inputs alongside receipt status and failure evidence. One repair is allowed, then the server rechecks the reply and falls back to the canonical failure message/card if the check still cannot confirm it. A contact found by email with a different name, or a record already created by an earlier request, does not establish that the new create succeeded. Contact creation instructions call for checking the email separately when a read tool is available and explaining a conflict without silently changing or merging identities. These instructions do not constitute a universal uniqueness check or permission to update an existing record.

Activation requires restarting the reference server; rebuild `pnpm admin:build` first for the new Loops explanation. The existing mobile `service.action` v1 shape is unchanged: diagnostics use its existing reply, summary and fields, plus the passive card renderer. No new native build or Metro restart is needed. Tests use scripted providers and isolated stores (`tests/action-failures.node.ts`, `tests/action-failure-receipts.node.ts`, `tests/action-failure-agent.node.ts`); they never retry an actual CRM write.

The transport validates all DNS answers and pins the chosen address, verifies TLS, rejects redirects and compressed bodies, and bounds time/size. Public HTTPS is the default. Private/local endpoints must be explicitly allowed by the operator in `administration.identity.integrationOrigins`; workspace admins cannot expand that allowlist.

## Current operating limits

Single Node process and local SQLite/WAL, not a multi-instance cluster. Catalog limits: 100 services/workspace, 1000 actions/service, 50 providers/company, 500 models/company. Daily provider request budgets are persisted and shared across that provider's models; they are request counts, not a monetary/token quota. Two concurrent chat interpretations, eight console integration requests, 20-second outbound request timeout, 2 MiB response limit and 64 KiB action input limit. At most ten pending action approvals per user/workspace.

Workflow storage still has prototype bounds (500 messages/conversation, 2 MB client response limit; command receipts are unbounded since NIAR-25). Starting a new chat session archives the previous messages on the server and clears the fixture's short-term focus. The archive is not yet connected to model retrieval or long-term personalization; automatic retention and pagination are also missing. Do not remove receipts to make space: that would invalidate replay guarantees. Production lifecycle/retention and generic result pagination are required before sustained public use. Identity/invocation data also need an operator retention policy. The model planner's paused-task context still has separate session and source-validation gaps.

## Protocol and tests

Workflow profile is `agent-client/0.8-fixture`; `service.action` capability 2 adds optional passive `presentation` data to the existing version-1 action result. Stored 0.2–0.7 workflows, auth sessions, local credentials and cached snapshots migrate without discarding work or pending commands. Network payloads still require the current profile. Existing mobile builds must be updated alongside the server. Old results without a presentation remain valid and retain their original detail view; upgrading does not re-execute them.

`npm run check` includes synthetic OpenAPI/MCP/HTTP tests, role denial, encryption, pinned destinations, schema expansion limits, concurrent approval, revocation around dispatch, restart recovery, two-model routing, card replay after concurrent chat updates and durable stale-approval rejection. No real provider/CRM call is needed. Component stories cover EN/CS, approval, full parameters, success and unknown outcomes; console UI is verified through the isolated browser test environment instead of duplicating full server pages in React Native Storybook.

### Result cards in chat

The server projects a successful service response into a bounded display contract. The app only renders that contract; it never interprets provider JSON, chooses API bindings, or fetches more records while expanding a card. No additional model call is needed to format results. Approval, failure and unknown-outcome controls remain separate from passive result content.

- **Contacts:** names, optional valid email/phone and job title. Supports canonical contact objects and Twenty `name`, `emails` and `phones` fields. Missing or invalid addresses are not invented.
- **Events:** title, explicit-offset start/end timestamps and optional location. The client formats the instant in its local timezone and displays the zone. Ambiguous local times, all-day dates and reversed intervals use the generic fallback; no timezone is guessed.
- **Records/detail:** named list items with optional description, or up to six scalar fields. Scalar labels come from source field names with word separation; they are not translated or interpreted by an LLM. Complex nested fields stay available only in the source preview.
- **Text:** plain selectable text, without HTML, executable code or automatic links.

Recognized wrappers include REST `data`/`items`/`results`, contact/event collections, GraphQL `edges.node`, MCP `structuredContent`, and JSON in MCP text blocks. Structured MCP content wins over duplicate text. Mixed media and unrecognized structures retain the previous source-detail fallback; this is deliberately a supported subset, not arbitrary API understanding or an editable mapping engine.

At most ten items are projected, initially showing three. **Show more** expands already received rows. When the provider reports another page or the server caps results, the card asks for a narrower request; it never promises a remote load. Empty partial pages are distinguished from a definitive empty result. Text/field clipping uses an ellipsis. The collapsed source preview remains bounded to 1,800 characters and may also be clipped; it is not a full response export. Existing 64 KiB operation-result and workflow snapshot limits still apply.

The operation receipt retains the original source result. Chat persistence stores the validated presentation, and replay requires no model/service call. For subsequent model history, result messages are reduced to server-owned status/count summaries: free text and record names from a service cannot become purported prior assistant instructions. Follow-up references use the separate server context described below. Speech reads a short server-generated summary; the display data itself grants no authority.

Rebuild the app (`npm run build` for export or restart its development server), rebuild the console (`npm run admin:build`), and restart the reference server with the existing profile. Stories under **Workflow / Service action** cover EN/CS, empty results, long values and each presentation type. `tests/service-presentation*.test.ts`, `tests/service-action-card.test.tsx` and the MCP workflow case in `tests/service-catalog.node.ts` cover mapping, bounds, passive expansion, storage/replay, isolation and model-history provenance.

References: [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.1.html), [MCP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), [Better Auth cookies](https://www.better-auth.com/docs/concepts/cookies).

### Following up on a contact card

After a **fresh successful catalog contact lookup**, the next request can refer to a displayed contact by name, email or position: for example “Prepare a meeting with this contact” or “With the second Jana.” The workspace router resolves the reference; the selected service model still prepares one authorized action. Ambiguous matches produce one short question in the main chat. Answering that question keeps the earlier request in the bounded history. The app needs no new menu or business logic.

Only the latest result marker within the last eight conversation messages is eligible, for up to 30 minutes from the lookup completing. A newer non-contact/empty card or legacy workflow result blocks the older contact list. Partial pages cannot establish uniqueness for an implicit “this contact”; explicit displayed positions still refer to the card's original order. At most ten contacts are considered. This is short-term reference resolution, not long-term memory or remote pagination. With Decision mode enabled, eligible receipts also participate in the progressive workflow described below.

The server receives result references from its own stored conversation, loads the same user's workspace receipt and checks organization, successful read status, current source permission and exact service/action revisions. It projects only bounded name, optional exact string ID, valid email and phone. IDs needing trimming, unsupported numeric IDs and missing fields are omitted; clipped names are never used as exact identities. Original JSON, descriptions and arbitrary source instructions stay out of ordinary assistant history. Eligible fields are supplied to the resolver as explicitly untrusted tool data.

One extra call to the workspace router resolves eligible context; unrelated requests return to ordinary routing. The source reference is pinned before this call, so a retry cannot silently choose a newer card. The service planner sees the selected name and available field names, using whole-value `$contact.id`, `$contact.name`, `$contact.email` or `$contact.phone` tokens for contact arguments. The server substitutes exact values, then applies normal action-schema validation. Invalid or unavailable bindings return a concise chat response without invoking the service. These tokens prevent invented values **for bound arguments**; they do not prove the semantic meaning of arbitrary API fields. Model selection/argument planning remains fallible, and administrator-defined action grants and approval policy still apply.

Pending operations retain source lineage. Revoking, changing or disabling that source blocks a subsequent approval/dispatch. The 30-minute limit applies to new context use, not to explicit approval of already materialized parameters. Expiry while a service call is in flight must not hide its durable outcome. Replay never reruns the resolver, performs another write or refreshes the lookup timestamp.

To run this update, restart the reference server with the existing profile (`npm run server -- <profile.json>`); no dependency, UI build or wire-profile change is required. Older receipts without a completion timestamp remain viewable/replayable but cannot become fresh context: perform the contact lookup again. The generic follow-up path uses configured catalog actions; it does not inject generic identities into the legacy built-in calendar adapter.

Verification: `npm run check`. `tests/contact-context.test.ts` covers projection, provenance and bounded token substitution; the contact-context cases in `tests/service-catalog.node.ts` cover real server routing with synthetic model/service responses, clarification, persisted history, replay, expiry, source barriers and revocation. No new UI component is added; questions and results reuse existing chat/card rendering. Live-model Czech interpretation and physical-device QA remain separate checks.

## Server functions: speech and Decision mode

Only company owners/admins can configure these workspace choices. Models remain company-owned; each workspace chooses its own assignments. Catalog models declare `kind: chat | decision | router | transcription`, `tools` and `audioInput`; old records default to chat without audio. Provider discovery reads audio support from `architecture.input_modalities`, except for model routers (`architecture.tokenizer: Router`) whose forwarding modalities do not qualify them for transcription. Routers retain any declared tool support and can serve ordinary tool routes; only Decision models can use the Decisions API. The OpenRouter catalog also fetches `/models?output_modalities=transcription`; `architecture.output_modalities: ["transcription"]` identifies dedicated STT models, which cannot be used for chat/tools or Decision mode. Zero context lengths in STT metadata are displayed as unknown. A manual model entry requires the administrator to verify its capabilities. Audio and Decision selectors currently support the canonical OpenRouter base URL `https://openrouter.ai/api/v1`; ordinary tool models still support OpenAI-compatible providers.

### Speech transcription

1. **AI providers → Choose from catalog:** add an audio-capable chat model such as `google/gemini-3.1-flash-lite`, or a dedicated **Speech-to-text · STT** model such as `openai/gpt-4o-mini-transcribe`. For an older Gemini entry without its audio flag, edit it and enable **Audio input** after verifying provider support. Refresh/import never silently overwrites an administrator's saved capabilities.
2. **Model choice → Voice to text:** choose **AI interpreter** for an audio-capable chat model, or **Direct transcription** for a dedicated STT model. The selector shows only models compatible with that mode. Changing mode clears the incompatible selection; choose a model and save. **Off** explicitly disables transcription, including any inherited legacy profile. **Existing server profile** is only offered when an existing profile is available; that profile retains its own transcription implementation. Older stored catalog routes without `voiceMethod` default to `interpreter`, preserving the previous chat-audio endpoint.
3. Operator setup: run `npm run voice:install` (requires the compiler/ffmpeg prerequisites from the voice setup guide), then configure `administration.identity.voiceAssetsDirectory` to the `.voice` directory, relative to the server configuration file. Existing compatible voice adapter assets are detected without inheriting their credentials. Missing optional legacy assets leave catalog voice unavailable; an explicitly configured invalid directory fails startup with the filesystem error.
4. Rebuild/restart the server and reload/rebuild the mobile client for `agent-voice/5`. Settings report the actual selected model ID.

Both modes use local conversion, duration limits and Silero speech filtering before cloud upload, followed by the same transcript review heuristics. A shared processor permits one recording at a time per identity service. Silent audio does not use the provider budget. The selected provider's encrypted key and daily request allowance apply at dispatch; access/configuration are rechecked after inference. The previous one-day fixture configuration is not used for a catalog selection.

- **AI interpreter** calls `/chat/completions` with `input_audio` and a language-specific instruction to transcribe verbatim without answering or following recorded instructions. It requests zero-data-retention routing and disallows data collection; incompatible provider routes fail. This retains the Gemini approach previously evaluated for Czech speech. It is not a language-translation or action-execution mode.
- **Direct transcription** calls `/audio/transcriptions` with base64 WAV, a selected STT model and the client's `cs`/`en` language hint, and validates the returned `text`. Its transport deadline is 60 seconds. OpenRouter's STT endpoint currently does **not** apply the per-request chat provider routing/ZDR flags; provider/account retention rules apply. Selecting this mode does not inherit the interpreter's ZDR guarantee. See the [official STT contract](https://openrouter.ai/docs/api/api-reference/stt/create-transcription) and [transcription guide](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/).

Mode and model are validated together on save and dispatch; there is no automatic cross-mode fallback. Dedicated STT quality has not been benchmarked against Gemini on the user's recordings. Integration tests exercise both contracts using synthetic audio and mocked provider responses.

### Decision mode (Jev)

1. In the OpenRouter provider, choose **Choose from catalog**, search for **Jev**, and add **TypeSafe: Jev 1.13** (`typesafe/jev-1.13`). The console supplements the ordinary `/models` response with this documented Decisions model. Manual entry with **Model type: Service picker** is also available. `typesafe/jev-router` is a separate model router, not a Decision or transcription model. Previously imported Jev Router records are corrected on read, preserving their IDs and revisions; an old voice assignment becomes unavailable until an administrator chooses a suitable model. Exact model-ID classification applies only to the canonical OpenRouter provider.
2. In **Model choice**, turn on **Service picker** and select its model (Jev). The model type is **Service picker**, and the threshold is **Required certainty**. Keep a workspace default tool model for fallback and service execution. Save.
3. Start with the 80% confidence threshold, then tune it with representative requests. This is an initial routing threshold, not a measured correctness rate.

Decision mode now drives **progressive execution**, rather than selecting a service only once:

1. Decide whether a new message resumes a pending question/recent contact result or starts a new task.
2. Choose the service for the next unmet prerequisite using the original request and completed read results.
3. Narrow to an allowed action. Large candidate sets are grouped into at most twelve choices per level; groups list their members within a shared 60kB metadata budget (long descriptions are explicitly shortened), and every candidate remains reachable. Selected subgroups restore fuller descriptions. Selection tools carry metadata and empty argument schemas.
4. Give only that action's complete input schema to the model assigned to the service. It can call the enabled internal datetime plugin to calculate exact timestamps.
5. Validate and invoke through the normal catalog controller. A successful read feeds the next decision. The first write, approval request, uncertain outcome or failure stops execution. Approving a read can continue the saved task; writes remain terminal.

For example: **find a CRM contact → calculate a date → read calendar availability → prepare a calendar write**. The application renders the existing result/approval cards and short questions in chat. `agent-activity/3` adds a fixed compact row for the current step and phase: service, action, inputs, execution. Earlier activity profiles remain available. Neither UI nor the decision model executes business logic or grants permission.

The server calls OpenRouter's [Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) with explicit choices drawn only from currently allowed services/actions, plus fallback. A high-confidence choice skips the selector completion; low confidence delegates the same narrowed choices to the workspace/service chat model. Provider errors, malformed probability distributions and unknown choices fail instead of becoming guessed decisions. Each stage's decision is saved before parameter inference, including fallback, so retries do not repeat a completed decision. Empty catalogs still support ordinary conversation and pure datetime calculations.

Routing completions can only select an offered option or ask a structured clarification; they cannot execute datetime plugins. Standalone conversation and an explicit standalone datetime request have separate routing choices. Datetime remains available when filling a selected action's parameters. The latest user request is the goal; historical dates and earlier claims of unavailable services are not current instructions or access checks.

Only an explicit `ask_clarification` response or a server-detected missing input creates a pending question. Plain text completes the turn and preserves any latest result card. Older journals that marked every text answer as paused are not resumed automatically. A clarification about whether to continue retains the original provenance until the user resolves it; a new request starts with a fresh clock and no inherited calculations. Conversation history and completed operation receipts remain intact.

**Durable state and source binding.** The server journals the original goal, frozen clock/timezone, narrowing choices, plugin receipts, materialized plans and execution IDs. A clarification such as “the second one” reuses successful reads and the original clock. An unrelated request discards that context. Only the newest matching result/question in server-owned history can seed continuation; expired, inaccessible, changed or non-contact results do not fall back to an older contact. Source identity, current grants, revisions and policy epoch are checked again before inference and dispatch. Pending approvals keep their exact parameters even after the 30-minute fresh-context window; current access is still required. Expiry during an already dispatched successful write does not turn it into an unknown outcome.

Read results are bounded, data-only projections with explicit truncation markers. Parameters can refer to exact visible scalar values with `$step.1#/path/to/value`, to a selected contact with `$contact.email` etc., or to datetime outputs with `$plugin.result_1.utc` etc. Each original value is evaluated once: a source string resembling another token remains literal. Missing, partial, object-valued or forged bindings ask for clarification without dispatch. Models never receive secrets from the service configuration. Read-only goals spanning several results get a short synthesized answer alongside the final receipt card.

A turn permits at most **five new external steps, forty model requests and four pure plugin calculations**. If five reads complete the goal, a final completion decision can finish normally. Otherwise a user reply can continue with the successful reads retained and a new per-turn allowance, up to twenty external steps in the carried journal. Reaching that overall cap returns a saved result and asks for a new focused request. Exhausted pure-calculation slots are renewed on clarification; completed external plans already contain exact values and the original clock remains pinned. These bounds limit execution, not the number of configured actions exposed through progressive grouping.

Jev never approves a write or grants access. Role/user policy, argument-schema validation, configured action approval, revocation and durable execution receipts apply exactly as without Decision mode. Completed effects are never repeated during replay; ambiguous writes remain unknown. Repeating a completed read approval does not duplicate the next chat card. The current runtime is a bounded sequential workflow ending at its first write, not parallel orchestration or a background scheduler. Calendar-conflict interpretation and source relevance still depend on the configured models and action schemas; the generic runtime cannot prove arbitrary API semantics.

Each decision or completion consumes a request from its selected provider's allowance. The Decisions API is alpha; integration tests establish the orchestration contract, not model accuracy or latency. See the provider's [Jev usage guide](https://openrouter.ai/blog/tutorials/how-to-use-jev/) for confidence versus winning-option probability.

**Run the update:** `npm run admin:build`, restart the server using its existing profile (`npm run server -- .servers/current.json` locally), and reload the mobile/web app for activity v3. No model assignment, service configuration or approval policy is changed by this update. New tasks use progressive execution when Decision mode is enabled; stored legacy single-action turns retain their original replay behavior. Verification uses synthetic model/service responses in `tests/service-catalog.node.ts`, plus activity protocol, HTTP and card tests; real CRM/calendar writes are not part of automated development checks.

Routing changes use the existing workspace revision and organization policy epoch. Removing a referenced voice/decision model is rejected, including references in other workspaces of the same company. Deleting a service preserves these server-function assignments.

### Spoken replies (TTS)

In **AI providers → Choose from catalog** you can import a model with audio output
or a dedicated TTS model. **Model choice → Voice reply** is a separate workspace
choice, independent of transcription, decision and service models. Owners/admins
manage it. Both new and existing workspaces have read-aloud off by default.

- **Reader**: a chat model with text input and text/audio output. It uses
  OpenRouter `/chat/completions`, streamed PCM16 (24 kHz, mono), an instruction to
  read verbatim and the finished answer JSON-quoted. It has no tools and no
  permission to act on the content. The server requires `data_collection: deny`
  and `require_parameters: true`. A separate `speech.zeroDataRetention` defaults
  to `true`; an admin can turn it off in the voice model assignment. The
  provider's ordinary retention terms then apply, while the no-data-collection
  requirement stays. This setting does not change transcription or other models.
  A missing ZDR endpoint returns `speech_privacy_unavailable`, with no automatic
  lowering of protection.
- **Text-to-speech**: a model of kind `speech` from the
  `/models?output_modalities=speech` catalog; the server calls `/audio/speech` and
  requests MP3. This endpoint has its own contract and provider terms; it does not
  take the chat endpoint's ZDR parameters. The voice ID must match the chosen
  model.

Callout used `openai/gpt-audio-mini` (for example the `alloy` voice). A live
synthetic Czech test on September 26, 2026 returned a working 6.1 s PCM/WAV, but
OpenRouter refused to enforce ZDR for this model. Using it may therefore require
an explicit retention change for spoken replies in administration. This is not a
measured comparison of voice quality nor a check on a physical phone.

A separate profile `agent-speech/1` offers authenticated GET/POST
`/v1/:workspace/voice/speech`. POST accepts only the conversation ID and the
assistant message ID, a request ID and the language. The server picks the text
from that user's snapshot; no client text, model or endpoint is accepted. Session,
policy and the identical message text are re-checked before dispatch and before
delivery. The request draws on the provider budget; at most one synthesis runs per
scope and eight per server. Limits: 2,000 characters, 6 MiB of audio, 12 MiB of
upstream SSE, a 65 s deadline; reader PCM at most 120 s. An unfinished stream is
not played. Rule changes prevent delivery of the result, but a request already
sent may not stop at the provider immediately.

After an accepted voice query, the app automatically reads its latest answer
aloud if the server offers voice output. This can be turned off on the device in
**More → Spoken replies**. Typed queries are not read aloud automatically. Messages
have no replay buttons; for cards, the server's text summary is read. History
never plays by itself. The microphone, typing another query, navigation, the app
going to the background, disconnecting, a message change and turning spoken
replies off all stop playback, even while waiting for the answer. A web browser
may block autoplay; the answer then stays available in chat and the app reports
that voice is unavailable, without retrying automatically. The WAV/MP3 is only a
temporary file or Blob, not a workflow attachment; it is released after playback.
The mobile app gets the sound only after it is finished and verified on the
server, not as a live stream. The native player uses the existing expo-audio.

Verification: `npm run check`, `npm run admin:build`; targeted tests are
`tests/speech*.test.*` and `tests/catalog-speech.node.ts`.

Service execution uses only the configured shared API connection. Personal service OAuth and service-specific sign-in provider requirements are retired; authentication providers are reserved for server sign-in. See [server sign-in and workspace access](service-authentication.md).
