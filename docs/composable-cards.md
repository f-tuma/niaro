# Composable cards

Cards are server-authored documents built from a small vocabulary of semantic blocks. A new task can use a new combination of blocks without requiring a new React component or a predefined card template. The client owns typography, spacing, colors, icons and interaction behavior.

The `agent-card/1` presentation extension is negotiated separately from the core workflow protocol. Existing contact, service and work entities keep their authoritative meaning and their legacy rendering path. A card is a presentation of a task or result, not proof that an operation ran or permission to run one.

## Document and primitives

A document has an ID, revision, title, optional subtitle and icon, an array of nodes, ordered root node IDs and an array of action definitions. Container nodes reference children by ID. The flat graph avoids deeply nested model JSON, gives form controls stable identities and allows the server to validate the complete document before sending it.

| Primitive                     | Use                                                         |
| ----------------------------- | ----------------------------------------------------------- |
| `heading`, `text`             | A short section title or readable explanation               |
| `field`                       | A visible label and value, with an optional local icon      |
| `badge`, `notice`             | A labeled state or an explanation with a semantic tone      |
| `divider`                     | Separation between meaningful groups                        |
| `section`, `stack`, `columns` | Grouped content and an adaptive layout                      |
| `disclosure`                  | Optional detail that the person can expand locally          |
| `list`                        | A bounded list of titles and optional details/icons         |
| `code`                        | Task-relevant literal content when the person needs it      |
| `progress`                    | A real count with a visible label and total                 |
| `button`                      | A reference to an approved action definition                |
| `input`                       | A labeled text, number, date, time, choice or toggle answer |

The vocabulary is intentionally semantic. It does not accept HTML, Markdown with executable behavior, CSS, colors, custom fonts, JSX, remote components, scripts, or arbitrary RPC names. Icons are names from the shipped icon set. Unsupported and malformed documents fail validation instead of being interpreted as instructions.

The initial limits are 64 nodes, six nesting levels, six actions and 32,768 serialized content characters. Roots and ordinary containers hold at most 16 children; columns hold two or three. A card may have one primary action. Every node has exactly one parent or is a root: missing references, repeated references, cycles and unreachable nodes are rejected. Inputs must remain visible and belong to a submit action. These are protocol limits; the authoring guidance below recommends smaller cards.

## Authoring for a person

Use one card for one task or decision. Start with a short title that names the result or the person's decision, rather than an implementation detail or tool name. Put the most useful facts first. Prefer three to six essential values; group related information into named sections. Disclosures are for useful task detail. Do not append raw source payloads, tool JSON, diagnostics or a “Source details” section.

Use `field` nodes for a complete phone number, email address or verified HTTP(S) URL. A phone field carries the `phone` icon; ordinary digits and record IDs do not become phone links. Email and URL destinations are derived from the complete visible value. Put separate contacts or destinations in separate fields. A tap opens the person's dialer, mail app or browser, without placing a call, sending a message or executing a server action. Unsupported URI schemes, embedded commands, email header parameters and ambiguous mixed values remain selectable text. The same behavior applies to stored `agent-card/1` fields; no protocol extension or profile bump is needed.

Use the person's language consistently. Labels are concrete: **Recipient**, **Starts**, **Find another contact**. Buttons use a verb and object that describe the next step. Avoid ambiguous **OK** or **Continue** labels. Dates carry the relevant timezone; money carries its currency. Do not infer either from the UI language.

Prefer one primary action and at most two secondary actions. A status needs visible text as well as an icon or tone. `running`, a transport acknowledgment and an unverified result must not be presented as completed work. A failure should explain what the person can do next, without inventing a retry that might duplicate an external write.

Cards use a vertical mobile layout by default. Columns are a small adaptive grouping, not a fixed-width desktop grid. Text wraps, controls allow enlarged text and tap targets remain at least 48 logical pixels. Never shorten or hide a recipient, cost, date, timezone or other material effect of an approval. Decorative icons do not replace readable labels.

The model composer receives these same rules through `CARD_COMPOSITION_INSTRUCTIONS`. Validation also enforces document size, graph integrity, supported primitives and action relationships; prose instructions are not the authorization boundary.

## Actions, forms and confirmation

`reply` actions send the exact visible button label as the next authenticated user message. A `submit` action submits the declared form fields as answer data. The action definition does not contain hidden instructions, an arbitrary endpoint, a service credential or a business tool call. The usual server loop evaluates the new request with current identity, policy and permissions.

A server-generated card cannot grant consent by adding a button named **Approve**. For an external write, the client owns the critical confirmation frame and controls. The frame shows the authoritative service, effect, current parameters and current operation or proposal identity. Its explicit confirmation travels through the existing revision and idempotency checks. A composable card may explain a proposed action inside this frame; it cannot override the frame, disguise the effect or hide the review data.

Model-authored passive service content is additional context, not a second authoritative operation state. The canonical service frame remains visible; confirmation context is expandable separately from the mandatory review fields. Composition instructions require factual agreement, but the graph schema cannot establish the truth of arbitrary wording, badges or progress claims. In particular, a model can still phrase additional context misleadingly while the authoritative state says awaiting confirmation or result unknown. Live-model evaluation must measure this consistency; successful schema validation does not prove factual correctness.

An action is tied to its card ID and revision. Stale revisions, a different authenticated scope, unsupported actions and invalid form answers are rejected. Offline and in-flight controls are disabled. Rendering, opening a disclosure, restoring history and replaying a snapshot never execute a business action. A new server revision resets the local form to current server values and displays a localized notice asking the person to review the changed fields.

Only the current final assistant message in the conversation can accept a card answer. Another user turn or assistant response supersedes the request. `card.respond` identifies the conversation, message, card, expected revision and action, plus the declared values and normal command/idempotency IDs. The server looks up the current stored document and derives the visible intent; it does not trust an action definition supplied by the client. Submitted answer text remains bounded by the ordinary message limit. A scoped request guard checks the binding again before service dispatch. Once an operation has a recorded remote outcome, a newer turn cannot erase that result. Read-only recovery of a saved outcome verifies the entire original command hash and performs no inference or provider dispatch; it requires the saved known answer and the original card binding. Other interrupted outcomes remain in the durable operation ledger, and stale work is not restarted.

## Server SDK and adapters

`apps/server-cards/composer.ts` validates model-authored documents with `composeCard(raw, { id, revision })`. The server supplies the identity and revision. `apps/server-cards/builders.ts` provides a typed builder for code-authored documents; the builder uses the same final validation.

```ts
import { CardBuilder } from "../server-cards/builders";

const builder = new CardBuilder({
  id: "review-contact",
  revision: 1,
  title: "Contact for the review",
  icon: "person",
});
const name = builder.add(
  { type: "field", label: "Name", value: "TEST Anna Example" },
  { root: false },
);
const email = builder.add(
  { type: "field", label: "Email", value: "anna@example.test", icon: "mail" },
  { root: false },
);
builder.add({ type: "section", title: "Participant", children: [name, email] });
builder.action({
  id: "another-contact",
  label: "Find another contact",
  kind: "reply",
  variant: "secondary",
  icon: "search",
});
const document = builder.build();
```

`add()` returns a stable node ID within this builder. Child nodes use `root: false`; a container attaches them to the graph. `action()` registers a visible action and adds its button. `build()` rejects an incomplete, invalid or excessive document. Explicitly authored work bodies retain their layout when their document revision matches the current work revision; stale default summaries regenerate from authoritative work state. This example is an ordinary suggestion; an adapter for a service operation deliberately produces a passive body and keeps the trusted operation controls separate.

`apps/server-cards/adapters.ts` turns current authoritative service results, work summaries and CRM contacts into documents. The mapping is deterministic and requires no extra model call. It uses grouped field rows for data, truthful state labels and bounded previews with an explicit notice when more results exist. Known phone fields get the semantic phone icon; complete email addresses and HTTP(S) URLs get matching icons. Raw source summaries stay in server data and are omitted from the user card and its outer service frame. Critical service approval controls stay outside the adapter's document, including full authoritative review parameters.

Rich record previews include at most six records. Unusually large JSON-escaped field data reduces the service preview further and explicitly reports omitted results. Work previews also report any shortened exceptional content. These bounds affect display only: full authoritative approval parameters remain available in the confirmation frame.

## Delivery compatibility

The updated client opts in on `snapshot`, `events`, `commands` and `server` by adding `cards=agent-card%2F1`. The normal bearer authentication and workspace route still apply. This is a display extension, not a new grant or a body field on a command.

| Request relative to `/v1/<workspace>/`           | Negotiated result                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `GET snapshot?cards=agent-card%2F1`              | Complete current documents on messages, service results and work      |
| `GET events?after=<cursor>&cards=agent-card%2F1` | Documents retained in the existing event entities                     |
| `POST commands?cards=agent-card%2F1`             | Documents retained in the returned snapshot, including durable replay |
| `GET server?cards=agent-card%2F1`                | Component catalog advertises `card.document: 1`                       |

Requests without the extension, or with an unsupported card profile, receive the existing textual messages, service presentations and workflow entities with composable documents omitted. Card-only messages retain their plain-text answer. Service approval review fields and parameters remain present; work retains its ordinary status and references. Authentication, voice, activity and service-connection metadata do not negotiate this document extension. The main workflow profile remains unchanged.

When adding a new task, first try a new combination of existing primitives. Add a primitive only when it introduces a useful semantic or interaction capability that existing blocks cannot express. Changing spacing or color is a client theme change; changing node meaning or action semantics is a presentation contract change.

## Verification

Use synthetic data and stable IDs in stories and tests. Cover a composed task, EN/CS, empty results, long labels, mobile width, forms, revisions and unknown outcomes. Reject duplicate or missing graph references, cycles, unreachable or excessive content, forged actions and unexpected style/code fields. Check that replay does not invoke callbacks and that confirmation keeps its authoritative review fields visible.

`tests/card-http.test.ts` checks real HTTP negotiation on all four routes, legacy fallbacks, form answers, scope/revision rejection, replay and server restart with a synthetic decision router. It does not call a paid model or an external business service.

`tests/agent-trust/card-scenarios.ts` exercises the real model-service and catalog runtime with scripted inference and synthetic service transport. It checks proposal versus approval versus verified outcome, an unknown outcome after dispatch, visible form intent, scoped and stale responses, and durable replay. The checker scenario proves that readable card claims reach the checker and a scripted rejection removes them before repair. It does not measure a live model's ability to judge truth or compose accurate cards, and it does not test the rendered client controls. Run these scenarios with `npm run eval:trust` as part of the wider loop evaluation.

The first implementation does not stream partial graph patches or load remote renderers. It does not add a new permission model. Evaluation with live models and physical-device accessibility checks remain separate from deterministic protocol and renderer tests.
