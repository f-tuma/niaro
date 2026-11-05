# Spec Delta

## MODIFIED Requirements

### Requirement: UI in later turns

The program SHALL stay in the model's history as the assistant's own text, so a follow-up can change it ("make it a pie chart"). It SHALL be withheld exactly when its answer is (see `agent-runtime`), and a fresh thread's earlier replies SHALL carry it with its answer when both fit.

#### Scenario: Change the chart

- **WHEN** the person asks to show the previous answer's bar chart as a pie chart and what that answer drew on is still current
- **THEN** the model sees its earlier program and writes a new complete program

#### Scenario: Withheld with its answer

- **WHEN** an answer with a program drew on a saved item the person then forgets
- **THEN** later turns see neither the answer nor its program
