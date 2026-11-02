## ADDED Requirements

### Requirement: Canvas layout

A draft and each frozen version SHALL be able to carry a canvas layout: step positions and at most 20 notes of at most 280 characters, stored beside the definition. Freezing a new version SHALL copy the draft's layout to it, and a version's layout SHALL never change. Registry reads SHALL return `layout` beside the draft and the version. Saving a draft without a layout SHALL keep the draft's layout; positions of steps the definition lacks SHALL be dropped.

#### Scenario: A version keeps its arrangement

- **WHEN** a changed draft with a layout is frozen as version 2 and the draft's arrangement changes later
- **THEN** version 2 is read with the layout it was frozen with

### Requirement: Layout outside every digest

The layout MUST NOT be part of the definition, the immutable version artifact, the artifact digest, version reuse on freeze, or the comparison of the draft with a version.

#### Scenario: Move a step of an active process

- **WHEN** an owner moves a step of an active process's draft and saves only that arrangement
- **THEN** the draft's definition still equals the active version, freezing returns the same version with the same digest, and the process does not need a new test
