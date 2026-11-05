# Design

## Bundle envelope and sections

`{profile: "niaro-config-bundle", version: 1, exportedAt, source: {server}, organization: {<key>: data}, workspaces: [{name, sections: {<key>: data}}]}`. The envelope only names sections; each section's data carries its own `version` and is validated by that section's schema, so the file version stays stable when a section is added or reshaped.

Every section is one `ConfigSection` (`apps/server-identity/config-bundle/registry.ts`): `key`, `schema`, `export(ctx)` and `apply(ctx, data, outcome)`. `index.ts` lists them in apply order (server settings, providers, models, installed connectors; then roles, services, routing, usage, plugins, skills, processes), so what a later section names exists when it is applied. NIAR-293 (routing reshaped into roles and tiers) replaces `sections/routing.ts` and its section version; NIAR-295 (workspace instructions and starters) adds one more entry. Nothing else reads routing.

## References by name

`refs.ts` resolves models by provider name and model id, services and actions by name and workspace roles by name, always from the current state, so a section sees what earlier sections of the same import added. A reference that does not resolve is that item's `reference_missing` conflict; the rest still applies. Grants to one person, members' own services, personal skills and personal processes stay out: they are about the people of one server.

## The preview is the import, rolled back

There is one code path. A preview runs `applyConfigBundle` inside `BEGIN IMMEDIATE` and rolls it back; cached server settings are dropped afterwards. Every item runs in its own savepoint, so an item the stores refuse (any `IdentityError` from their own checks) becomes a conflict with its code and leaves nothing behind. Work that cannot share a transaction (starting an installed connector, applying server settings to the running server) is queued with `afterCommit` and never runs for a preview.

## Revision, idempotency, audit, authority

The preview returns `revision`, a SHA-256 of the canonical export of the whole organization. The import recomputes it inside its transaction and answers 409 `config_bundle_conflict` when it differs, so what was reviewed is what is applied. Sections compare stored and imported values canonically and write only on a difference: a second import returns every item unchanged and writes nothing but its audit entry (`config.bundle_imported` with added and changed counts, never content). Skills and processes keep their own audit entries. When the catalog's authority shape or the role names change, the organization's policy epoch advances, as for console edits.

## Secrets

Nothing in a bundle is secret: providers and services say `keyRequired`, installed connectors list secret names only. An import never sets, changes or removes a stored key. A provider or service whose stored key would go to a different address is refused (`address_changed`). New providers and services without a key are reported as needing one. A service with an authentication but no key is saved through `saveImportedService`: the console's checks minus the key requirement.

## Member exports

`member-export.ts` serves `GET …/conversations/export` and `GET …/memory/export` with the session cookie. The chat export reads the same public history projection as the apps, so it holds only what the person sees; the memory export reads only the person's private rows, decrypted for them.

## Risks

- Large bundles: the import body limit is 16 MiB and the console waits up to two minutes.
- A service on an installed connector keeps the source server's local address and may need its address changed after the import.
