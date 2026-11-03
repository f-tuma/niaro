# Spec Delta

## ADDED Requirements

### Requirement: Where Niaro reads on the phone

The phone's **Where Niaro reads** SHALL show the last known service list (see `chat` "Phone list cache") until the server answers and when a read fails, and SHALL NOT read the list again within two minutes of the last answer in the same session.

#### Scenario: Settings opened twice

- **WHEN** the person opens Settings twice within a minute
- **THEN** the service list is read from the server once and shown both times
