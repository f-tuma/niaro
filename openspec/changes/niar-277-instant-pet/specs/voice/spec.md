# Spec Delta

## ADDED Requirements

### Requirement: Listening shown when capture starts

The phone app SHALL show that it is listening as soon as the microphone has started recording, and SHALL NOT wait for any picture, animation or pet to be ready before it does. Opening the recording SHALL NOT prepare an animation that holds the app while the microphone starts.

#### Scenario: Pet not yet animated

- **WHEN** the person taps the microphone and the pet's animation has not drawn yet
- **THEN** the recording says it is listening as soon as the microphone has started, with the pet's picture standing in
