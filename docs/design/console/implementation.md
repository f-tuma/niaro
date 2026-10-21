# Server console redesign

Active user brief (2026-09-26): a coherent developer console for a self-hosted, open-source assistant server. Services are added with API/MCP URL and a key. Discover/generate editable actions; add, remove, enable and grant by roles or individual users. Maintain an administrator-owned AI provider/model catalog separately from model assignments. Services use recognisable icon cards, not a long settings list. Server owns policy, credentials, model routing and execution.

## Visual specification

The three image concepts in this folder were generated with the built-in Image Gen tool before implementation. They guide the services index, service/actions detail and provider/model catalog. No image is shipped as interactive UI. This is autonomous implementation, not a request to pause for visual approval.

- True white canvas, pale slate-neutral sidebar; charcoal primary text, slate secondary text, restrained cobalt action/selection, semantic green/amber/red statuses. Keep current Manrope variable font; 14px controls/body, 12px metadata, 28–32px semibold page titles, 18px section headings. Border 1px, radius 10–12px, minimal shadow.
- Sidebar around 232px; company/workspace context lives once near its top. Primary navigation: Services, AI providers, Model routing. Secondary: People, Workspaces, Audit log, Settings. Recovery-key login opens account setup. Mobile has a labelled navigation sheet and compact context header.
- Services: header + one Add service CTA; search/protocol filters; responsive icon cards (3/2/1 columns). Card anatomy: icon, state, name, URL host, protocol/action count, access summary, Manage. Empty state gives one useful next step. No fabricated service records.
- Service detail: breadcrumb, icon/name/endpoint, Connection settings action. Tabs Actions / Model / Activity. Actions table has name, binding, access, enabled/draft state. Inline side editor on wide screens, stacked on small screens; no nested menus. Discovery results remain explicit drafts; differences never silently overwrite edited actions or grants.
- Providers: a compact provider selector beside provider details and model table. Connection secrets are write-only; adding a model and fetching available models are distinct actions. Model routing is a separate page with workspace defaults and service overrides.
- Forms use the full available content width, with related fields paired only when both are present. Service icons occupy separate 64px-high choices with 12px gaps in a responsive container-based grid. Forms use shadcn Field/FieldGroup, labelled inputs, inline errors and a clear final save action. Advanced schemas/transport options are collapsed initially. Dirty edits survive transient refresh failures; permissions and revisions gate saving. Service icons default to server-fetched website favicons, with semantic Lucide symbols as fallback or explicit override. The form previews the icon from the URL; the symbol grid appears when Custom symbol is selected.

Intentional concept corrections: retain the real Agent Client terminal mark on all screens (the action image invented a 20 logo); omit invented footer/community links and synthetic user avatars; show actual role/user access summaries. Use real model IDs and actual capability/state metadata, never the concept's illustrative model names or a fictitious live-health indicator. Hide an extra connect tile when it only duplicates an empty-state CTA. Owner remains a distinct role alongside admin/member. Forms may include schema and confirmation-policy controls required by actual execution. Translations EN/CS stay complete.

## Architecture and delivery checkpoints

1. Add bounded protocols and persistent organization-owned provider/model catalog, workspace services/actions/routing and encrypted credentials. Preserve existing account/calendar/CRM data and adapters.
2. Add a pinned-destination HTTP transport (public HTTPS by default, explicitly trusted private origins for self-hosted services), OpenAPI JSON discovery/local refs, remote Streamable HTTP MCP discovery/calls, schema validation and draft import. AI enrichment may edit presentation only against discovered bindings, never grant authority or invent code.
3. Implement one current-identity authorization path: workspace membership + enabled service/action + role OR explicit-user allow, explicit-user deny wins. Revisions cover concurrent editing and in-flight revocation. Audit excludes payloads and secrets.
4. Bind real model requests to the selected provider/model and authorized action catalog. Add bounded server-side execution, durable mutation receipts/unknown results and explicit approval where configured. New console actions must not be decorative metadata disconnected from the runtime.
5. Rebuild shell and flows from the visual specification; use the ordinary API/MCP service flow for all new connections; retain existing server data without compatibility cards or separate legacy editors.
6. Add self-hosting/deployment docs, secure HTTPS-origin configuration, first-run setup and repository contribution/security guidance. License awaits user's choice. Do not claim public deployment or external OAuth is configured.
7. Empty-context reviews of backend/authority and UI, synthetic HTTP/provider integration tests, browser desktop/mobile EN/CS QA, concept-vs-render inspection. Back up and verify main data before restart; no real business writes or expired provider renewal.

## Fidelity evidence

To be completed against the running implementation: hierarchy/navigation, card anatomy, typography, palette, detail/editor flow, responsive layouts, copy and functional-state differences.

### Browser comparison, 2026-09-26

- **Hierarchy:** the rendered console keeps the concept's pale 232px sidebar, clear primary/organization navigation groups and shared context selector. The terminal mark replaces the invented CRM mark. Active navigation is now stable with TanStack's `/admin` base path.
- **Cards:** three columns on the desktop, one on the small viewport; icon, state, name, host, protocol/action count and permissions retain the reference order. No fake connected/healthy state: untouched imported actions say Draft. The built-in connector strip was removed following user feedback; all new services enter through Add service.
- **Type and palette:** retained Manrope and restrained cobalt controls, white content surface, light neutral panels, subtle borders and rounded cards. Destructive controls use a muted red. No illustrated assets are shipped into the UI.
- **Action flow:** service title and compact tabs lead into the action table; selection opens the inline editor. At narrow widths it stacks. Schema, per-user policy and test execution expand only when needed; method/effect/approval are explicit because they change execution semantics.
- **Provider flow:** left provider selector and right connection/model catalog mirror the concept; actual enabled/tool flags replace invented capabilities and health indicators. Assignment is on a separate routing page, verified with different default and service model IDs and two consecutive saves.
- **Forms/state:** editing an imported action saved successfully in the browser; draft survived explicit Refresh. Concurrent conflicts offer explicit discard/reload. Disabled assigned models remain visible and can be cleared. Write-only credential fields do not show stored secrets.
- **Responsive/copy:** checked English desktop and Czech small viewport, with one-column cards, navigation sheet and wrapped form labels. Full-page horizontal overflow was absent. More advanced options stay under disclosure controls. Web pages use browser QA rather than React Native Storybook; the new native action card has stories and interaction tests.

Evidence is stored as `rendered-services.png` plus local QA captures of actions, providers, routing and mobile services. Concepts intentionally contain illustrative data; main company data is never seeded from them.
