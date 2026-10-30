# Spec Delta

## ADDED Requirements

### Requirement: Cutoff option

`factory run --cutoff <time>` SHALL set the run's absolute cutoff, given as
an ISO 8601 instant with a zone or as `HH:MM` local time today; a time
already in the past or an unparsable value SHALL be a usage error (exit 2).
The resolved cutoff SHALL be printed at start.

#### Scenario: Local time cutoff

- **WHEN** `factory run a.md --cutoff 19:15` is started at 18:05 local time
- **THEN** the run's cutoff is 19:15 local time today and it is printed at start

#### Scenario: Cutoff in the past

- **WHEN** `factory run a.md --cutoff 09:00` is started at 18:05 local time
- **THEN** it prints a usage error and exits 2 without starting a run

### Requirement: Task concurrency option

`factory run --task-concurrency <n>` SHALL set the run's limit of task runs
at the same time (a positive integer, default 3); any other value SHALL be
a usage error (exit 2).

#### Scenario: Two task runs per process

- **WHEN** `factory run a.md --task-concurrency 2` runs a plan with three independent ready tasks
- **THEN** at most two executor runs of that run are live at any time

### Requirement: Author command

`factory author <task-kind> [--example <file>]...` SHALL run the playbook
authoring flow, print each step and the result (`approved` with the
playbook id; `rejected`, `none` or `failed` with the reason), write the
authoring report, and exit 0 only when approved.

#### Scenario: Rejected draft

- **WHEN** the authoring flow ends `rejected`
- **THEN** the command prints the reason and exits 1
