# Server sign-in and workspace service access

The app authenticates to Agent Server. Administrators configure shared API credentials
for services, or require each person to sign in with their own account. Workspace and
action permissions determine which local users may call those services. With a shared
credential, external changes are attributed to the shared service identity; with
personal sign-in, to the person. Agent Server's audit records always retain the local
user who initiated each action.

## App login through the browser

In the app, enter the server URL and choose **Continue with account**. Open the
sign-in page, sign in to the server, choose a workspace, compare the displayed code,
and confirm. The app receives its account-scoped session through polling and opens
chat. The existing pairing code is available under **Use backup pairing code**.

This release implements the URL + browser confirmation path, not QR scanning or a
general-purpose OAuth authorization server. Server accounts use Better Auth
email/password or an explicitly linked organization sign-in provider.

- `POST /v1/auth/browser/start|poll|cancel`, profile `agent-browser-login/1`.
- Five-minute request lifetime; 256-bit private device secret, separate 48-bit
  comparison code. Only the comparison code appears in the browser URL fragment.
- The authenticated browser claims the request through a CSRF-protected POST.
  Approval binds the current session, account, organization and workspace; the app
  cannot supply another user. Account switching releases an unapproved request.
- Polling consumes an approved grant once. Cancellation also revokes a token issued
  immediately before cancellation. No automatic background sign-in on page load.
- Current apps opt into `agent-device-session/1`: each device has an independent
  renewable grant, up to eight per user / 512 total. Browser logout does not revoke
  an enrolled device. Current membership and role are rechecked on every request;
  permission changes and explicit device revocation still invalidate access. Legacy
  clients remain tied to the issuing browser session. Device naming and QR are pending.
- Access lasts `sessionSeconds`; refresh expires after 30 idle days by default,
  configurable as `administration.identity.mobile.sessionIdleDays` (1–90). Renewal
  rotates both secrets and slides that idle deadline. Native apps keep them in
  SecureStore and recover an interrupted rotation after reopening. A first-use
  deadline reclaims enrollments never received/used within five minutes.
- Native clients use the existing secure credential vault; the web preview keeps
  credentials only in memory. The configured `identity.baseURL` must be reachable
  by the client and match the origin entered there. Use HTTPS for release deployments.

## Administration and authentication providers

**Settings** contains General, People, Workspaces and Audit tabs. The old accounts,
workspaces and audit URLs redirect to these tabs. **Sign-in** is a separate admin
menu for authentication providers; **AI providers** remains separate.

1. In **Sign-in**, select the organization and add Google, Microsoft or GitHub.
2. Copy **Callback URL** from the add form and register it in the provider
   application. The server prepares the exact `/admin/auth/callback/ap_…` alias
   before any credentials are entered; it stays the same when saved.
3. Enter the application's Client ID and secret. Microsoft requires a specific
   tenant UUID; Google optionally restricts the hosted domain.
4. Users already signed into the server open **Settings → Server sign-in** and
   explicitly link their account. A service can also use a Microsoft or Google method
   for [personal service sign-in](#personal-service-sign-in).
   Owners and admins manage provider settings; members can only link their own account.

Secrets are encrypted and never returned by the API. Leaving the secret blank in
an edit preserves it. Provider kind, client identity and tenant/domain are immutable;
create a new configuration to change these. Retired service settings do not prevent provider deletion.
Disabling or revising it invalidates in-progress links and prepared authorization.

Opening the add form only prepares an address; it does not register or enable a
provider. Cancelling and opening a new form generates a new address. The callback
uses the server's configured public origin (`identity.baseURL`), not the browser's
current hostname. `POST /admin/api/identity/auth-providers/draft` requires company
management rights and returns public callback metadata. The optional `creationId`
on save is create-only and cannot reuse any existing or deleted provider ID.

The callback's code exchange and profile read are network calls to the provider
(each bounded by a 15-second timeout). They run outside the serialized identity
queue, at most four callbacks at a time, so a slow provider delays only the
people signing in through it: sign-outs, membership changes and provider edits
are answered meanwhile. After the provider answers, the flow is checked again
against the current browser session, invitation, membership and provider
revision before a link or session is created, and an authorization code is
claimed exactly once, so a callback that was overtaken by a revision or
revocation is refused.

First linking requires an already authenticated server account. The provider's
verified subject is bound to that account; matching email addresses never merge
accounts or create memberships. Different email addresses are allowed because the
authenticated local account and OAuth subject, rather than email, define the link.
After linking, the configured provider can be used for server sign-in. There is no
automatic signup or invitation flow in this release.

Server sign-in discards provider access, refresh and ID tokens after verifying identity.
It keeps only the provider/account subject mapping, not a reusable Google or Microsoft
API credential. Service access comes from a separate, explicit consent under
[personal service sign-in](#personal-service-sign-in).

## Shared services and workspace roles

In **Settings → Workspaces → Roles**, administrators create, rename, assign and
remove workspace-specific roles (up to 50). Organization owner/admin/member roles
remain separate; a custom role never grants server administration or model settings.

**Services → Access** selects organization/custom roles allowed to use the shared
connection. **Actions** selects who may run each operation; read/write effects and
approval requirements remain per action. The bulk action editor supports workspace
roles as well. Access must pass both the service gate and action policy. An explicit
user deny beats an action role grant; a user allow cannot bypass the service gate.
A role's grants combine with the user's other roles. Removing a role still referenced
by permissions is rejected; remove its service/action grants first.

Assignments require membership of the same organization and access to the workspace.
Removing workspace membership also removes its custom-role assignments. Role changes
are audited and invalidate in-flight inference and authorization through the policy
epoch; pending operations always recheck current grants before dispatch.

## Personal service sign-in

**Services → Sign-in** decides when a service needs the person's own account:
_never_ (the shared credential), _for changes_ or _for every action_. A personal call
never falls back to the shared credential. See [ADR 014](adr/014-personal-service-sign-in.md).

Choose where sign-in happens:

- **Organization sign-in method** (Microsoft or Google). The method's app registration
  is reused. Add the redirect URL shown in the tab (`/admin/service-connect`) and the
  delegated permissions to that registration, for Microsoft for example
  `Calendars.ReadWrite Mail.ReadWrite Mail.Send`. Enter the same permissions under
  **Permissions**. `openid`, `profile` and, for Microsoft, `offline_access` are added
  automatically. The service itself may be a loopback MCP server; it receives only the
  person's access token.
- **The service's own OAuth** (Twenty, or an MCP server with OAuth metadata). Use
  **Detect OAuth**, then **Register Agent Server** or enter an existing client.
  Registration asks for a confidential client; a server that issues no secret
  (Twenty registers every client as public) is stored as a public client and
  signs in with PKCE alone.
  Permissions default to Twenty's `api profile`.

### Automatic OAuth on add

Adding an MCP service by address (or changing its address) works like a
connector flow: once the service is saved, the server looks for its OAuth in the
background with the same guarded discovery as **Detect OAuth** (protected-resource
metadata, then the authorization server it names or the service origin; HTTPS only,
bounded by a timeout). When metadata turns up and nobody has set up personal sign-in
yet, the service is set to _for every action_ through _the service's own OAuth_ with
the permissions the metadata advertises (Twenty: `api profile`), and, when the
metadata has a registration endpoint, Agent Server registers itself as a client (a
public one when the server issues no secret). The add result then says
_Sign-in: the service's OAuth, for every action · client registered_ with **Edit**
opening the Access tab, or _OAuth not found_. The operation is idempotent: an
existing client, discovered metadata or settings an administrator changed are kept,
and nothing is registered at any origin other than the one typed (or the
authorization server its protected-resource metadata names). Failures are silent;
the status records `lastProbe` (`configured`, `metadata` or `none` with a short
reason) and the Access tab shows it. Each probe writes a `catalog.service_changed`
audit entry with `oauthProbe`. `POST …/catalog/oauth/auto` `{organizationId,
workspaceId, serviceId}` re-runs it for administrators (joining a probe already
running) and returns the status. Services signing in through an organization
method and OpenAPI services are left alone. Personal sign-in lets the service gate
(_Who can connect_) decide who connects: a gate never set becomes an explicit
one for owners, admins and members, so nobody is left out; a gate an administrator
narrowed stays, and the add result and the Access tab say who it lets in
(_Only these can connect: Member_).

**Services → Add service** opens the service form directly. Microsoft 365 runs as a
[hosted MCP server](hosted-servers.md) (Administration → Hosted → Add server); add its
URL as an MCP service with authentication _None_ and set up personal sign-in on the
Access tab with a Microsoft sign-in method. Discovered actions stay disabled until an
administrator enables them and grants access.

The first time a request needs the service, chat answers with a sign-in card:

1. The phone starts an attempt (`POST /v1/services/start|status|cancel`) and opens
   `/admin/service-connect#…` in the system browser.
2. The browser signs in to the server as the same person. If the person has not
   linked the sign-in method yet, the page links it first. Then it redirects to the
   provider.
3. After consent the page exchanges the code once. It stores the tokens only if the
   id_token names the account the person linked, and returns to the app through
   `agentclient://service-connected`.
4. The card sees the connection and sends the original request again, once.

Access tokens are refreshed shortly before they expire; a revoked grant disconnects
the account and the next request shows the card again. Tokens are encrypted per
workspace, service and person and never leave the server except in the service
request. Changing the service URL, its sign-in settings or the sign-in method
invalidates existing connections and pending consents. Existing operation pins stay
checked, so an approval made with one account never runs under another or under the
shared credential.

### Who manages the assistant's permissions

A personal sign-in means the person, not the administrator, decides what their
assistant may do in that account. A shared service keeps the administrator's
model.

| Service sign-in               | Reads                                          | Changes                                        |
| ----------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| _Never_ (shared credential)   | Administrator: action enabled, roles, approval | Administrator: action enabled, roles, approval |
| _For changes_ (mixed)         | Administrator, as for a shared service         | The person (on/off, approval)                  |
| _For every action_ (personal) | The person (on/off)                            | The person (on/off, approval)                  |

Administrators still add the service, discover its actions and decide **who may
connect**: the service's access gate (**Services → Access**, shown as _Who can
connect_). They also set the ceiling: an action they switch off is
unavailable to everyone and does not appear in anyone's list. For the actions
the person manages, the administrator's per-action roles, user overrides and
approval setting are not used; the console's **Actions** tab says so in one line
and the action editor hides those fields.

Each person sets their own choices in the web app under **Connections → service →
What your assistant can do**: reads and changes are listed apart, each with a switch,
and changes with _Always ask_ / _Don't ask_. Until they choose, reads are on
and changes are on but confirmed one by one; nothing writes without approval
until the person says so. On a waiting change in chat, **Don't ask next time**
approves that change and then switches the action to _Don't ask_ for this person
only.

Where the choices apply: chat tool exposure, `@` mentions and the MCP connector
list only actions the person left on; the approval that a new operation waits
for is the person's own choice; the process designer offers only those actions
with that approval; a personal process cannot be saved or frozen with an action
its owner switched off; a workspace process runs under the starting person's
choices (an action they switched off shows the process as unavailable to them,
and the dispatch is refused); the overview (hub) runs a process unattended only
if every change it can make waits for that person's approval, so _Don't ask_
removes it from unattended refreshes. Process qualification assumes every
personal change is confirmed, so changing one's own choices never requires a new
test; each run checks the current choices at dispatch.

Saving is revision-checked per person and service and audited as
`catalog.personal_policy_changed`. It changes only that person's authority, so
the organization policy epoch stays; pending approvals and running work check
the current choice again before dispatch (a switched-off action is refused).
Disconnecting keeps the choices, so reconnecting restores them; removing an
action or the service forgets everyone's choices for it.

API (browser session, any member, the session decides whose choices):
`POST /admin/api/identity/catalog/oauth/permissions` `{organizationId,
workspaceId, serviceId}` returns `{requiredFor, revision, actions: [{id, name,
description, effect, enabled, approval}]}` for a service the person may connect
to (404 otherwise); `…/oauth/permissions/save` adds `revision` and
`actions: [{actionId, enabled, approval}]` and returns the same view. A repeated
save whose changes are already in place succeeds; a different change from a
stale revision is `409 personal_policy_conflict`. `…/oauth/approval`
`{organizationId, workspaceId, operationId}` returns `{available}` for the
person's own waiting change, and `…/oauth/approval/remember` sets it to
_Don't ask_. Choices live in `agent_personal_action_policy` (only differences
from the defaults) and `agent_personal_action_revision`; both tables are created
on start, existing deployments need no migration. Existing personal services
switch to this model on upgrade: action role grants no longer limit who uses
them (the access gate does), and changes start confirmed for everyone.

Not yet: the mobile app has no permissions screen or _Don't ask next time_ option
(it follows the same server rules), and there is no bearer API for these
settings.

Provider account mapping, Better Auth sessions and mobile device sessions are retained.
The explicit account-link endpoint is session-bound and rejects cross-company links;
there is no implicit email merge or automatic membership creation.
