## Purpose

The work pet is each person's playful, private view of what Niaro has learned about their work: an abstract mascot they personalize, which grows with their profile and shows its observations, job title and department.

## ADDED Requirements

### Requirement: Pet area

The web app SHALL have a **Pet** / **Mazlíček** area at `/pet`, the last entry of the sidebar after the work areas, showing the signed-in person's pet in the current workspace with its profile below it. Every workspace member SHALL have one pet per workspace, created with defaults on first open.

#### Scenario: First open

- **WHEN** a member opens Pet for the first time in a workspace
- **THEN** they see a new pet with a default name, form and colour and an empty profile with a hint how it learns

### Requirement: Owner-only pet

A pet, its personalization and its profile SHALL be readable and changeable only by its owner. Owners and administrators SHALL NOT read another person's pet or profile through any API, and the recovery-key operator session SHALL be refused (`identity_account_required`). Requests addressing another person SHALL answer as if the pet did not exist.

#### Scenario: Administrator

- **WHEN** an administrator requests another member's pet
- **THEN** the server answers `404 pet_not_found`

### Requirement: Pet personalization

The person SHALL set the pet's name (1–40 characters) and body colour (one of 8), and its body shape: either **automatic** (default) or one of 8 shapes pinned by the person, revision-checked (`409 pet_conflict` on a stale revision). The person SHALL NOT choose the pet's inner colours.

#### Scenario: Rename

- **WHEN** the person renames the pet "Bublina"
- **THEN** the page and the greeting use the new name

#### Scenario: Pinned shape

- **WHEN** the person pins the shape "Clover"
- **THEN** the pet keeps that shape whatever it learns, until the person switches back to automatic

### Requirement: Appearance reflects real work

The pet SHALL show one inner colour for each profile section that has at least one work observation (each section a fixed colour), sized within fixed bounds by how many observations the section holds. Personal observations SHALL NOT change the look, and deleting observations SHALL shrink or remove their colour.

#### Scenario: New section

- **WHEN** the person's first observation in section `tools` is saved
- **THEN** the pet shows a new inner colour for Tools

#### Scenario: Deleted observations

- **WHEN** the person deletes every observation in section `tools`
- **THEN** the Tools colour disappears

### Requirement: Automatic shape

With the shape set to automatic, the pet SHALL take the body shape assigned to the section with the most work observations, and a round body when there are none, changing shape by a smooth transition.

#### Scenario: Strongest section changes

- **WHEN** Tools overtakes Work as the section with the most observations
- **THEN** the pet morphs from the Work shape to the Tools shape

### Requirement: Rendering budget

The animated pet SHALL render at most 30 frames per second on a canvas of at most 480 × 480 device pixels, only while it is visible on screen and the tab is active, and SHALL show still frames without repeating animation when the person prefers reduced motion; a local touch MAY show a static acknowledgment for1,400ms. Where the animation cannot run, the page SHALL show a still image of the same pet. The pet SHALL have a text alternative naming it, its stage and the sections it knows.

#### Scenario: Reduced motion

- **WHEN** the person's system asks for reduced motion
- **THEN** the pet is shown still, without breathing, blinking or morphing

### Requirement: Expressions

The pet SHALL express emotion through eyes, mouth and blush. Actual work/listening/speaking and supplied rest state SHALL take priority over touch, bounded idle and clock/weather mood. Night SHALL NOT create authoritative sleep. Idle SHALL pause while occupied, hidden, inactive or under reduced motion.

#### Scenario: Rainy day

- **WHEN** the weather mood is rain
- **THEN** the pet rests with a slight frown until something else changes its expression

### Requirement: Reactions to touch

Touch SHALL preserve the original release-classified quiet/cadence/zone/BAG behavior, bounded hug/stroke and sleeping stir, with one projected upper-right water sign. It SHALL remain local, never change the profile or call a model/provider, and cancel owned effects on lifecycle/work preemption. Reduced motion SHALL give a1,400ms static face/sign acknowledgment without repeating animation.

#### Scenario: First tap after quiet

- **WHEN** the person releases a tap after at least30s quiet
- **THEN** the pet shows happy and sparkle, after its bounded press/release response

#### Scenario: Original rapid cadence precedes zones

- **WHEN** accepted rapid taps reach counts2–4,5–8 or9+
- **THEN** the corresponding giggle, laugh or quiet dots moment wins before zone selection, with gaps<700ms incrementing count, slower gaps cooling count by gap/1.5s to a floor of1, and ninth+ resetting count with2s pause; ordinary BAG is happy+sparkle / wink+sparkle / happy+notes without immediate repeat

#### Scenario: Hug and stroke

- **WHEN** a hold with<12logicalpx initial travel reaches450ms and later900ms
- **THEN** bliss/blush and slower breath precede hearts, first hug is guaranteed and subsequent hearts share a25s budget; movement alone preserves hug, while meaningful stroke takes ownership
- **AND** stroke requires120–1600logicalpx/s, valid elapsed<=250ms,6px accumulation and three reversals in1.5s, and expires600ms after meaningful movement

#### Scenario: Reduced-motion local acknowledgment

- **WHEN** the person activates the pet under reduced motion
- **THEN** a static face/sign remains for1,400ms and returns without animated hug/cadence/particles; cancellation cannot leave a late sign

### Requirement: Weather mood

Optional personal weather SHALL affect only the existing pet's light, bounded particles and resting face. Off SHALL be the default. Day/evening/night SHALL work without weather. Day with no weather SHALL preserve plain optics. Reduced motion SHALL use static mood/face without particles or flashes. This slice SHALL add no lightning flash or extra Home/greeting/helper prose.

#### Scenario: Snow

- **WHEN** accepted current-source weather is snow and higher-priority state is idle
- **THEN** the pet has restrained cool light and rosy cheeks, with bounded snow only when animation is allowed

#### Scenario: Weather unavailable

- **WHEN** weather is Off, unsupported, unconfigured or has no eligible sample
- **THEN** the same pet still follows local day/evening/night without provider or location dependence

### Requirement: Local companion clock

The companion SHALL classify day07–18, evening18–20 and night20–07 using fresh device time and a validated current IANA zone. It SHALL refresh each foreground minute and on resume/zone change, stop clock timers in background, and handle DST/manual clock changes. If no valid native or current Intl zone exists it SHALL use a neutral unknown-clock mood without location/network fallback.

#### Scenario: Evening with weather Off

- **WHEN** local time changes from17:59 to18:00 with weather Off and no network
- **THEN** day becomes evening;20:00 becomes night and07:00 becomes day, without a permission prompt or weather request

#### Scenario: Changed zone and clock

- **WHEN** the device zone, DST or manual clock changes while active or away
- **THEN** the next relevant foreground reading uses fresh time/current zone, without advancing a cached offset or replaying missed ticks

### Requirement: Weather source and privacy

Weather source SHALL be owner/workspace-scoped Off, City or Device. Stored source/City SHALL never grant OS consent, mutate workspace location, become learned memory or activate another phone/web client. Source, selectedCity, identity or permission changes SHALL clear owned pending/displayed weather immediately. Settings detail SHALL expose source, attribution and truthful forecast/check/stale times.

#### Scenario: Device denial with saved City

- **WHEN** Device is selected but permission is denied or revoked and a City was saved earlier
- **THEN** Device weather clears and clock-only mood remains; City is available only by an explicit source choice

#### Scenario: Source changes while pending

- **WHEN** a person selects Off or changes City/account while acquisition or a provider request is pending
- **THEN** old-generation completion cannot restore weather or position, including a same-source stale sample

#### Scenario: Personal source is not shared workspace configuration

- **WHEN** an administrator changes their own weather source
- **THEN** another person's settings and workspace location remain unchanged and unreadable through the weather API

### Requirement: Device weather consent

Device weather SHALL require deliberate local Device opt-in and foreground OS consent; no mount/resume prompt, background/watch or accuracy upgrade. Coordinates SHALL round to two decimals before application state/transport and never persist raw/precise values. Volatile coarse position expires at30m; acquisition has an8s deadline with discarded late results. Services/module/permission failure SHALL clear Device weather.

#### Scenario: Local opt-in survives cold launch

- **WHEN** a cold app launch has current authenticated Device source and matching prior local installation/actor/workspace opt-in
- **THEN** it may check existing OS permission and resume a due foreground read without prompting, without restoring any position or permission snapshot

#### Scenario: Stored Device without local opt-in

- **WHEN** a new installation, another actor or a remote Device choice has no matching deliberate local opt-in
- **THEN** it shows Use this device and clock-only mood; an existing app-global OS grant alone cannot activate that actor

#### Scenario: Foreground resume

- **WHEN** an activated live runtime returns to foreground
- **THEN** it checks existing permission/services without prompting before showing or refreshing Device weather, and refreshes position only when due or explicitly requested

#### Scenario: Coarse-only permission

- **WHEN** Android grants only approximate foreground access, or iOS grants reduced accuracy
- **THEN** Device can use the lowest-accuracy request without asking for fine/full or background access; an existing iOS full grant also uses Lowest and immediate rounding without an accuracy upgrade or forced Settings action

#### Scenario: Existing iOS full grant

- **WHEN** a locally opted-in person already granted iOS full foreground access
- **THEN** the app uses Lowest and immediate two-decimal rounding without an accuracy upgrade or forced Settings roundtrip; raw SDK values remain transient

#### Scenario: Deadline and position expiry

- **WHEN** an acquisition resolves after its8s deadline, or retained position reaches30m
- **THEN** expired position cannot enter application state or transport; weather remains neutral until a current permitted acquisition succeeds

### Requirement: Submitted city lookup

City lookup SHALL require an explicit submitted city-name search through an authenticated configured server adapter, followed by deliberate result selection. It SHALL be bounded, cached, identified, attributed and switchable, with application-wide admission. It SHALL NOT autocomplete, reverse geocode, infer from memories/IP, accept exact addresses or activate a public provider without informed operator setup.

#### Scenario: Search, then select

- **WHEN** a person submits a city name
- **THEN** up to five bounded settlement choices are returned without changing source, and only an owner-bound unexpired selected result becomes their City

#### Scenario: No configured lookup

- **WHEN** the operator has not deliberately configured the city adapter or shared admission is unavailable
- **THEN** no external request occurs and the settings show concise unavailable state with Off/local clock still usable

### Requirement: Weather freshness

Weather fetches SHALL remain server-only and disabled until identified operator setup. Shared cache/deduplication SHALL enforce at least30m between cell attempts and provider Expires/conditional validation. A failed refresh MAY retain eligible same-source weather only until2h after accepted200/304 revalidation; Device also requires current<=30m position. Invalid responses SHALL NOT renew validity.

#### Scenario: Provider expiry exceeds display limit

- **WHEN** a cached sample reaches2h since accepted revalidation while provider Expires still prevents another fetch
- **THEN** weather becomes none until permitted successful revalidation; no premature fetch or extended display occurs

#### Scenario: Conditional unchanged forecast

- **WHEN** a permitted conditional request returns valid304 for cached forecast data
- **THEN** its check time renews and the current covering forecast interval is selected; a missing/expired interval cannot fabricate current weather

#### Scenario: Single-owner global city admission

- **WHEN** people in different workspaces submit public city searches together
- **THEN** the one existing identity owner shares a single dispatcher enforcing at most1request/sec, restart honors persisted gates/cooldown, and unsupported independent-owner public topology cannot claim shared admission

### Requirement: Weather sidecar compatibility

The system SHALL negotiate weather through separate strict scoped `pet-weather/1` capability/current/city routes, leaving existing strict ServerInfo/speech contracts unchanged. Owner commands SHALL be revision/generation checked and idempotent. Unsupported404/406, malformed/foreign responses and unknown mutation outcomes SHALL never produce fake weather, implicit permission or an automatic replacement write.

#### Scenario: Old server

- **WHEN** a server answers404/406 to sidecar capability discovery
- **THEN** weather controls report unsupported and perform no provider/location operation, while the local clock and ordinary session remain usable

#### Scenario: Replayed preference after later change

- **WHEN** a recorded source/City command is retried after another preference was accepted
- **THEN** a still-matching last receipt returns current snapshot without reapplying; an older retry after a newer command conflicts on its old revision and cannot restore clearedCity

### Requirement: Growth stages

The pet SHALL show one of 4 growth stages computed from the person's profile: stage 1 with no observations, stage 2 with observations in at least 2 sections, stage 3 with at least 4 sections and a confirmed job title, stage 4 with at least 6 sections. The stage SHALL go down when observations are deleted, and the page SHALL say in one line what helps the pet grow. No stage SHALL add an exterior glow or halo; the body’s own highlights and internal colours remain.

#### Scenario: Growing

- **WHEN** a person with observations in 3 sections confirms their job title and gets an observation in a fourth section
- **THEN** the pet moves to stage 3

### Requirement: Greeting

The page SHALL show a short greeting in the person's language naming the pet and, when there is one, quoting the work observation seen most recently in the last 7 days. The greeting SHALL be produced without a model call and SHALL never quote a personal observation.

#### Scenario: Recent observation

- **WHEN** the latest work observation is "Prepares the weekly sales report on Mondays"
- **THEN** the greeting mentions that the pet noticed it

### Requirement: Profile sections

Below the pet the page SHALL list the person's observations grouped in the sections Work, Projects, Tools, People, Style, Rhythm and Personal (personal observations of any section), each with its statement, sources, last-seen time and actions **Correct**, **Mark personal** or **Mark work** and **Delete**, using the memory commands. Empty sections SHALL be shown collapsed with a one-line explanation. The page SHALL offer the **Personal things** setting.

#### Scenario: Delete from the profile

- **WHEN** the person deletes an observation after confirming
- **THEN** it is erased as by `forget`, it leaves the profile and the pet's inner colours, shape and stage are recomputed

### Requirement: Job title and department

The person SHALL be able to set, change and clear their job title and department (each 1–120 characters) per workspace, revision-checked. When the person is signed in to Microsoft 365 and their account has a job title or department that differs from the saved values, the page SHALL offer it as a suggestion marked "From Microsoft 365", which applies only when the person accepts or edits it. A job title or department SHALL never grant permission or change roles, grants or approvals.

#### Scenario: Suggestion

- **WHEN** a person signed in to Microsoft 365 has the job title "Sales manager" there and none in Niaro
- **THEN** the page offers "Sales manager" from Microsoft 365, and it is saved only after they accept it

#### Scenario: Not authority

- **WHEN** a member sets their job title to "Administrator"
- **THEN** their role and access are unchanged

### Requirement: Pet states

The page SHALL show distinct states: loading; a load error with retry; the memory plugin off in the workspace (the pet asleep, saying it cannot learn while memory is off, with personalization still available); the person opted out of memory (the pet asleep, with a way to turn memory back on); and an empty profile. All texts SHALL exist in English and Czech.

#### Scenario: Plugin off

- **WHEN** memory is disabled in the workspace and the person opens Pet
- **THEN** the pet is shown asleep with an explanation, and no observation is listed or learned

### Requirement: Pet API

The system SHALL offer `GET /admin/api/identity/pet?organizationId=…&workspaceId=…` returning `work-pet/1` with the pet (name, colour, shape or automatic, revision), the job title and department with revision, the Microsoft 365 suggestion if any, the derived stage, shape and inner colours, the memory state and the person's observations (at most 300), and `POST` with strict, idempotent commands `personalize`, `setPosition` and `acceptSuggestion`. Changes SHALL be audited without content.

#### Scenario: Retry

- **WHEN** a client repeats a `personalize` with the same `requestId`
- **THEN** the recorded result is returned and the revision advances once
