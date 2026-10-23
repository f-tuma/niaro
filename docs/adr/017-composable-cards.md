# ADR 017 — Composable server-authored cards

Date: 2026-09-30. Status: accepted for `agent-card/1`; model composition superseded by [ADR 019](019-generative-ui-openui.md). The server's passive cards for service results and work remain.

Service results previously selected one of five presentation types (`contacts`, `events`, `records`, `detail`, `text`), with task-specific renderers and separate fixed approval content. Adding a useful arrangement of facts required another predefined component or a special case. The server needs to compose task-specific information and answers while the client preserves a consistent, readable design and the existing consent boundary.

## Decision

Introduce a bounded semantic card document with a title, optional subtitle/icon, flat node graph, ordered roots and explicit action definitions. The supported vocabulary includes text, headings, fields, status, notices, groups, adaptive columns, disclosures, lists, code previews, progress, buttons and labeled answer controls. Containers reference node IDs. A complete document is validated before persistence or delivery: known types, graph integrity, bounded content and valid action/form references.

The server and its model can choose the content, semantic roles and arrangement. Local React Native components use existing design tokens for appearance, responsive layout and accessibility. The protocol accepts no arbitrary styling, JSX, remote executable components or service endpoints. Unknown or invalid interactions fail closed. The `agent-card/1` extension is negotiated independently; existing workflow entities and legacy content remain compatible.

A code-authoring builder and deterministic adapters share the same validator as the model composer. This keeps ordinary service results and work summaries independent of another model call while allowing a model to arrange relevant verified data. Composition instructions specify one focused task, clear hierarchy, three to six essential facts, one primary action, consistent language and truthful state. Layout never establishes the provenance or success of an operation.

Ordinary buttons express visible user intent. A reply submits its exact visible label; a form submits only the declared answer fields. These are new authenticated requests subject to the same server loop and current authorization. Neither form data nor a server-generated **Approve** label authorizes an external write.

Sensitive confirmation retains the client-owned trusted frame, authoritative effect and parameters, and existing operation/proposal decision commands. The composable body can explain the decision, but cannot replace its controls or hide review data. Card actions bind identity and revision; stale cards cannot silently execute revised intent. Rendering, history restoration and replay remain passive.

Negotiation uses `cards=agent-card/1` on the existing snapshot, events, commands and server routes. Without that extension, documents are omitted and the same plain-text replies, service review data and workflow entities remain available. Authentication, voice, progress and connection metadata retain their existing profiles.

## Consequences and limits

A new visual task generally requires composing existing blocks rather than implementing another card component. The design remains coherent because supported semantics map to one client theme. A new primitive changes the presentation contract; a spacing or color change stays inside the client.

Documents are complete bounded snapshots. Partial graph streaming, arbitrary remote renderer plugins and a general layout editor are outside this delivery. Model-provided wording is still untrusted content. Current deterministic adapters do not reinterpret tool results or infer an operation's success.

Custom passive service content augments the canonical frame and is not an independent source of operation truth. The schema validates the shape and available interactions; it cannot verify every factual phrase or model-generated status/progress claim. Composition instructions reduce that risk, while measured live-model consistency evaluation remains necessary. A misleading additional context must never replace the authoritative approval or unknown-result state.

Validation covers malformed graphs, unsupported content, action/form relationships and limits. Renderer stories cover varied arrangements, English/Czech, long text, state and narrow layouts. Integration tests cover authenticated dispatch and revisions. These checks do not substitute for a physical-device accessibility review or measured evaluation with live models.

The current protocol boundary is documented in [Protocol](../protocol.md#server-cards-optional-agent-card1).
