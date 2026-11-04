## ADDED Requirements

### Requirement: Members' external AI apps policy

Owners and administrators SHALL choose per workspace whether members may connect external AI apps: `off`, `review` (default) or `free`. The policy SHALL apply to people with the organization role `member` only; grants, app registrations and links of owners and administrators SHALL never wait for approval. A change SHALL be revision-checked (`mcp_policy_conflict`) and audited as `mcp.policy_changed`.

#### Scenario: New workspace

- **WHEN** an administrator opens External AI apps for a workspace nobody configured
- **THEN** the policy shows `review`

#### Scenario: Member tries to change the policy

- **WHEN** a member sends a policy change for their workspace
- **THEN** the server answers 403 `identity_forbidden` and the policy stays

#### Scenario: Concurrent policy change

- **WHEN** an administrator saves the policy from an outdated revision
- **THEN** the server answers 409 `mcp_policy_conflict` and keeps the newer policy

#### Scenario: Administrator not subject to review

- **WHEN** an administrator issues a manual grant in a workspace whose policy is `review`
- **THEN** the grant is active at once

### Requirement: Policy for manual grants

A member's manual grant SHALL follow the workspace policy: under `off` issuance SHALL be refused with 403 `mcp_external_apps_off`; under `review` the grant SHALL be stored `pending`, its token still shown once, and every MCP request with it refused with 403 `mcp_access_pending` until approved; under `free` it SHALL be active at once. A pending grant SHALL count toward the 50-grant limit and its expiry SHALL count from issue.

#### Scenario: Pending grant used

- **WHEN** a member issues a grant under `review` and an MCP client calls `tools/list` with its token
- **THEN** the request is refused with 403 `mcp_access_pending`

#### Scenario: Approved grant

- **WHEN** an administrator approves that grant and the client repeats the call
- **THEN** the tools are listed

#### Scenario: Policy off

- **WHEN** a member issues a grant in a workspace whose policy is `off`
- **THEN** issuance is refused with 403 `mcp_external_apps_off` and no token is created

### Requirement: OAuth apps belong to an organization

A newly registered OAuth app SHALL belong to the organization of the workspace named at registration and SHALL be linkable only into workspaces of that organization; consent into any other workspace SHALL be refused. Every app SHALL carry an approval state per workspace of its organization: `approved`, `pending`, `rejected` or none.

#### Scenario: Link into another organization

- **WHEN** a person who also belongs to a second organization tries to link an app registered for the first organization into a workspace of the second
- **THEN** the consent is refused and no grant is created

### Requirement: Policy for app registration

A member's app registration SHALL follow the named workspace's policy: refused with 403 `mcp_external_apps_off` under `off`, recorded `pending` for that workspace under `review` and audited as `mcp.app_requested`, `approved` under `free`. An owner's or administrator's registration SHALL be `approved` for that workspace. Every registration SHALL be audited as `mcp.app_registered`.

#### Scenario: Member registers under review

- **WHEN** a member registers an app for a workspace whose policy is `review`
- **THEN** the response carries the client ID with state `pending` and the workspace's review queue lists the app

#### Scenario: Member registers under off

- **WHEN** a member registers an app for a workspace whose policy is `off`
- **THEN** registration is refused with 403 `mcp_external_apps_off` and no client is created

### Requirement: Policy for OAuth links

When a member accepts consent for a workspace, the system SHALL refuse it with `mcp_external_apps_off` under `off`; under `review` it SHALL require the app to be `approved` there, else refuse it with `mcp_app_pending` (filing a pending request on the first attempt, audited as `mcp.app_requested`) or `mcp_app_rejected`; under `free` it SHALL allow any app of the organization. A refused consent SHALL create no grant.

#### Scenario: First link to an unapproved app

- **WHEN** a member accepts consent for an app that has no approval in the chosen workspace whose policy is `review`
- **THEN** consent is refused with `mcp_app_pending`, no grant is created and the review queue lists the app as requested by that member

#### Scenario: Link after approval

- **WHEN** an administrator approves the app for the workspace and the member links it again
- **THEN** consent succeeds and the client receives an authorization code

#### Scenario: Rejected app

- **WHEN** a member tries to link an app that an administrator rejected for the workspace
- **THEN** consent is refused with `mcp_app_rejected`

### Requirement: Consent shows availability

The consent information SHALL state for each workspace the person may choose whether linking is `available`, `request` (accepting files a request), `pending`, `rejected` or `off`, and the consent page SHALL explain the state in English and Czech before the person accepts.

#### Scenario: Waiting for approval

- **WHEN** a member opens consent for an app whose request is pending in their only workspace
- **THEN** the page says the app waits for an administrator's approval in that workspace and accepting is not offered for it

### Requirement: Reviewing external AI app requests

On External AI apps (`/admin/mcp`) owners and administrators SHALL see the selected workspace's pending requests — members' grants (person, label, mode, expiry) and apps (name, callback addresses, requester) — and approve or reject each with an optional reason of at most 500 characters. Decisions SHALL be revision-checked (`mcp_review_conflict`) and audited as `mcp.access_reviewed` or `mcp.app_reviewed`.

#### Scenario: Reject with a reason

- **WHEN** an administrator rejects a member's pending grant with the reason "Use the shared assistant"
- **THEN** the grant stays unusable and the member's account page shows it as rejected with that reason

#### Scenario: Member opens the queue

- **WHEN** a member calls the review queue or a review decision
- **THEN** the server answers 403 `identity_forbidden` and returns no requests

#### Scenario: Decided twice

- **WHEN** two administrators decide the same request and the second decision was made from the earlier revision
- **THEN** the second is refused with 409 `mcp_review_conflict` and the first decision stands

### Requirement: Administrators oversee members' access

Owners and administrators SHALL list the selected workspace's active member grants (manual and OAuth: person, label, mode, last use, expiry) and its apps with their state, SHALL revoke any member grant (audited as `mcp.access_revoked`) and SHALL withdraw an app's approval, which revokes every member's OAuth grant made through that app in the workspace (audited as `mcp.app_reviewed`).

#### Scenario: Administrator revokes a member's grant

- **WHEN** an administrator revokes a member's active manual grant
- **THEN** the member's next MCP request with it is refused

#### Scenario: Approval withdrawn

- **WHEN** an administrator withdraws an app's approval in a workspace where two members linked it
- **THEN** both members' OAuth tokens for that workspace stop working and new consents are refused with `mcp_app_rejected`

### Requirement: Tightening the policy

Switching a workspace to `off` SHALL revoke, in the same transaction, every member grant in it, manual and OAuth, active and pending; app states SHALL stay recorded. Switching from `free` to `review` SHALL keep existing active grants and approved apps; only new grants and apps SHALL wait.

#### Scenario: Turned off

- **WHEN** an administrator switches a workspace with three active member grants to `off`
- **THEN** all three stop working and the activity log records the policy change with three revoked grants

#### Scenario: Free to review

- **WHEN** an administrator switches a workspace from `free` to `review`
- **THEN** members' existing active grants keep working and a member's next new grant is `pending`

### Requirement: A person sees their requests

A person's account page SHALL list, besides their active MCP grants, their pending grants and their rejected grants with the reason, each with its workspace, in English and Czech. A pending or rejected grant SHALL be removable by its owner.

#### Scenario: Pending grant on the account page

- **WHEN** a member with a pending grant opens their account page
- **THEN** the grant is listed as waiting for approval with its workspace

### Requirement: External AI app activity

OAuth links SHALL be audited as `mcp.access_issued` like manual grants, with whether the grant is pending or active. Audit entries for external AI apps SHALL name the workspace, the acting person and the grant or app, and SHALL never contain tokens, client secrets or callback query strings.

#### Scenario: OAuth link recorded

- **WHEN** a member links an approved app through consent
- **THEN** the activity log records `mcp.access_issued` for that workspace with the member as actor

## MODIFIED Requirements

### Requirement: Manual access grants

The system SHALL let a person issue, from a live browser session only, a grant for one of their workspaces with a label, scopes from `data.read`, `memory.write`, `services.call`, and an expiry of at most 30 days; the user SHALL come from the session, never from input. The token (prefix `agent_mcp_`, 256 random bits) SHALL be shown once and only its digest stored. A person SHALL hold at most 50 active or pending grants per server. No scope SHALL permit approving an action.

#### Scenario: Token shown once

- **WHEN** a person issues a grant and later lists their grants
- **THEN** the listing shows label, scopes and expiry but no token

#### Scenario: Grant limit

- **WHEN** a person with 50 active grants on the server issues another
- **THEN** issuance is refused

#### Scenario: Retired scope

- **WHEN** a person issues a grant with the scope `native.run`
- **THEN** issuance is refused as invalid

### Requirement: Grant revalidation

The system SHALL check on every MCP call, and again inside every write or save it starts, that the grant is approved, unexpired and unrevoked, bound to this server and workspace, that the original organization membership still exists and that the person still has access to the workspace with their current role. Removing a member SHALL delete their grants; rejoining SHALL NOT restore them.

#### Scenario: Removed from the workspace

- **WHEN** a person loses access to the workspace after issuing a grant
- **THEN** further MCP requests with that grant are refused and nothing more is read or saved for it

#### Scenario: Grant still pending

- **WHEN** an MCP call is made with a grant that is still `pending`
- **THEN** it is refused with 403 `mcp_access_pending` and nothing is read, saved or dispatched

### Requirement: OAuth client registration

The system SHALL let a signed-in organization member register a public OAuth client (token endpoint authentication `none`) for one of their workspaces with a name and 1–5 callbacks, each HTTPS or plain HTTP on `localhost`, `127.0.0.1` or `[::1]`, and return its client ID and its approval state in that workspace. A loopback callback SHALL match any port at authorization; every other callback SHALL match exactly.

#### Scenario: Plain-HTTP callback

- **WHEN** a member registers a client with an `http://` callback on a host other than `localhost`, `127.0.0.1` or `[::1]`
- **THEN** registration fails with `mcp_oauth_redirect_invalid`

#### Scenario: Local app on a free port

- **WHEN** a production server has a client registered with `http://localhost/callback` and the client authorizes with `http://localhost:49152/callback`
- **THEN** the callback is accepted

#### Scenario: Workspace without access

- **WHEN** a member registers a client naming a workspace they have no access to
- **THEN** registration is refused with 403 and no client is created

### Requirement: OAuth authorization and consent

The system SHALL use the authorization-code grant with required PKCE `S256` and a signed authorization request. After sign-in, the person SHALL see the client's verified name, where it comes from (its `client_id` host, or registered manually on this server), their account, the requested permissions and how long the connection lasts, and SHALL explicitly choose the workspace and a subset of the requested permissions; nothing SHALL be selected automatically.

#### Scenario: Scope escalation

- **WHEN** a consent submission asks for a scope the client did not request
- **THEN** it is refused

#### Scenario: Plain code challenge

- **WHEN** an authorization request uses `code_challenge_method=plain`
- **THEN** it is refused

#### Scenario: Client known by its metadata document

- **WHEN** ChatGPT asks for access with the client ID `https://chatgpt.com/oauth/client.json`
- **THEN** the consent page shows the name from that document and `chatgpt.com`

#### Scenario: Client registered by an administrator

- **WHEN** a client registered on this server asks for access
- **THEN** the consent page shows its registered name and that it was registered manually

#### Scenario: App not linkable in the workspace

- **WHEN** a member accepts consent for a workspace where the policy or the app's state does not allow the link
- **THEN** the consent is refused with the policy's error and no grant or authorization code is created
