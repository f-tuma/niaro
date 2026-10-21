# ADR 012 — server-owned administration and identity direction

Date: 2026-09-25. Status: administration foundation implemented; OAuth design direction only.

The application remains a renderer of supported cards and commands. Connected servers own integrations, tools, memory, workflow, permissions and identity decisions. A separate same-server web administration displays those capabilities without putting integration credentials or business logic in the mobile application.

The first administration slice uses a distinct local operator key and short-lived HttpOnly cookie. Application pairing is not an administrator role. This explicit boundary must remain when adding OAuth; authenticating a user is not enough to authorize that user to administer an instance.

The intended primary sign-in is OpenID Connect through the selected server, using Authorization Code with PKCE. OIDC provides the user identity; OAuth alone is not an identity contract. The server should validate issuer/audience, signature, nonce and state, and map `(issuer, subject)` to its own user/workspace and explicit roles. Provider secrets stay on the server. Native browser return/deep-link handling should exchange a short-lived, one-use server code for the existing scoped client credential; provider tokens should not become client workflow tokens. The operator recovery key remains an independently revocable backup.

No provider, redirect URI, discovery URL or client registration has been configured in this slice. Do not advertise OAuth as working. Before enabling it, implement callback/PKCE verification and error/replay tests, HTTPS deployment/session policy, explicit administrator assignment, scoped app-session issuance, logout/revocation, and an end-to-end browser/native sign-in check. These are implementation requirements, not extra prompts before ordinary UI work.

References: [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html), [OAuth 2.0 Security Best Current Practice, RFC 9700](https://www.rfc-editor.org/info/rfc9700/).

Next increment: choose/configure one OIDC provider and implement server-owned login for the app and administration with separate roles. Configuration editing and connection setup can then be added to this existing web shell; no integration-specific UI or credential handling belongs in the chat client.

The chosen implementation direction is now Better Auth with organizations and explicit workspace/tool authorization. See [ADR 013](013-better-auth-organizations.md); provider sign-in remains unimplemented.
