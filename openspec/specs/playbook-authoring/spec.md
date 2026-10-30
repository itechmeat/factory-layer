# playbook-authoring Specification

## Purpose
The factory improving its own hands: the brain proposes a new APB playbook
for a repeating kind of work, APB validates and trials it, and the brain
approves it, journaled, with no human approval.

## Requirements

### Requirement: Authoring flow

`factory author <task-kind>` SHALL ask the Architect for a playbook draft,
set its `id` to one unique to the authoring run and draft attempt, check
that every node uses the `claude` profile, create it in APB, validate it,
trial it, ask the Critic to review, and approve it in APB only when the
validation and trial passed and the review approves.

#### Scenario: Approved by the brain

- **WHEN** the draft validates, the trial succeeds and the Critic approves
- **THEN** the playbook is approved in APB under its assigned id and no human was asked

#### Scenario: Review approves a failed trial

- **WHEN** the trial fails and the Critic answers approve
- **THEN** the playbook is not approved and the flow ends `rejected`

### Requirement: One correction

A draft that cannot be parsed, names another profile, is refused by APB's
create or fails its validation SHALL be sent back to the Architect once
with the issues, under a new id; a second failure SHALL end the flow
`rejected`. No draft answer SHALL end the flow `none`.

#### Scenario: Corrected draft

- **WHEN** the first draft fails validation and the corrected draft validates
- **THEN** the corrected draft is trialled under its own id and the first stays unapproved

### Requirement: Bounded trial

The trial SHALL be bounded (15 minutes) and the flow (30 minutes). On a
trial timeout or either deadline the factory SHALL find the trial's APB run,
stop it with a bounded confirmation, trace its run id, and end `failed`.

#### Scenario: Trial call times out

- **WHEN** the trial call times out while APB's trial run is still running
- **THEN** that run is stopped and confirmed, and the flow ends `failed` naming the run id

### Requirement: Journaled authoring

Every step (draft, create, validation, profile check, trial, trial stop,
review, approval) SHALL be traced with its outcome in the authoring run's
own trace, and its report SHALL list the steps and the review's reasons.

#### Scenario: Report of an approved playbook

- **WHEN** an authoring run ends `approved`
- **THEN** its report lists each step in order, the playbook id and the review's reasons
