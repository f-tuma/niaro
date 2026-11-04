## ADDED Requirements

### Requirement: Meeting search finds word forms

Meeting search SHALL first match the exact phrase, then meetings whose name, summary or one transcript passage holds every query word by its stem: case and accents folded, stop words dropped, a word of five or more letters reduced to its first five. Exact phrase matches SHALL come first.

#### Scenario: Another case of the word

- **WHEN** a person searches meetings for "zakázka" and a transcript says "zakázky"
- **THEN** that meeting is found

#### Scenario: Without accents

- **WHEN** a person searches for "rozpoctu" and the summary says "rozpočet"
- **THEN** that meeting is found
