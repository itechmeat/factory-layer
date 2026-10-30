# Spec Delta

## ADDED Requirements

### Requirement: Active cutoff

When the cutoff passes, the run SHALL stop waiting for its task runners at
once: pending decisions are cancelled, every live executor run is stopped
with a bounded confirmation (default 60 s; an unconfirmed stop is traced as
abandoned), and delivery starts, even while tasks are still emitting
events.

#### Scenario: Task still active at the cutoff

- **WHEN** the cutoff passes while a task run keeps emitting events
- **THEN** that run is stopped within 60 s, no new work starts, and delivery begins without waiting for the task

### Requirement: Delivery copy before verification

When `deliverUnverified` is set, delivery SHALL copy the integrated `main`
to the output directory without `.git` and `node_modules` before any
verification step, so a process killed during verification still leaves
it; the verification result is then recorded in the outcome.

#### Scenario: Process killed during verification

- **WHEN** `deliverUnverified` is set and the process is killed while the delivery tests run
- **THEN** the output directory already holds the integrated `main`

### Requirement: Rebind limited to the claude profile

A recovery that chooses a rebind to a profile other than `claude` SHALL
NOT be posted; it SHALL become a repair with the same hint, and the trace
SHALL record the refused profile.

#### Scenario: Critic asks for another agent

- **WHEN** the Critic chooses rebind to `codex`
- **THEN** no rebind is posted, the trace records `codex` as refused, and a repair run with the hint starts
