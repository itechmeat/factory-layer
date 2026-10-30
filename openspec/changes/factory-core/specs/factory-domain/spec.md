# Spec Delta

## Purpose

The factory's data model: what a spec, a plan, a task, a verdict, a recovery
choice, a trace event and usage are, how they are validated at boundaries,
and the pure rules that decide plan validity, task readiness and budgets.

## ADDED Requirements

### Requirement: Validated values

Every domain value that crosses a boundary (brain output, disk, executor
results) SHALL have a Zod schema, and its TypeScript type SHALL be inferred
from that schema. Parsing invalid input SHALL yield an error that names the
offending path.

#### Scenario: Invalid plan from outside

- **WHEN** a plan whose task lacks an id is parsed
- **THEN** parsing fails with an error naming the path of the missing field

### Requirement: Spec

A spec SHALL carry its name (a slug usable as a directory name), the full
Markdown text, and the source file name. The name SHALL be derived from the
file name when not given.

#### Scenario: Name from file

- **WHEN** a spec is created from `todo-cli.md` without an explicit name
- **THEN** its name is `todo-cli`

### Requirement: Acceptance checks

An acceptance check SHALL be a CLI check, an HTTP check or a command check,
and SHALL have an id, a description tied to a statement of the spec, and a
timeout (default 30 s).

#### Scenario: Missing timeout

- **WHEN** a check without a timeout is parsed
- **THEN** it gets the default of 30 s

### Requirement: Check kinds

A CLI check SHALL hold arguments, optional stdin, the expected exit code and
expected stdout and stderr (exact text, substring or regular expression). An
HTTP check SHALL hold method, path, optional headers and body, the expected
status and the expected body (exact JSON, JSON subset or substring). A
command check SHALL hold a shell command and the expected exit code.

#### Scenario: CLI check round trip

- **WHEN** a CLI check is serialized and parsed again
- **THEN** the parsed value equals the original

### Requirement: Plan validity

A plan SHALL be a set of tasks, each with an id, a revision, a title, a
description, the playbook it runs, the paths it owns, and the ids it depends
on. A plan SHALL be rejected as invalid, with every reason listed, when task
ids repeat, a dependency names an unknown task, or the dependencies form a
cycle.

#### Scenario: Unknown dependency

- **WHEN** a task depends on an id that no task has
- **THEN** the plan is invalid with a reason naming the task and the unknown id

### Requirement: Owned paths

Two tasks that may run at the same time (neither depends on the other,
directly or transitively) SHALL NOT own overlapping paths; a plan where they
do is invalid. Two paths overlap when they are equal or one is an ancestor
directory of the other.

#### Scenario: Cycle

- **WHEN** task A depends on B and B depends on A
- **THEN** the plan is invalid with a cycle reason naming both tasks

#### Scenario: Parallel tasks share a directory

- **WHEN** independent tasks own `src/` and `src/cli.ts`
- **THEN** the plan is invalid with an overlap reason naming both tasks and both paths

#### Scenario: Sequential tasks share a path

- **WHEN** task B depends on task A and both own `src/index.ts`
- **THEN** the plan is valid

### Requirement: Secret redaction

The domain SHALL provide one redaction function that replaces each given
secret value with `[redacted]` in a string or in every string of a JSON
value. Every adapter and the application SHALL apply it with the run's
secret set (credentials and executor supervision tokens) before an error,
trace event, report or stored output text leaves the process.

#### Scenario: Nested secret

- **WHEN** a JSON value has a secret inside a nested string
- **THEN** the redacted value has `[redacted]` in its place and nothing else changes

### Requirement: Task lifecycle

A task SHALL be in exactly one state: `pending`, `ready`, `running`,
`judging`, `recovering`, `accepted`, `integrating`, `integrated` or
`failed`. Only the transitions of the orchestration capability are allowed;
any other transition SHALL be rejected as a programming error. A task is
ready when every task it depends on is `integrated`.

#### Scenario: Readiness

- **WHEN** task B depends on A and A becomes `integrated`
- **THEN** B is ready

#### Scenario: Illegal transition

- **WHEN** a transition from `pending` to `accepted` is requested
- **THEN** it is rejected with an error naming both states

### Requirement: Decisions

A verdict SHALL be `accept` or `reject` with reasons and the ids of the
failed acceptance checks. A recovery choice SHALL be one of: `retry` with a
hint, `rebind` to another profile with a hint, `repair` with the failing
checks, `replan`, or `give_up` with a reason.

#### Scenario: Retry carries a hint

- **WHEN** a `retry` choice without a hint is parsed
- **THEN** parsing fails

### Requirement: Budgets

A task SHALL have an attempt budget (default 3: the first attempt plus two
recoveries); a run SHALL have one runtime re-plan, separate from the single
correction of an invalid first plan. Budget and limit values SHALL be
exported constants with their units in the name, overridable per run through
validated run options.

#### Scenario: Budget spent

- **WHEN** a task's third attempt is rejected
- **THEN** the budget rule says the task has no recovery left and reports whether the run's re-plan is still available

### Requirement: Topological order

The domain SHALL provide a stable topological order of a valid plan:
dependencies before dependants, plan order as the tie-breaker.

#### Scenario: Reversed listing

- **WHEN** a plan lists B (depends on A) before A
- **THEN** the order is A, B

### Requirement: Usage and cost

Usage SHALL be `measured` (input and output tokens), `estimated` (tokens and
the basis of the estimate) or `unavailable` (with a reason). Cost SHALL be
computed only from measured or estimated usage and a price for the model,
and SHALL be `unavailable` when either is missing. Aggregating usages SHALL
never turn an unavailable part into zero: the total states how many parts
were unavailable.

#### Scenario: Unknown usage stays unknown

- **WHEN** an unavailable usage is priced
- **THEN** the cost is unavailable with the usage's reason

### Requirement: Usage records

Every brain call attempt (failed retries included) SHALL produce one usage
record, and a failed decision SHALL carry the records already incurred.
Every executor node attempt SHALL produce one record, collected once from
the run's final report (never summed from events), unavailable when the
attempt reported none. A record holds its source, correlation ids, the
actual provider and model when known, the usage and the cost.

#### Scenario: Failed retry recorded

- **WHEN** a brain decision fails once and then succeeds
- **THEN** two usage records exist for it, the first unavailable when the failure returned no usage

#### Scenario: Unknown price

- **WHEN** a measured usage is priced for a model without a price
- **THEN** the cost is unavailable

#### Scenario: Mixed aggregate

- **WHEN** one measured and one unavailable usage are aggregated
- **THEN** the total carries the measured tokens and states one unavailable part
