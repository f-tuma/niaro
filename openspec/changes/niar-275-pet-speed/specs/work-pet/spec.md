# Spec Delta

## ADDED Requirements

### Requirement: Pet start

A pet view SHALL show the pet as soon as it opens. Where a still image of the same pet's first frame is available it SHALL stand in until the animation draws, changing to it with no more than a short cross-fade. Preparing the animation SHALL NOT hold the rest of the app.

#### Scenario: Pet seen before

- **WHEN** a pet view opens with a look, card and size the device has drawn before
- **THEN** the pet is visible at once and the animation takes over without a jump

#### Scenario: Compiling

- **WHEN** a pet's animation is still being prepared
- **THEN** the person can scroll and type without the app pausing

### Requirement: Pet continuity

A pet whose view is rebuilt in the same place (returning to a screen, the keyboard, a nested profile screen) SHALL continue its motion rather than start again. Two pets on screen at once SHALL NOT share one motion. A change of a pet's displayed size SHALL NOT restart it.

#### Scenario: Returning to Home

- **WHEN** the person returns to the chat tab after the pet was shown there before
- **THEN** the pet continues its breathing and sleep where it was

#### Scenario: Keyboard

- **WHEN** the person opens or closes the keyboard on Home
- **THEN** the same pet shrinks above the keyboard or grows back, without disappearing or restarting

#### Scenario: Appearance preview

- **WHEN** the appearance sheet is open over the profile
- **THEN** its preview pet moves independently of the profile pet
