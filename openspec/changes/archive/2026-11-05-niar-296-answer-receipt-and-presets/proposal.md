# Proposal

Tracker: **NIAR-296**

## Why

An answer in the chat says nothing about how it came about. A member cannot see that it read their CRM, saved a fact, drew on two memories and a skill, or that a fallback model wrote it because the first one was at its limit. Administrators see this in Runs, members do not. NIAR-293 made model choice an administrator's policy, but members cannot pick between a fast and a thorough answer even when the administrator would allow it (owner decision of 2026-11-05: members may pick only among presets the administrator offers, off by default).

## What Changes

- **Answer receipt.** Under every finished answer on the web and the phone, one muted line built only from what the server recorded for that request: how many service reads and changes it made, the memories, skills, meetings and files in its context, and the model that wrote it by the administrator's display name, with "fallback model" or "stronger model after a check" when it was not the first choice. The line opens to the items. It never shows delivery states, never reads the model's text, and leaves out anything the person can no longer open.
- **Receipt API.** `GET /v1/:workspace/receipts?conversationId=` returns the receipts of the chat's latest 40 turns of the person asking, keyed by the request the answer replies to.
- **Recorded per run.** The run records the catalog model of the last finished model step with its route and reason, meetings read with `meeting_read`, and the chosen preset.
- **Member presets.** The model policy gets `options.presets {enabled, items[≤4]{id, name, tier}}`, organization default and workspace override like the other options, off by default. A preset is an administrator's name for an organization tier. `GET /v1/:workspace/chat-presets` lists what members may pick by name only. `message.send` takes `preset`; the run answers with the preset's tier only while it is offered, otherwise with the chat role.
- **Within the policy.** A preset reaches only its tier's models (the rest only with chat fallback on), must point to an existing tier that fits chat, keeps its tier from being removed, and in enforce mode its models need prices. Escalation still overrides it; budgets apply as to any chat step.
- **Visibility.** Runs show the preset on the model step; the receipt line shows it beside the model.
- **Console.** The Models page gets a Member presets section for the organization default and each workspace.
- **Configuration bundle.** Presets travel in the model policy and routing sections.

## Non-goals

- Members choosing models directly or seeing model ids, tiers or providers.
- Presets for roles other than chat (checker, selector, background).
- A receipt for process runs or hub fills.

## Risks

Presets that point to stronger tiers spend more; they are off by default, priced in enforce mode and capped by the same run budgets. Reading a receipt re-checks access per item, which costs a few reads per answer; it runs only when a new answer arrives.
