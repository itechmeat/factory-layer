# Spec Delta

## Purpose

The `factory` command line: the composition root that picks the adapters,
and the commands an operator uses to run the factory and read its results.

## ADDED Requirements

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

`factory doctor` SHALL check, each within its own deadline, and print one
line per check: the brain configuration and one function call, the absence
of a Mozaik cloud key, `apb` on the PATH with its version and an MCP
handshake, Claude Code (the agent of the default `claude` profile) installed
and logged in, the approval of the four starter playbooks in APB's trust
list, the factory OSB vault handshake, and `git`, `bun` and `npm` on the
PATH. It
SHALL exit non-zero when any check fails.

#### Scenario: Unapproved playbook

- **WHEN** a factory playbook is not approved
- **THEN** doctor reports that check as failed with the bootstrap command to fix it, and exits non-zero
