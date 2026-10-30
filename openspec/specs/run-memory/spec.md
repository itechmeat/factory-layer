# run-memory Specification

## Purpose
The factory remembers the outcome of every run in its own OSB vault and
recalls similar past runs when it plans a new spec.

## Requirements

### Requirement: Remember a run

At the end of a run the memory SHALL write one note per run under
`factory/runs/` in the factory vault, with the spec name, the outcome, the
plan summary, per-task outcomes and attempts, failed checks and the
duration, built only from the run's persisted outcome, through a single
idempotent write keyed by the run id; repeating it SHALL NOT create a second
note, and a repeated key with different content SHALL be treated as already
remembered.

#### Scenario: Retry of remember

- **WHEN** the same run's outcome is remembered twice
- **THEN** one note exists and the second write is reported as a duplicate, not an error

### Requirement: Recall similar runs

Recall SHALL search the factory runs by the spec's text (cut to the
search's 2000-character limit) with any-term matching, de-duplicated by
note, return at most the requested number of past outcomes parsed from
the notes, and treat an unparsable note as skipped, not as a failure.

#### Scenario: Reworded spec

- **WHEN** a spec worded differently from an earlier one is recalled
- **THEN** the earlier run's outcome is among the results

### Requirement: Dedicated vault only

The memory SHALL run `o2b mcp` only with the factory's own config and vault
from the environment (`FACTORY_OSB_CONFIG`, `FACTORY_OSB_VAULT`) and SHALL
refuse to start without them.

#### Scenario: Vault not configured

- **WHEN** `FACTORY_OSB_VAULT` is not set
- **THEN** the memory refuses to start with an error naming the variable
