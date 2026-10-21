# Security policy

Agent Client is a development preview, not a security-audited public service. The supported setup is one unprivileged Node process with local SQLite storage behind an HTTPS reverse proxy. See [self-hosting](docs/self-hosting.md) for origin checks, private endpoint allowlists, credentials and backups.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on the repository's _Security_ tab (private vulnerability reporting). Do not open a public issue, and do not include secrets, raw conversations, operation parameters, customer data or a live API key.

A useful report contains:

- the affected revision or version;
- the configuration shape with secrets removed;
- a synthetic reproduction, the expected and the actual result;
- the impact you see.

Reports about cross-organization access, stale or replayed approvals, repeated writes, secret disclosure and outbound network restrictions are especially valuable. You will get an acknowledgement as soon as possible; please allow time for a fix before any public disclosure.

## Supported versions

Only the latest `main` branch receives security fixes while the project is in preview.

## Operating guidance

Revoke a compromised provider key at its provider and rotate the stored credential. Preserve operation receipts and audit records during incident response. Rotating the recovery key does not replace the identity encryption secret; replacing that secret without re-encrypting credentials makes them unreadable.
