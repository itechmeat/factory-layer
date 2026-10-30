# Spec Delta

## ADDED Requirements

### Requirement: HTTP practice spec

The repository SHALL ship a practice spec for a small HTTP API with its
routes, bodies, status codes and error cases, a server that listens on
`PORT` when started with `npm start` under Node, and request examples in
one fixed block format.

#### Scenario: HTTP delivery verified

- **WHEN** the end-to-end run is started on the HTTP practice spec
- **THEN** the delivered server, started with `npm start` under Node without `bun` on the `PATH`, answers the spec's request examples, and no server process remains

### Requirement: Demo spec with parallel tasks

The repository SHALL ship one small CLI spec with two independent commands
after a shared skeleton, used both as the parallel-tasks proof and as the
live demo: the factory delivers it in under 10 minutes on this machine and
its report shows at least two overlapping executor runs.

#### Scenario: Demo rehearsal

- **WHEN** the end-to-end run is started on the demo spec
- **THEN** it passes within 10 minutes and the report lists an overlapping pair of executor runs

### Requirement: Forced-cutoff smoke

A smoke SHALL run the factory on the demo spec with a cutoff a few minutes
after the start, while tasks are still running, and pass only when the
live runs were stopped and the output directory holds the integrated
`main`.

#### Scenario: Cutoff during task runs

- **WHEN** the cutoff passes while two task runs are live
- **THEN** both are stopped and the output directory holds the integrated `main`

### Requirement: Verification builds before tests

The end-to-end verification SHALL, for each runtime and from a clean copy,
install, run the build script when one exists, and only then run the tests;
a failing build SHALL fail that runtime.

#### Scenario: Build broken, tests green

- **WHEN** the delivered tests pass but the build script fails
- **THEN** the verification fails that runtime naming the build step

### Requirement: Gateway readiness

The brain SHALL be proven on the JigJoy gateway: one decision with a tool
call answered by `claude-sonnet-4-6` through the gateway, and the Mac demo
run with the gateway configured, each recording the provider and model its
usage records name; a success on the fallback provider SHALL NOT count.

#### Scenario: Fallback used

- **WHEN** the Mac demo run succeeds but its decisions were answered by Z.ai
- **THEN** gateway readiness is not met and the cause is recorded
