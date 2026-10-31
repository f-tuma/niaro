# Proposal

Tracker: **NIAR-246**

## Why

The assistant learns nothing about the person unless they type "Remember …", so every chat starts from zero: it does not know their job, projects, colleagues, tools or how they like answers. The owner wants Niaro to build a working profile of each person gradually and openly, in a playful form that makes a system that "knows you" feel friendly rather than strange: a **pet** that remembers you and helps you work with the agent.

## What Changes

- **Observations.** After a person's chat turns and recorded meetings, a background step extracts short observations about their work (role, projects, tools and services, people they work with, how they like answers, working rhythm) and saves them as private memory records of a new origin, `observed`. They apply immediately: the agent uses them like saved memory from the next turn. **BREAKING** for the `memory` spec's rule that only an explicit "Remember …" saves a memory; that rule stays for explicit saves and gains a separate, bounded path for observations.
- **Provenance and control.** Every observation shows what it was learned from (a chat or a meeting, with a link) and when it was last seen. The person can delete it, correct it (it then becomes their own assertion), or mark it personal or work.
- **Personal filter.** Observations are classified work or personal. A **Personal things** setting ("Keep" by default, or "Don't keep") lets the person drop personal observations: switching to "Don't keep" erases the existing ones and discards new ones at extraction.
- **Pet page.** A new web app area **Pet** (sidebar, after the work areas) with an abstract mascot: a small, glossy liquid body in a Material 3–style shape with coloured droplets inside, one per part of the profile it knows. The person names it and picks its colour; its shape changes by itself with the profile unless the person pins one; the droplets come only from the profile, so it reflects their real work. It grows through four stages as it knows more and greets the person with a short line drawn from what it recently learned, without a model call. It is drawn by one small WebGL shader (no 3D library), within a fixed frame and resolution budget. Below the pet, the profile is grouped into sections (Work, Projects, Tools, People, Style, Rhythm, Personal) listing the observations.
- **Position and department.** The person's job title and department are suggested from their Microsoft 365 account when they are signed in to it, and the person confirms or overwrites them. They are profile facts for the agent, never a source of permission.
- **Private.** The pet and the profile are visible only to their owner. Administrators see neither; sharing pets with colleagues is a later change.
- **Existing mobile companion.** Reuse the accepted shared pet and its exact original interaction semantics. Local day/evening/night works without location or network. Optional personal weather is Off by default, or an explicitly selected City or approximate foreground Device source after OS consent; no background tracking, shared workspace location or automatic City fallback. Source and attribution/timestamps live in Settings, without extra Home greeting/helper prose. This bounded mobile slice does not implement the profile page or learning backend.
- **States.** Memory plugin off (the pet sleeps and explains that learning is off), memory opted out, empty profile (a new pet), loading and error. EN and CS.

## Non-goals

- Voice profiles for naming speakers in meetings (separate change; needs explicit biometric consent).
- The server-wide shared index that reuses finished work by position and permissions (separate later change).
- Sharing or showing pets to colleagues.
- Reading mailboxes, calendars or documents in the background to build the profile; observations come only from the person's own chats with Niaro and meetings they recorded.
- A generated portrait, photo or image model.
- A new native profile screen (the profile page works in a phone browser); the existing mobile companion gains only the bounded clock/weather controls above.
- Reverse geocoding, web-to-phone activation/synchronization, exact-address lookup, new production shapes and minigames.

## Risks

- **Wrong or unwanted inferences apply before the person sees them.** Mitigation: owner-only visibility, provenance on every item, one-click delete and correct, the personal filter, observations framed to the agent as untrusted data that never grant permission, and a cap on how many reach each turn.
- **Sensitive personal data (health, family, beliefs) reaches the profile.** Mitigation: extraction instructions exclude special categories of personal data outright; anything else personal is labelled and can be dropped wholesale.
- **Cost.** Mitigation: extraction is batched per person (at most once every 10 minutes) and runs as its own root run in the inference ledger with small caps.
- **Prompt injection through service results or meeting speech.** Mitigation: extraction reads the person's own messages and turns, never service results or other speakers' instructions; observations never authorize actions.

## Capabilities

### New Capabilities

- `work-pet`: the person's pet and profile page: the mascot and its personalization, growth stages and greeting, profile sections, job title and department with the Microsoft 365 suggestion, owner-only visibility and the page states.

### Modified Capabilities

- `memory`: observed records (who writes them, from which sources, classification work/personal, provenance, merge with an earlier observation, capacity, retention), the **Personal things** setting, correcting and reclassifying an observation, and how observations are retrieved for a turn next to saved memories.

## Impact

- Server: `apps/server-identity/memory.ts` (origin `observed`, personal flag, sources, merge, capacity, setting), a new extraction step and its scheduling after chat turns and meeting publication, the pet/profile API, the Microsoft 365 job title suggestion.
- Agent context: retrieval of observations next to saved memories.
- Protocol: `packages/protocol/memory.ts`, a later pet/profile schema and a separately negotiated `pet-weather/1` sidecar; existing strict ServerInfo and speech schemas stay unchanged.
- Web app: new Pet area (router, sidebar, page, copy), `docs/ui-system.md` sidebar order and its route test; shared pet renderer with static fallback.
- Mobile companion: existing PetView/Settings integration and local clock, exact SDK57 location/localization dependencies only after approval; native generation/build/install is a separate gate.
- Weather: private actor/workspace source and encrypted City preference in identity storage; server-only MET Norway and operator-selected Nominatim adapters disabled until informed setup, genuine contact and single-owner application-wide admission are ready. Open-Meteo free hosted access is not a generic commercial-free service.
- Depends on NIAR-243 (member Memory page): observations also appear there as private memories.
- Tests: memory store and HTTP tests, extraction tests with a controlled model, web page tests.
