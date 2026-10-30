# Spec Delta

## Purpose

What a run leaves behind: an append-only trace of everything that happened,
a persisted run state for restart, and a report with time and cost per task.

## ADDED Requirements

### Requirement: Trace events

Every event SHALL carry the time, the run id, and where they apply the spec
name, task id, revision, attempt, brain decision id and kind, executor run
id and node id.

#### Scenario: Correlated executor event

- **WHEN** an executor event of task `api` revision 2 is traced
- **THEN** the event carries the run id, the spec name, `api`, revision 2, the attempt and the executor run id

### Requirement: Traced facts

The trace SHALL record at least: run start and end with the outcome, plan
and acceptance results, plan rejections, each brain decision with its start,
end, outcome and usage, each executor run start, event and end, check
results, verdicts, recovery choices, merges and conflicts, delivery steps,
interventions, and failures of memory, brain and executor.

#### Scenario: Decision interval

- **WHEN** a brain decision runs from t1 to t2
- **THEN** the trace contains its start at t1 and its end at t2 with the same decision id

### Requirement: Safe trace

Every event SHALL be redacted before it is written. Executor supervision
tokens SHALL never appear in the trace or the report; they are kept only in
the run state.

#### Scenario: Sentinel secret

- **WHEN** an executor event text contains a configured secret
- **THEN** the written trace line contains `[redacted]` instead

### Requirement: JSONL trace file

The file trace SHALL append one JSON object per line to
`runs/<run-id>/trace.jsonl`, flushing each event before the call returns, and
SHALL be readable back into validated events; a line that does not parse
SHALL be reported with its line number, not skipped silently.

#### Scenario: Read back

- **WHEN** 100 events are appended and the file is read back
- **THEN** the 100 events come back in order and equal the originals

### Requirement: Run state

The run state SHALL be written to `runs/<run-id>/state.json` atomically (a
temporary file in the same directory, then a rename) with file mode 0600,
and SHALL hold everything a resume needs (see the orchestration
capability), including executor supervision tokens. Reading it back SHALL
validate it. A failed write SHALL be a typed storage error.

#### Scenario: Atomic write

- **WHEN** the state is written
- **THEN** the file has mode 0600 and no temporary file remains in the directory

### Requirement: Report

A Markdown report SHALL be generated from a trace alone. It SHALL contain:
the run outcome and wall time; one row per task with its final state,
attempts, wall time, the actual models, tokens and cost from the usage
records (with unavailable values shown as unavailable, never as zero); the
brain usage per decision kind; the totals; the brain decision intervals
with the overlapping pairs; the recoveries; the failed checks; and the
intervention log, stating explicitly when it is empty.

#### Scenario: Empty intervention log

- **WHEN** a report is generated for a run without interventions
- **THEN** the report states that no human intervention was recorded

#### Scenario: Unknown cost

- **WHEN** a task's usage is unavailable
- **THEN** its cost cell reads unavailable and the total states the number of unavailable parts
