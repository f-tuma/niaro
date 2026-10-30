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

The animated pet SHALL render at most 30 frames per second on a canvas of at most 480 × 480 device pixels, only while it is visible on screen and the tab is active, and SHALL show a single still frame when the person prefers reduced motion. Where the animation cannot run, the page SHALL show a still image of the same pet. The pet SHALL have a text alternative naming it, its stage and the sections it knows.

#### Scenario: Reduced motion

- **WHEN** the person's system asks for reduced motion
- **THEN** the pet is shown still, without breathing, blinking or morphing

### Requirement: Expressions

The pet SHALL show tamagotchi-style expressions on its face: eyes (round, happy arcs, hearts, a wink, closed when asleep), a small mouth (smile, frown, open) and blush, changing smoothly between them. Its resting expression SHALL follow its state and the weather mood, and it SHALL now and then look around or, at night, yawn.

#### Scenario: Rainy day

- **WHEN** the weather mood is rain
- **THEN** the pet rests with a slight frown until something else changes its expression

### Requirement: Reactions to touch

Clicking or tapping the pet SHALL make it squish, lean away from the touch and show a short reaction with a small symbol above its head (a sparkle, a note, an exclamation mark or a heart), taking reactions in turn; many quick taps SHALL make it giggle, and a tap on a sleeping pet SHALL make it stir and fall asleep again. Reactions SHALL be produced without a model call and SHALL NOT change the profile.

#### Scenario: Tap

- **WHEN** the person taps the pet
- **THEN** it squishes, smiles with happy eyes for about a second and a sparkle rises above it

### Requirement: Weather mood

When the workspace has a location set, the pet SHALL reflect the current weather there (sun, rain, snow, storm, fog) and the night in the person's time zone through the studio light, particles and its resting expression, refreshed at most every 30 minutes; without a location it SHALL show only day and night. Under reduced motion it SHALL show the mood without particles or flashes.

#### Scenario: Snow

- **WHEN** it snows at the workspace's location
- **THEN** the pet's light turns cool, snow falls around it and it rests with rosy cheeks

#### Scenario: No location

- **WHEN** no location is set for the workspace
- **THEN** the pet shows no weather, only night after dark in the person's time zone

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
