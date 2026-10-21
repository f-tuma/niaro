# ADR 013 — Better Auth, organizations and workspaces

Date: 2026-09-25. Status: accepted; local Better Auth identity, workspace membership and scoped Twenty TEST-read connections implemented on 2026-09-25. The first account-to-app workflow bridge is implemented; OAuth providers remain pending.

The console is for the developers and administrators who connect a company's services. The product needs multiple users, shared integrations and different permissions within one company. Better Auth is the chosen identity foundation, with its Organization plugin for membership and organizational roles. The existing key remains a recovery path. This extends ADR 012; a successful OAuth sign-in must never imply administrator access.

## Ownership and scope

- **User/account:** Better Auth owns identity, linked sign-in accounts and sessions. An organization member is not an instance operator.
- **Organization:** a company and its membership boundary. Organization owners/admins manage members and permitted shared connections. Instance administration remains an explicitly assigned separate permission.
- **Workspace:** a server-owned resource within an organization, with its own integration bindings, allowed tools and membership/policy. It is not implicitly equivalent to a Better Auth team. Teams can later group people; membership alone must not grant every workspace/tool.
- **Credentials:** held by the server for a connection, with explicit organization/workspace ownership. The console receives masked metadata and permitted actions, never an existing secret.

Start with the Organization plugin's owner/admin/member roles and explicit application resources: connections (read/configure), workspaces (read/manage), tools (discover/execute) and members (read/manage). Add custom roles for concrete requirements, rather than scattering role-name comparisons through routes. Existing operation-specific permissions such as `contacts.read.test` remain enforced; a generic execute permission cannot widen the connector's scope or approved effect.

Every request derives user and organization membership from a verified server session, validates workspace membership, and evaluates the current policy. A client-selected active organization/workspace is a selector, not authorization. The agent receives only the tools discoverable in that scope; dispatch and deferred side effects check execution permission again. Role removal, session revocation and organization switching must also invalidate cached inventories and pending privileged actions. Prompts, UI state, tool arguments and model decisions cannot grant permissions.

## Console structure

- Connections: providers, configuration, status and connection setup.
- Tools: registered capabilities and who may use them.
- Accounts: members, invitations, linked sign-in accounts and roles, exposed according to the actor's permissions.
- Workspaces: membership, available connections and tool policies.
- Settings: language and console preferences; workspace/account settings live on their respective pages.

**Implemented now:** Connections, Tools, Audit, Access, Accounts, Workspaces and Settings on TanStack Router/Query and shadcn. Better Auth handles local accounts, sessions and organizations. The recovery key bootstraps the first owner/company atomically; it has no personal identity or organization access. Owners manage accounts/roles, owners and admins manage workspaces, and members see explicitly assigned workspaces. No new organization inherits global fixture credentials or tools. See [implementation and limits](../server-admin.md#better-auth-accounts-and-workspaces).

## Next implementation slice

1. **Done locally:** separate identity database, canonical trusted origin, owner bootstrap, persistent and revocable Better Auth sessions. Legacy workflow/pairing persistence stays separate.
2. **Membership implemented and tested:** organization and workspace checks, two organizations, owner/admin/member, direct API denial after demotion/removal. Workspace connection and per-tool role grants now cover discovery and explicit test dispatch. New connections start disabled with no grants. Live membership/policy checks run before and after remote work.
3. Connect one real sign-in provider. Use the documented React/Expo clients for session handling and the server's explicit workflow-scope bridge. Test callback failure/replay, switching organizations, logout and revocation. Keep recovery-key access separately audited and revocable.
4. **First connector implemented:** typed workspace-owned Twenty TEST-read connections, encrypted write-only keys, operator-controlled origin allowlist, role grants, revision checks and explicit read tests. Real credentials and current private files are not migrated or widened automatically. Extend additional providers only through bounded server adapters; the initial metadata audit is now implemented (below); production retention and complete authentication/operator coverage remain pending.

The local development profile enables an initially empty identity database; its real owner must be entered explicitly through the recovery-key setup. Synthetic QA identities live in isolated temporary databases. No invitation or existing workflow-role assignment is made. Existing fixture user/workspace IDs are not mapped to company users: their names are not evidence of ownership. New app sessions use account-<workspace UUID>, the actual Better Auth user ID and the persistent workflow server ID.

References: [Better Auth Organization](https://better-auth.com/docs/plugins/organization), [React client](https://better-auth.com/docs/concepts/client), [Expo integration](https://better-auth.com/docs/integrations/expo).

## Account-to-app bridge

A signed-in member can issue a five-minute one-use code for an accessible workspace. Its hashed grant and the resulting hashed opaque bearer are tied to the issuing Better Auth session, membership, workspace and workflow server ID. Membership changes, parent logout/expiry and explicit device revocation invalidate them. No Better Auth cookie or session token enters the app. Revalidation and synchronous workflow reads/commits run in the identity queue; model/provider I/O stays outside it. Configuration/policy changes invalidate pending interpretations and tool results.

A workspace selects one CRM connection explicitly; dispatch still checks each tool's role grants before and after I/O. Listing/searching are independent capabilities. An organization owner/admin selects the workspace's model and voice profiles from an operator-published catalog; both default off. Ordinary members cannot read or edit the catalog/selection. Optional instance-sharing flags only publish choices, with a separate administrator selection required even after upgrading an earlier globally opted-in workspace. Account calendar writes now require an explicitly enabled workspace CalDAV connection and role grants; legacy scopes remain separate. This first bridge uses the app's existing pairing UI, without a new native OAuth flow. Long-lived device sessions and OAuth callbacks are later work.

## Administrator-managed AI policy

`agent_workspace_ai` stores profile IDs and a revision per workspace. Credentials, actual provider/model configuration and request budgets remain server-owned. Missing/expired profiles fail closed, with no fallback; the client cannot supply a provider or model name. An owner/admin update and its metadata audit record are one transaction. Current role, scope and revision are checked server-side, including after asynchronous model/tool/transcription work and atomically at workflow commit. A change followed by restoration still rejects the old result. Reads and durable receipt replay remain available after inference is disabled. This is workspace selection from a curated instance catalog, not per-company billing or a general credential editor. See [configuration and boundaries](../server-admin.md#workspace-models-and-speech-recognition).

## Operational audit

The identity database owns a separate `agent_audit` history. Successful configuration/membership mutations append their row atomically with the mutation. Admitted workspace tool calls record running and a single terminal outcome after revalidation, with interruptions finalized on shutdown/restart. Only organization owner/admin sessions can query that organization's history; mobile sessions and recovery access cannot read it. The console is a renderer of the typed `agent-audit/1` metadata contract.

No credential, message, transcript, tool argument/result, contact record or raw exception is stored in this table. Historical names are not snapshotted; display names are current identity metadata. Individual tool success does not imply completion of the surrounding workflow. This local history is not a tamper-evident archive and has no automatic retention. Authentication/session events, model/voice calls, legacy fixture operations and profile/CLI mutations require separate future coverage. See [audit API and limitations](../server-admin.md#audit-records).

## Workspace CalDAV authority and durable operations

A workspace owns one encrypted calendar connection. Exact collection URLs are operator-approved and unique across workspaces; management requires owner/admin, execution requires an explicit role grant even for owners. An approved target includes the connection ID/revision and granular member/workspace access epochs. SQLite triggers advance epochs on effective role/grant changes, including changes through Better Auth, and share the mutation's transaction. Unrelated organization changes do not alter the target; revoke/restore cannot revive it.

The existing durable workflow worker authorizes account writes through the identity service. Provider I/O stays outside the identity queue; dispatch and the final result commit recheck authority in that queue. Pending work survives session expiry/logout but not changed membership or calendar configuration. A lost PUT response is reconciled by the same UID; access changes after dispatch produce an unknown result and never imply an external rollback. No account fallback to a legacy adapter is allowed. Separate identity/workflow stores remain a recovery boundary. See [details and limitations](../server-admin.md#workspace-calendar).
