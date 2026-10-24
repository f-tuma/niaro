# Application sign-in and workspace invitations

Users enter only the server address in the assistant. The app opens `/account/login`, a dedicated account page without console navigation. It offers configured login providers and email/password, then the user's available workspaces. Only owners/admins can open the management console; workspace roles do not grant console access.

The native callback is fixed to `agentclient://auth`. Web login uses a popup and returns only to the exact app origin allowed by the server's CORS configuration. A one-use authorization code is bound to an app-held S256 PKCE verifier and state. It is exchanged for the existing renewable device credential. The server rechecks the browser session and workspace membership on exchange. No displayed or manually entered pairing code is involved. Signing in again (for example to switch workspace) keeps the current session until the new credential is exchanged and stored; only then is the old device credential revoked, so a cancelled or failed attempt leaves the person signed in. Old pairing endpoints remain for compatibility with existing builds but are absent from the application and console menus.

## Invitations

In **People → Pozvat e-mailem** (or **Workspaces**), administrators create or revoke invitations. Links expire after 48 hours and are single-use; simply opening the link does not enroll anyone. Invitations grant only member access to their named workspace. They never grant administrator status or custom workspace roles.

With SMTP configured the invitation is emailed; without it the server creates the same invitation and the console shows a copyable link for the administrator to pass on. In both cases the link is shown once right after creating it (only its SHA-256 digest is stored), and the sheet says which happened ("Invitation emailed" / "Invitation ready"). Pending invitations list how they were delivered. A new invitation for the same email and workspace revokes the earlier pending one. Revoked invitations are kept (marked `revoked_at`) so their link can say so. Creating and revoking are audited (`invitation.created`, `invitation.revoked`); one administrator may create at most 30 invitations an hour.

An unusable link names its reason on `/account/invite`: `invitation_invalid` (unknown link), `invitation_expired`, `invitation_used` (already accepted), `invitation_revoked` (revoked, replaced, or the inviter lost administrator rights) and `invitation_account_mismatch` (signed in as a different existing account). Provider sign-in failures that the person can fix return to the page with `?error=invitation_account_mismatch` or `?error=auth_provider_link_required` instead of a generic failure; other provider failures stay generic.

New users can choose an enabled provider from the invitation’s organization or create a password. Provider onboarding binds the OAuth flow to the live invitation and requires the provider email to match it. The invitation bearer proves the invited mailbox; Microsoft need not supply an emailVerified claim. A new provider identity is created without workspace membership or a password; the user explicitly accepts the invitation after returning. Abandoned identities have no organization/workspace access. Revoked/expired invitations cannot grant access.

A copied (link-mode) invitation proves nothing about the mailbox, and the link can pass through other hands: inspecting it does not say whether the address already has an account (the page offers creating one and "I already have an account"; only when signed in as that account does it say so), and an account created with it keeps `emailVerified` unset. Only an emailed invitation marks the new account's address as verified.

Existing users must authenticate their exact account before accepting. An unlinked provider cannot attach itself to an existing user by email: sign in by password and explicitly connect the provider on the application login page first. Already-linked providers work directly. Accounts are never merged just because a provider returns the same email address.

Direct `createAccount` and `setWorkspaceMember(allowed:true)` commands return `410 invitation_required`; adding people always goes through an invitation (emailed or copied). Bootstrap and removing access still work. Removing/demoting the inviter invalidates outstanding invitations. Membership acceptance is transactional and audited.

## Passwords

- **Own password:** in the web app's **Account** page (`/me`), a signed-in person changes their password with the current one (`POST /admin/api/identity/account/password {currentPassword, newPassword}`). Other browser sessions are signed out; this one stays. The person's MCP access tokens (manual and OAuth) are revoked and outstanding reset links stop working, since a password change is often the answer to a suspected compromise. Five wrong attempts in 15 minutes return `429 password_rate_limited`. People who sign in only through a provider have no password and are told to ask for a reset link.
- **Reset link:** on **People**, the row menu offers **Password reset link** (`POST /admin/api/identity/password-reset {organizationId, memberId}`). Owners may issue it for anyone but themselves, administrators only for plain members. A person who also belongs to another organization is refused (`password_reset_other_organization`) so one company cannot take over an account another relies on. The link (`/account/reset#token`) lasts 48 hours, works once and only the newest one works (older ones are marked superseded, not deleted, so re-issuing still counts); with SMTP it is also emailed, otherwise it is copied from the sheet. At most 20 links per issuer an hour. The page removes the token from the address bar and history as soon as it has read it (so do the invitation and app-login pages).
- **Using it:** `/account/reset` shows the account's email and sets a new password (`POST /admin/api/identity/account/reset {token, password?}`; without `password` it only checks the link). Using it signs the person out of every browser, mobile device and app and revokes their MCP access tokens. Public checks are limited per client address. Errors: `password_reset_invalid`, `password_reset_expired`, `password_reset_used`.
- Audit: `password.changed`, `password.reset_issued`, `password.reset_used`.

## Devices and sessions

The **Account** page lists the person's mobile devices (persistent device credentials, with workspace and last activity), their browser sessions (browser and system from the user agent, "This browser", and the workspaces chatted in from it, each once however many tabs) and their active MCP access tokens ("MCP access": label, workspace, last use, expiry; manual and OAuth grants). Each can be removed; **Sign out other browsers** (on the Browsers section) signs out every browser but this one and keeps devices and MCP access; **Sign out everywhere** signs out every browser, device and app, this one included, and revokes every MCP access token (`POST /admin/api/identity/account/access {action: "list" | "revoke" | "revokeOthers" | "revokeAll"}`; ids are derived handles, never stored digests). Revokes are audited as `session.revoked`.

A person can hold 8 device slots: mobile devices and app sign-ins. The web app's chat credential does not use one: it follows the browser session, each browser session keeps its newest 4 per workspace (one per open tab) and a person at most 16 in all (the oldest goes first); these never count toward the server-wide limit of 512 app credentials either. When the device slots are full, browser consent and the app exchange return `409 mobile_device_limit`, which the sign-in page, the web app and the mobile app turn into "remove a device in your account" instead of a generic failure. The page works without a chat connection, so a person at the limit can still free a slot.

## Local Mailpit

Mailpit is the local SMTP sink; it never forwards these messages externally. See the [official Mailpit Docker documentation](https://mailpit.axllent.org/docs/install/docker/).

```sh
npm run mailpit:start
npm run test:mailpit
```

Inbox: <http://localhost:8025>. SMTP: `127.0.0.1:1025`. Both ports bind only to loopback. The smoke test sends a synthetic TEST workspace invitation and verifies the link in the captured message.

Add to `administration.identity` in the operator-owned server profile:

```json
{
  "mail": {
    "host": "127.0.0.1",
    "port": 1025,
    "secure": false,
    "from": "assistant@localhost.test"
  }
}
```

For a deployed server, use authenticated TLS SMTP (`secure: true`, typically port 465) and its public HTTPS `baseURL`. Optional `user` and `password` configure SMTP authentication. Keep the profile outside version control. Unencrypted SMTP is allowed only on loopback. Missing or failing SMTP is reported explicitly; no undelivered invitation is silently treated as successful.

Run `npm run test:identity` for PKCE/replay, session revocation, invitation takeover/expiry, enrollment, roles and service authorization tests. The local Mailpit smoke test is separate because it requires the container to be running.
