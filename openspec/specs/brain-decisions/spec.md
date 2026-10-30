# brain-decisions Specification

## Purpose
The brain is a team of Mozaik agents that only decide. This capability
defines how each call of the `Brain` port becomes one bounded, typed and
attributable decision.

## Requirements

### Requirement: Roles in one runtime

The brain SHALL run three agents in one Mozaik runtime that uses the guarded
runner: the Architect (plan, plan correction, re-plan, playbook proposal),
the Acceptance analyst (acceptance checks) and the Critic (acceptance
review, verdict, recovery choice). The brain SHALL tag each of its usage records with the decision
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

### Requirement: Acceptance checks quote the spec

The Acceptance analyst SHALL be shown the checks already taken from the
spec's examples and SHALL add only checks beyond them. Its submit schema
SHALL require every check to quote in `source` the spec passage it derives
from: a quote that is not a verbatim passage of the spec (whitespace
aside), or an id reserved for example checks, is returned to the model as
a validation error naming the check.

#### Scenario: Paraphrased source

- **WHEN** the model submits a check whose `source` paraphrases the spec
- **THEN** the submission is answered with an error naming the check and the unquoted text, and the model may submit again

### Requirement: Critic reviews acceptance checks

The Critic's acceptance review SHALL treat the example checks as
authoritative and may object only to the candidate checks it was shown,
each objection with a reason. The Critic's verdict SHALL not count a failed
check against a task when it contradicts a passing example check.

#### Scenario: Objection to an unknown check

- **WHEN** the review names a check id it was not shown
- **THEN** the submission is refused back to the model with the candidate ids

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

### Requirement: Cloud telemetry only by opt-in

Without the opt-in `FACTORY_MOZAIK_CLOUD=1`, the brain SHALL refuse to start
when a Mozaik cloud key is present in the environment (`MOZAIK_API_KEY`,
`MOZAIK_PROJECT_KEY`, `MOZAIK_PROJECT_ID`), in the `.env` file of the
process directory (names only are read) or in the user's Mozaik credentials
file, naming where it was found and never printing the value, so prompts
and spec text never leave for a third party unasked.

#### Scenario: Key present without the opt-in

- **WHEN** `MOZAIK_API_KEY` is set and `FACTORY_MOZAIK_CLOUD` is not `1`
- **THEN** the brain refuses to start with an error naming `MOZAIK_API_KEY`

### Requirement: Cloud telemetry with the opt-in

With the opt-in, a configured key SHALL be allowed: Mozaik Cloud then
receives the loop events (spec text, task descriptions, redacted executor
reports) with the cloud client's redaction set to `content` unless the
operator chose `none` or `all`, and the live link Mozaik prints SHALL reach
the console, while its no-key warning stays filtered.

#### Scenario: Default redaction

- **WHEN** a key is set, `FACTORY_MOZAIK_CLOUD=1` and `MOZAIK_REDACTION` is not set
- **THEN** the loop events go to Mozaik Cloud with redaction `content`

#### Scenario: Key present with the opt-in

- **WHEN** `MOZAIK_API_KEY` is set and `FACTORY_MOZAIK_CLOUD=1`
- **THEN** the brain starts and `factory doctor` reports Mozaik Cloud as on, naming where the key was found

#### Scenario: No key

- **WHEN** no Mozaik cloud key is configured
- **THEN** the brain starts and `factory doctor` reports Mozaik Cloud as off
