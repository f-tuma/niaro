# identity-access Specification

## Purpose

Defines who can use a Niaro server and with what authority: organizations, workspaces, owner/admin/member roles, the first owner, invitations, sign-in, passwords, the recovery key, a person's own sessions and the organization's activity log.

## Requirements

### Requirement: Organizations, workspaces and roles

The system SHALL model a company as an organization whose people hold exactly one organization role: `owner`, `admin` or `member`. A workspace SHALL belong to one organization. Owners and administrators SHALL reach every workspace of their organization; a member SHALL reach only the workspaces they were explicitly given access to. A selected organization or workspace identifier in a request SHALL be treated as a selector, never as authorization.

#### Scenario: Member sees only assigned workspaces

- **WHEN** a member reads their organization (`GET /admin/api/identity/organization?id=…`)
- **THEN** the response lists only the workspaces that member was given access to and only the member's own entry among the people

#### Scenario: Member addresses a foreign workspace

- **WHEN** a member sends a request naming a workspace of their organization they have no access to
- **THEN** the system answers `403 identity_forbidden`

#### Scenario: Unknown or foreign workspace

- **WHEN** a request names a workspace that does not belong to the named organization
- **THEN** the system answers `404 identity_not_found`

### Requirement: Authority is checked on every request

The system SHALL derive the acting person from a verified server session and SHALL re-read their organization membership, role and workspace access on every request, including mutations. Prompts, client state, tool arguments and model decisions SHALL NOT grant authority. A change to roles, membership or workspace roles SHALL advance the organization's policy epoch so that in-flight agent work started under the old authority is refused before its effect (see `agent-runtime`).

#### Scenario: Demoted mid-session

- **WHEN** an administrator is demoted to member while their browser session stays open
- **THEN** their next administrative request is refused without the session having to end

#### Scenario: Role change during running work

- **WHEN** an owner changes a person's role while that person's agent work waits for dispatch
- **THEN** the work is rechecked against the new authority before any external effect

### Requirement: Role permissions

The system SHALL let only owners change organization roles and remove people from the organization. Owners and administrators SHALL manage workspaces, workspace access, workspace roles, invitations, services, models, usage limits, sign-in methods, external AI apps, plugins, runs and the activity log. Members SHALL use chat, Overview, Tasks, Meetings, Processes, Skills and Connections within their own grants, and SHALL receive `403` or `404` on administrative APIs.

#### Scenario: Administrator tries to change a role

- **WHEN** an administrator sends `changeRole` or `removeMember` on `POST /admin/api/identity/command`
- **THEN** the system answers `403 identity_forbidden`

#### Scenario: Member calls an administrative API

- **WHEN** a member calls an administration endpoint such as the activity log or invitations
- **THEN** the system answers `403` and returns no administrative data

### Requirement: First owner setup

While no account exists, the system SHALL offer a one-time owner setup (`GET /admin/api/auth-methods` reports `setup: true`). `POST /admin/api/identity/bootstrap` with the company name and the owner's name, email and a 12–128 character password SHALL atomically create the account, the organization with that person as owner and a first workspace named like the organization, and SHALL sign the owner in. It SHALL accept at most 10 attempts per minute per client address.

#### Scenario: First person sets up the server

- **WHEN** no account exists and a person submits the owner setup
- **THEN** the person becomes owner of a new organization with one workspace and is signed in
- **AND** `organization.created` and `workspace.created` are recorded in the activity log

#### Scenario: Setup after an account exists

- **WHEN** owner setup is submitted after any account exists
- **THEN** the system answers `409 identity_already_initialized` and changes nothing

### Requirement: No self-service sign-up

The system SHALL NOT expose public sign-up or raw organization endpoints. People SHALL join only through the owner setup or an invitation. Direct account creation (`createAccount`) and granting workspace access to an existing member directly (`setWorkspaceMember` with `allowed: true`) SHALL answer `410 invitation_required`.

#### Scenario: Direct account creation

- **WHEN** an owner sends `createAccount` on `POST /admin/api/identity/command`
- **THEN** the system answers `410 invitation_required` and creates no account

### Requirement: Email and password sign-in

The system SHALL sign people in with email and password through `POST /admin/auth/sign-in/email`, setting an HttpOnly session cookie and returning only `{ "ok": true }`. Failed sign-ins SHALL be rate-limited (`429 identity_rate_limited` with `Retry-After`). A browser session SHALL stay valid for the configured number of idle days and SHALL be extended by use. `POST /admin/auth/sign-out` and `POST /admin/api/logout` SHALL end the browser session.

#### Scenario: Wrong password

- **WHEN** a person submits a wrong password
- **THEN** the system answers `401 identity_unauthorized` without saying whether the email exists

#### Scenario: Session tokens stay server-side

- **WHEN** sign-in succeeds
- **THEN** the response body contains no session token or account data

### Requirement: Organization sign-in methods

Owners and administrators SHALL configure Google, Microsoft or GitHub sign-in methods per organization. Preparing a method (`POST /admin/api/identity/auth-providers/draft`) SHALL return a callback URL `/admin/auth/callback/ap_…` on the server's public origin that stays the same when the method is saved. A method's kind, client ID, Microsoft tenant and Google hosted domain SHALL be immutable after creation. Changes SHALL be audited as `auth.provider_changed`.

#### Scenario: Member tries to configure a method

- **WHEN** a member calls `auth-providers/draft`, `save` or `delete`
- **THEN** the system answers `403 identity_forbidden`

#### Scenario: Changing the client identity

- **WHEN** an administrator saves an existing method with a different kind, client ID, tenant or hosted domain
- **THEN** the save is refused and a new method has to be created instead

### Requirement: Sign-in method secrets and revisions

The system SHALL store a sign-in method's client secret encrypted, SHALL never return it, and SHALL keep it when an edit leaves the secret blank. Saving, disabling or deleting a method SHALL invalidate sign-ins and account links in progress through it.

#### Scenario: Edit without a secret

- **WHEN** an administrator edits a method's name and leaves the secret blank
- **THEN** the stored secret is kept and no response contains it

#### Scenario: Method disabled during a link

- **WHEN** a method is disabled while a person is linking an account through it
- **THEN** that link attempt is refused

### Requirement: Linking a sign-in method to an account

A signed-in person SHALL explicitly link a provider identity to their own account (`auth-providers/link`) before using it to sign in. The provider's verified subject SHALL be bound to that account; matching email addresses SHALL never merge accounts or create memberships. Server sign-in SHALL discard the provider's access, refresh and ID tokens after verifying identity and keep only the subject mapping.

#### Scenario: Unlinked provider with an existing email

- **WHEN** a person signs in with a provider identity that is not linked but whose email belongs to an existing account
- **THEN** sign-in is refused and the login page names `auth_provider_link_required`

#### Scenario: Linked provider

- **WHEN** a person signs in with a provider identity linked to their account
- **THEN** they are signed in to that account

### Requirement: Provider callbacks are isolated and revalidated

The system SHALL run a provider callback's code exchange and profile read outside serialized identity work, time-bounded, at most four at once. After the provider answers, it SHALL recheck the browser session, invitation, membership and method revision before creating a link or session, and SHALL claim each code at most once. Only fixable failures (`invitation_account_mismatch`, `auth_provider_link_required`, `auth_provider_account_conflict`) SHALL be named on return; others SHALL stay generic.

#### Scenario: Method revised during a callback

- **WHEN** an administrator revises the sign-in method while a person's callback waits on the provider
- **THEN** that callback is refused and creates no session or link

#### Scenario: Slow provider

- **WHEN** one provider is slow to answer callbacks
- **THEN** sign-outs, membership changes and other people's requests are still answered meanwhile

### Requirement: Organization membership changes

Owners SHALL change people's roles and remove people from the organization. The system SHALL refuse to remove or demote the last owner (`409 identity_last_owner`). Removing a person SHALL remove their workspace access and workspace role assignments. Changing a person's role or removing them SHALL revoke that person's app device sessions. Membership changes SHALL be audited (`member.role_changed`, `member.removed`).

#### Scenario: Demoting the last owner

- **WHEN** the only owner of an organization is demoted or removed
- **THEN** the system answers `409 identity_last_owner` and nothing changes

#### Scenario: Removed person's devices

- **WHEN** an owner removes a person from the organization
- **THEN** that person's app sessions for the organization stop working on their next request

### Requirement: Workspace management

Owners and administrators SHALL create workspaces (`createWorkspace`) with a name unique in the organization, at most 100 per organization, and SHALL remove a member's workspace access (`setWorkspaceMember` with `allowed: false`). A new workspace SHALL start with no service, connection or tool grants. Removing access SHALL also remove the member's workspace role assignments there and revoke their app sessions for it. Changes SHALL be audited (`workspace.created`, `workspace.member_changed`).

#### Scenario: Duplicate workspace name

- **WHEN** an administrator creates a workspace with a name already used in the organization
- **THEN** the system answers `409 identity_workspace_exists`

#### Scenario: Workspace access removed

- **WHEN** an administrator removes a member's access to a workspace
- **THEN** the member no longer sees that workspace and their app session for it is revoked

### Requirement: Workspace roles

Owners and administrators SHALL create, rename, assign and remove custom roles per workspace (`saveWorkspaceRole`, `removeWorkspaceRole`), at most 50 per workspace, revision-checked. Assignees SHALL be members with access to that workspace. A custom role SHALL never grant administration, model settings or an organization role. A role still named by a service or action grant SHALL NOT be removable. Changes SHALL be audited as `workspace.role_changed` and SHALL advance the policy epoch.

#### Scenario: Removing a role in use

- **WHEN** an administrator removes a workspace role that a service or action grant still names
- **THEN** the system answers `409 workspace_role_in_use`

#### Scenario: Stale role edit

- **WHEN** a role is saved with an outdated revision
- **THEN** the system answers `409 catalog_conflict`

### Requirement: Creating invitations

Owners and administrators SHALL invite a person by email to a named workspace (`POST /admin/api/identity/invitations`, action `send`), list pending invitations and revoke them. An invitation SHALL grant only the `member` role and access to that workspace. A new invitation for the same email and workspace SHALL revoke the earlier pending one. An administrator SHALL create at most 30 invitations per hour. Creating and revoking SHALL be audited (`invitation.created`, `invitation.revoked`).

#### Scenario: Replacing an invitation

- **WHEN** an administrator invites an email that already has a pending invitation to the workspace
- **THEN** the earlier link answers `invitation_revoked`

#### Scenario: Too many invitations

- **WHEN** an administrator exceeds 30 invitations within an hour
- **THEN** the system answers `429 invitation_rate_limited`

#### Scenario: Member tries to invite

- **WHEN** a member sends an invitation
- **THEN** the system answers `403 identity_forbidden`

### Requirement: Invitation links and delivery

An invitation link (`/account/invite#<token>`) SHALL be single-use, SHALL expire after 48 hours and SHALL be returned once on creation; only its digest SHALL be stored. With SMTP configured the link SHALL be emailed (`delivery: "email"`); without it the administrator SHALL receive it to pass on (`delivery: "link"`). Pending invitations SHALL show how they were delivered.

#### Scenario: No SMTP

- **WHEN** an administrator invites someone on a server without SMTP
- **THEN** the response carries the link with `delivery: "link"` for the administrator to pass on

#### Scenario: SMTP delivery fails

- **WHEN** SMTP is configured and sending the invitation fails
- **THEN** the system answers `502 mail_delivery_failed`, keeps no new invitation and restores any invitation it was replacing

### Requirement: Accepting invitations

Opening an invitation link SHALL NOT enroll anyone; the person SHALL explicitly accept (`POST /admin/api/identity/invitation` with `accept: true`). A person without an account SHALL create one with a name and a password of at least 12 characters; an existing account SHALL first be signed in as that exact account. Acceptance SHALL add membership as `member` (when missing) and workspace access in one transaction, audited as `workspace.member_changed`.

#### Scenario: Opening the link

- **WHEN** a person opens an invitation link without accepting
- **THEN** they see the invited email and workspace and gain no access

#### Scenario: Signed in as a different account

- **WHEN** the invited email belongs to an existing account and the person is signed in as another account
- **THEN** acceptance answers `403 invitation_account_mismatch`

### Requirement: Unusable invitation links

An unusable link SHALL answer `410` and name its reason: `invitation_invalid` (unknown), `invitation_expired`, `invitation_used` (already accepted) or `invitation_revoked` (revoked, replaced, or the inviter is no longer owner or administrator). A copied link SHALL NOT reveal whether the address already has an account unless that account is signed in, and an account created through it SHALL keep its email unverified.

#### Scenario: Inviter lost administrator rights

- **WHEN** the person who created an invitation is demoted to member or removed
- **THEN** the link answers `invitation_revoked`

#### Scenario: Copied link

- **WHEN** a link that was copied rather than emailed is inspected without being signed in as the invited account
- **THEN** the page does not reveal whether the address already has an account
- **AND** an account created through it keeps its email unverified

### Requirement: Joining through a sign-in method

A person without an account SHALL be able to accept an invitation by signing in with an enabled sign-in method of the invitation's organization. The provider flow SHALL be bound to the live invitation and the provider email SHALL match the invited email. The new identity SHALL be created without membership or password; membership SHALL follow only from explicit acceptance.

#### Scenario: Provider email differs

- **WHEN** the provider returns an email other than the invited one
- **THEN** the person returns to the invitation page with `invitation_account_mismatch` and gains no access

### Requirement: Changing one's own password

A signed-in person with a password SHALL change it with the current one (`POST /admin/api/identity/account/password`, new password 12–128 characters). On success the system SHALL sign out the person's other browsers (keeping this one), revoke their MCP access tokens, invalidate outstanding reset links and audit `password.changed`. At most five attempts per 15 minutes SHALL be accepted.

#### Scenario: Wrong current password

- **WHEN** the current password is wrong
- **THEN** the system answers `403 password_incorrect`

#### Scenario: Too many attempts

- **WHEN** a sixth attempt arrives within 15 minutes
- **THEN** the system answers `429 password_rate_limited`

#### Scenario: Provider-only account

- **WHEN** a person without a password tries to change it
- **THEN** the system answers `409 password_not_set`

### Requirement: Administrator-issued password reset links

Owners SHALL issue a reset link for anyone in the organization but themselves; administrators only for members (`POST /admin/api/identity/password-reset`). A person in another organization too SHALL be refused (`403 password_reset_other_organization`). A link (`/account/reset#<token>`) SHALL last 48 hours and work once; only the newest per person SHALL work. It SHALL be emailed when SMTP exists and always returned once; at most 20 per issuer per hour; audited as `password.reset_issued`.

#### Scenario: Administrator resets another administrator

- **WHEN** an administrator requests a reset link for an administrator or owner
- **THEN** the system answers `403 password_reset_forbidden`

#### Scenario: Re-issued link

- **WHEN** a second link is issued for the same person
- **THEN** the first link answers `password_reset_invalid`

### Requirement: Using a reset link

`POST /admin/api/identity/account/reset` with only the token SHALL return the account's email; with a 12–128 character password it SHALL set it, consume the link, sign the person out of every browser, device and app, revoke their MCP access tokens and audit `password.reset_used`. Checks are rate-limited per address. Errors: `password_reset_invalid`, `password_reset_expired`, `password_reset_used`. Pages reading a token from the URL fragment SHALL remove it from the address bar and history.

#### Scenario: Used link

- **WHEN** a consumed reset link is used again
- **THEN** the system answers `410 password_reset_used`

#### Scenario: Issuer lost authority

- **WHEN** the issuer can no longer reset that person
- **THEN** the link answers `410 password_reset_invalid`

### Requirement: Own sessions and devices

A signed-in person SHALL manage own access via `POST /admin/api/identity/account/access`: `list` returns devices, browser sessions (user agent, current marker, workspaces chatted in), MCP tokens and slot usage; `revoke` ends one entry by an opaque handle that is never a stored digest; `revokeOthers` signs out every other browser and keeps devices and MCP access; `revokeAll` signs out every browser, device and app, this one included, and revokes all MCP tokens. Audited as `session.revoked`.

#### Scenario: Sign out everywhere

- **WHEN** a person chooses `revokeAll`
- **THEN** every browser session, device session and MCP token of that person stops working, the current browser included

#### Scenario: Revoking someone else's entry

- **WHEN** a person sends a handle that is not one of their own entries
- **THEN** the system answers `404 identity_not_found`

### Requirement: Recovery key

The system SHALL accept an operator recovery key at `POST /admin/api/login`, setting an HttpOnly, `SameSite=Strict` cookie scoped to `/admin`, with at most 10 attempts per minute per address. A recovery session SHALL run the owner setup and read instance-level overview data, and SHALL NOT impersonate an organization member: organization data, devices and the activity log SHALL be refused. A successful owner setup SHALL end the recovery session that made it.

#### Scenario: Recovery session reads organization data

- **WHEN** a recovery session requests an organization's people or activity log
- **THEN** the system refuses and returns no organization data

#### Scenario: Wrong key

- **WHEN** an invalid recovery key is submitted
- **THEN** the system answers `401 admin_unauthorized`

### Requirement: Activity log access

Owners and administrators SHALL read their organization's activity log through `GET /admin/api/identity/audit?organizationId=…`, returning `agent-audit/1` with up to 50 entries newest first and a nullable `nextBefore` cursor. Optional filters SHALL be `workspaceId`, `category=changes|tools`, `outcome` and `before`. Members, app sessions and recovery sessions SHALL NOT read it.

#### Scenario: Member reads the log

- **WHEN** a member requests the activity log
- **THEN** the system answers `403 identity_forbidden`

#### Scenario: Paging

- **WHEN** more than 50 entries match
- **THEN** the response carries `nextBefore`, and passing it as `before` returns the next older page

### Requirement: Activity log content

The system SHALL record configuration and membership changes in the same transaction as the change, so a failed record rolls the change back. Tool and action calls SHALL be recorded as `running` before dispatch and finished once with an outcome (`succeeded`, `failed`, `denied`, `cancelled`, `interrupted`, `unknown`) and duration. Records SHALL hold only identifiers, roles, grants, revisions, timestamps, outcome and a bounded reason. Names SHALL be resolved from current data when read.

#### Scenario: Server stops during a call

- **WHEN** the server stops while an audited call is running
- **THEN** that record becomes `interrupted` with reason `server_stopped`

#### Scenario: Sensitive data

- **WHEN** an action with arguments and a result is audited
- **THEN** neither the arguments nor the result appear in the record
- **AND** no key, password, request body, transcript or raw provider error is stored
