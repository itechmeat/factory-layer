# Spec Delta

## Purpose

The brain is a team of Mozaik agents that only decide. This capability
defines how each call of the `Brain` port becomes one bounded, typed and
attributable decision.

## ADDED Requirements

### Requirement: Roles in one runtime

The brain SHALL run three agents in one Mozaik runtime that uses the guarded
runner: the Architect (plan, plan correction, re-plan, playbook proposal),
the Acceptance analyst (acceptance checks) and the Critic (verdict, recovery
choice). The brain SHALL tag each of its usage records with the decision
kind, which names the role that made it (the domain usage record has no role
field); the core traces the decision intervals.

#### Scenario: Plan and acceptance overlap

- **WHEN** a plan and acceptance checks are requested at the same time
- **THEN** both decisions run as concurrent loops on their agents at the same time

### Requirement: Typed answer through a submit tool

Each decision attempt SHALL use a fresh model context bound to the guarded
runner and a per-attempt submit tool whose arguments are validated with the
domain schema of that decision. The attempt resolves with the first valid
submission; arguments that fail validation are returned to the model as an
error so it can correct them; the loop is stopped right after a valid
submission.

#### Scenario: Valid submission

- **WHEN** the model calls the submit tool with a valid plan
- **THEN** the attempt resolves with that plan and no further inference runs

#### Scenario: Invalid submission corrected

- **WHEN** the model first submits arguments that fail the schema and then valid ones
- **THEN** the first submission is answered with the validation error and the attempt resolves with the second

### Requirement: Bounded attempts

Each attempt SHALL be bounded by its deadline and by a step cap (default 12
inference steps). A loop that ends without a valid submission, exceeds the
step cap or passes the deadline SHALL fail the attempt with a typed error
(`no_submission`, `step_limit`, `timeout`), carrying the usage already
recorded on the attempt.

#### Scenario: Model never submits

- **WHEN** the model answers with plain text and the loop ends
- **THEN** the attempt fails with `no_submission` and its recorded usage

### Requirement: No unattributed failure

A runner or tool error inside a loop SHALL fail its own attempt at once,
not when its deadline passes, and SHALL never crash the process: the runner
records the error on the attempt it belongs to and settles that attempt,
and a process-level guard logs any rejection it cannot attribute instead of
exiting.

#### Scenario: Provider error inside a loop

- **WHEN** the provider fails during a loop
- **THEN** that attempt fails with the provider error well before its deadline and the process keeps running

### Requirement: Cancellation

An aborted signal passed with a decision SHALL cancel its attempt and
reject at once with a typed `cancelled` error that carries the usage so far
and is not retried.

#### Scenario: Re-plan cancels a pending verdict

- **WHEN** the signal of a pending judge decision is aborted
- **THEN** the decision rejects at once with `cancelled` and no further inference of that attempt runs

### Requirement: Usage of failed calls

Every model call that fails SHALL leave a usage record (unavailable, with
provider, model and reason), so totals never silently omit failed calls.

#### Scenario: Provider error recorded

- **WHEN** a call fails with a provider error
- **THEN** the decision's usage records include one unavailable record for that call

### Requirement: Plans the hands can run

The Architect's submit schema SHALL accept only the playbooks a plan may
name (`scaffold`, `implement-task`), SHALL NOT let the model set fields the
core owns (such as revisions), and the Architect's instructions SHALL
require a first `scaffold` task that owns the package manifest, the
TypeScript config and the test setup.

#### Scenario: Invented playbook

- **WHEN** the model submits a plan whose task names a playbook that is not allowed
- **THEN** the submission is rejected back to the model with the allowed names

### Requirement: No cloud telemetry

The brain SHALL refuse to start when a Mozaik cloud key is present in the
environment (`MOZAIK_API_KEY`, `MOZAIK_PROJECT_KEY`), in the `.env` file of
the process directory (names only are read) or in the user's Mozaik
credentials file, naming where it was found and never printing the value,
so prompts and spec text never leave for a third party.

#### Scenario: Key present

- **WHEN** `MOZAIK_API_KEY` is set
- **THEN** the brain refuses to start with an error naming `MOZAIK_API_KEY`
