# factory-cli Specification

## Purpose
The `factory` command line: the composition root that picks the adapters,
and the commands an operator uses to run the factory and read its results.

## Requirements

### Requirement: Run command

`factory run <spec.md> [--out <dir>] [--runtimes bun,npm] [--deliver-unverified]`
SHALL read and validate the spec file, wire the real adapters, run the
factory and print one line per notable event (decision start and end, task
state changes, recoveries, delivery) with the time, then print the outcome,
the output directory and the run id, and write the run's report. The default
output is `out/<spec name>/`.

#### Scenario: Successful run

- **WHEN** `factory run` finishes with outcome `succeeded`
- **THEN** it prints the outcome, the output directory and the run id, and exits 0

### Requirement: Exit codes

Every `factory` command SHALL exit 0 on success; `run` SHALL exit 3 for
`partial` and 1 for `failed`; a wrong command line SHALL print the usage and
exit 2.

#### Scenario: Partial run

- **WHEN** `factory run` finishes with outcome `partial`
- **THEN** it exits 3

### Requirement: Clean shutdown

On the first SIGINT or SIGTERM the run SHALL take the cutoff path at once
(stop live executor runs, then deliver what is integrated) and exit with the
outcome's code; a second signal SHALL exit at once with code 130 (the run
state is already saved on every change).

#### Scenario: Interrupted run

- **WHEN** the operator presses Ctrl-C during a run
- **THEN** live executor runs are stopped, the integrated state is delivered, and the command exits with the outcome's code

### Requirement: Report and intervention commands

`factory report <run-id>` SHALL print the Markdown report of a run and write
it to `runs/<run-id>/report.md`. `factory intervene <run-id> "<note>"`
SHALL record a human intervention for that run. Both SHALL refuse a run id
that has no trace.

#### Scenario: Intervention recorded

- **WHEN** `factory intervene R "restarted the agent CLI"` is run
- **THEN** run R's trace and report contain that note with its time

### Requirement: Doctor command

`factory doctor` SHALL run each check within its own deadline, print one
line per check and exit non-zero when any check fails. The checks: the
brain configuration and one function call (naming the provider and model
that answered), Mozaik Cloud (off, on or refused), `apb` with its version
and an MCP handshake, Claude Code installed and logged in, the approval of
the four starter playbooks, the OSB vault handshake, and `git`, `bun` and
`npm` on the PATH.

#### Scenario: Unapproved playbook

- **WHEN** a factory playbook is not approved
- **THEN** doctor reports that check as failed with the bootstrap command to fix it, and exits non-zero

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
