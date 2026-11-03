# Spec Delta

## ADDED Requirements

### Requirement: Pet never absent

Wherever the phone app shows the pet, the pet SHALL be visible from the first frame its place is on screen, for any look, colour, card, size and state, on first launch and on slow phones. Until the animated pet has really drawn, a picture of the pet SHALL stand in for it: its own first frame where the device has one, else the nearest picture of the same body, else a drawing of its look. The animated pet SHALL take over with a cross-fade and without moving.

#### Scenario: Look never drawn on this device

- **WHEN** the app starts for the first time with a pet whose look the device has never drawn
- **THEN** the first frame of the screen shows a drawing of that pet, which cross-fades into the animated pet

#### Scenario: Look changed since last time

- **WHEN** the pet's look has changed a little since it was last drawn (its ink follows the person's work)
- **THEN** the screen opens with the last picture of the same pet, and the new ink fades in where the pet stands

#### Scenario: Slow phone

- **WHEN** the phone is slow to prepare the animation
- **THEN** the picture stays until the animation has drawn its first frame; the place is never empty in between

### Requirement: One pet for the app run

The phone app SHALL keep one animated pet for as long as it runs, started while the app loads. Moving between screens that show the pet (Home, chat, the pet profile, a voice recording) SHALL move that pet, not prepare a new one. A preview shown in a separate sheet may be a second pet while that sheet is open.

#### Scenario: Touring the app

- **WHEN** the person goes from Home to a chat, to the pet profile and back
- **THEN** the pet is animated on each screen at once and the app has prepared the animation only once

### Requirement: Pet in its place

The one pet SHALL appear only in the place its screen gives it: hidden whenever a sheet, the menu or another layer of the app covers that place, and kept within the scrolling area of its screen. Touching the pet and reading it with a screen reader SHALL work in that place.

#### Scenario: Scrolling the profile

- **WHEN** the person scrolls the pet profile so that the pet passes under the top bar
- **THEN** the pet is cut off at the edge of the scrolling area, as the rest of the page is

#### Scenario: Menu opened

- **WHEN** the menu or a sheet drawn by the app covers the pet's place
- **THEN** the pet is hidden until its place shows again
