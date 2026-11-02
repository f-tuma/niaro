## ADDED Requirements

### Requirement: Named voices

The owner SHALL be able to name each diarized voice of a ready meeting, or mark one voice as their own. A named voice SHALL read by its name, and the owner's voice as "Me", everywhere in that meeting: transcript, summary, points, decisions, tasks and their owners, open questions, copies and the assistant's meeting tools, including Czech case forms of "Mluvčí N" in the notes. Naming SHALL NOT change the stored transcript or record.

#### Scenario: Naming a voice

- **WHEN** the owner names "Speaker 2" "Jana Nováková"
- **THEN** every turn of voice 2 and every mention of "Speaker 2" or "mluvčího 2" in the notes reads "Jana Nováková", and "Speaker 12" stays

#### Scenario: Marking the owner's voice

- **WHEN** the owner marks voice 3 as their own and later marks voice 1
- **THEN** voice 1 reads "Me" and voice 3 reads "Speaker 3" again

### Requirement: Remembered own voice

Only on the owner's explicit choice together with "This is me", the server SHALL keep one fingerprint of the owner's voice, made by the diarizer from up to 90 seconds of that voice's turns, for that owner only, and SHALL refuse fewer than 10 seconds of speech. The owner SHALL see since when it is kept and be able to delete it.

#### Scenario: Too little speech

- **WHEN** the owner asks to remember a voice that speaks for 6 seconds
- **THEN** nothing is kept and the owner is told the voice speaks too little

#### Scenario: Forgetting

- **WHEN** the owner chooses "Forget my voice"
- **THEN** the fingerprint is deleted and later meetings label no voice "Me" by sound

### Requirement: Recognizing the owner's voice

Diarizing a later single-track meeting of an owner with a kept fingerprint SHALL compare each voice with it in memory and label as "Me" the voice that reaches cosine similarity 0.75 and leads the next voice by 0.15. Other voices' fingerprints SHALL NOT be stored.

#### Scenario: Recognized in the next meeting

- **WHEN** the owner kept their fingerprint and records another single-track meeting where they speak
- **THEN** their turns read "Me" and the other voices are numbered from 1 without a gap

#### Scenario: Not clearly the owner

- **WHEN** no voice is similar enough, or two voices are nearly equally similar
- **THEN** no voice is labelled "Me"

### Requirement: Voices within long turns

When a transcribed turn is longer than its diarized voices, the server SHALL split it at sentences, time each sentence by its place in the turn's text, give each sentence the voice that spoke most of its time and join neighbours with the same voice, without exceeding the record's turn limit.

#### Scenario: A minute-long turn with two speakers

- **WHEN** a 40-second turn of three sentences spans voice 1, then 2, then 1
- **THEN** it becomes three turns with voices 1, 2 and 1 and the same text in order
