# apb-executor Specification

## Purpose
The `Executor` and `PlaybookAuthoring` ports over APB's MCP surface, as APB
1.0.0-beta.1 actually answers: supervised runs in task trees, bounded event
waits, recovery commands, confirmed stops, usage per attempt, and playbook
authoring.

## Requirements

### Requirement: Supervised start in a task tree

Starting a run SHALL call `playbook_run` with the playbook id, the absolute
task tree as `worktree`, `supervise: "self"` and the inputs as string
`params`. The task text SHALL be written to `.factory/task.md` inside the
tree (excluded from commits by the workspace) and passed as `task_file`;
`owned_paths`, `failing_checks` and `conflict_paths` SHALL be passed one
item per line; a start that does not supply every param the playbook
declares SHALL be refused before calling APB.

#### Scenario: Missing param

- **WHEN** a start of a playbook declaring a param the inputs do not carry is asked
- **THEN** the start is refused before APB is called, naming the param

### Requirement: Hint-only repair

A repair with no failing check (a hint-only follow-up of a run no check
has judged) SHALL pass `failing_checks` as one line saying no check has
failed and pointing at the task file, so the start is not refused.

#### Scenario: Hint-only repair

- **WHEN** a `repair` start carries a hint but no failing checks
- **THEN** the start reaches APB with `failing_checks` naming no failed check and pointing at the task file

### Requirement: Start outcomes

The supervisor token SHALL be kept only in memory and in the run state,
registered as a secret, and never traced. A start refused by APB policy
SHALL be a typed refusal naming the policy; a start whose answer is lost
SHALL be a typed indeterminate failure.

#### Scenario: Untrusted playbook

- **WHEN** APB refuses a start with a policy refusal
- **THEN** the start fails with a typed refusal naming the policy and no run is followed

### Requirement: Event waits

Waiting SHALL call `supervisor_wait_event` with the run's token and the last
cursor and a server wait shorter than the MCP request timeout. A missing
next cursor SHALL keep the previous one.

#### Scenario: Null cursor

- **WHEN** APB answers a wait with no next cursor
- **THEN** the next wait uses the previous cursor

### Requirement: Event mapping

APB's answers SHALL map to the port's events: `node_failed` and
`node_timeout` wakes to a node failure; `anomaly`, a non-terminal end, a
review or a question to a stall; a host task to `needs_host`; a terminal
status to `terminal` (a run that ended `aborted` after the factory stopped
it is reported `stopped`); nothing within the slice to `quiet`.

#### Scenario: Node timeout

- **WHEN** APB wakes the supervisor with a `node_timeout` for node `implement`
- **THEN** the event is a node failure of `implement` with the reason timeout

### Requirement: Parked runs

After a node failure wake, APB parks a supervised run until a directive
arrives and reports a pending supervisor decision; while the wake has been
delivered, that state SHALL map to `quiet`, not to a stall. On attach after
a restart, a parked run without a delivered wake SHALL be reported again as
the node failure it waits on.

#### Scenario: Wait after a node failure

- **WHEN** the wait after a delivered `node_failed` wake finds the run parked for the supervisor
- **THEN** the event is `quiet`

### Requirement: Lost APB connection

When the `apb mcp` connection dies, the executor SHALL start a new one once,
re-attach every known run by its token and continue; if that fails, the
calls fail with a typed lost-connection error.

#### Scenario: Server restarted

- **WHEN** `apb mcp` exits while two runs are followed
- **THEN** a new connection is made, both runs are re-attached and their waits continue from their cursors

### Requirement: Recovery commands

Context append, node retry and profile rebind SHALL return the posted
sequence as an accepted command, never as an applied one.

#### Scenario: Retry posted

- **WHEN** a node retry is posted
- **THEN** the result carries the posted sequence and the run is still followed by events

### Requirement: Confirmed stop

Stopping SHALL call `run_stop`, then poll `run_status` until the run is
terminal and its driver is not alive, within the stop deadline; otherwise it
reports `unconfirmed`, with a lost connection named as such.

#### Scenario: Stop of a live run

- **WHEN** a live run is stopped and APB answers `signaled_live_driver`
- **THEN** the stop is reported `stopped` only after `run_status` shows a terminal run whose driver is not alive

### Requirement: Usage per attempt

The run report SHALL give one usage record per node attempt, joined from the
`attempt_finished` events (tokens, cost when reported) and the report's
attempt models (falling back to the profile's expected model, marked as
such); attempts without usage are recorded unavailable.

#### Scenario: Attempt without usage

- **WHEN** an attempt finished without reporting usage
- **THEN** its record is unavailable with the reason stated, and the run's other records are unaffected

### Requirement: Run lookup

Finding runs SHALL list the project's runs, keep those of the given playbook
started at or after the given time, and read each candidate's worktree from
`run_status`, returning the matches.

#### Scenario: Decoys ignored

- **WHEN** older runs and runs of other playbooks or trees exist
- **THEN** only the run of that playbook in that tree started after the time is returned

### Requirement: Contract tests

The adapter SHALL be tested against recorded APB 1.0.0-beta.1 answers for
every tool it calls, so a changed answer shape fails a test instead of a run.

#### Scenario: Changed shape

- **WHEN** a recorded answer is altered to drop a field the adapter reads
- **THEN** a contract test fails with a validation error naming the tool

### Requirement: Trial run stop

Playbook authoring over `apb mcp` SHALL find the runs of a playbook
started at or after a given instant and stop each with a bounded
confirmation (60 s), reporting every run as stopped or unconfirmed.

#### Scenario: Trial left running

- **WHEN** a trial call timed out and its run is still live in APB
- **THEN** the run is found by its playbook and start time, stopped and confirmed, and the result names its run id
