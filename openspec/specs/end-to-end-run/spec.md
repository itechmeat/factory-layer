# end-to-end-run Specification

## Purpose
The factory's main acceptance test: a practice spec run end to end with the
real brain, hands and memory, and the delivered package verified
independently of the factory.

## Requirements

### Requirement: Practice spec

The repository SHALL ship a practice spec under `examples/specs/` for a
small command-line tool, written in the style of a one-page product spec:
purpose, commands with arguments, output formats, exit codes, error cases
and examples. It SHALL state the command name and that the package's `bin`
runs under Node (compiled JavaScript or a Node shebang), so the delivered
CLI works under both runtimes.

#### Scenario: Spec is self-contained

- **WHEN** the practice spec is read without other context
- **THEN** every command, output and exit code it requires is stated in it

### Requirement: Agent profiles

The project SHALL ship one APB profile per supported agent CLI (`claude`,
`codex`, `opencode`, `zcode`, `agy`, `grok`), named after the CLI, and the
starter playbooks SHALL default to the `claude` profile; the bootstrap
SHALL switch the starters to another profile on request.

#### Scenario: Another agent

- **WHEN** the bootstrap runs with `--agent codex`
- **THEN** the four starter playbooks are republished with the `codex` profile as default and approved

### Requirement: Factory playbooks approved

The four starter playbooks SHALL be approved once by explicit confirmation
after review (their prompts and effects), and the trust bootstrap SHALL
approve them on a fresh machine together with the profile and the smoke
playbooks.

#### Scenario: Bootstrap approves starters

- **WHEN** the bootstrap runs against an empty trust store
- **THEN** the profile, the smoke playbooks and the four starters are approved

### Requirement: End-to-end run command

`bun run e2e` (a script with its own absolute deadline, default 2 hours)
SHALL run `factory run` on the practice spec under a spec name unique to
that run (so earlier work repositories and trees are never reused) into a
fresh output directory. It is not part of the check tiers.

#### Scenario: Earlier runs ignored

- **WHEN** the end-to-end run starts after an earlier one on the same practice spec
- **THEN** it works in a new work repository and output directory

### Requirement: Independent verification

After the factory run, the end-to-end run SHALL, independently of the
factory, install the delivered package and run its tests under `bun` and
`npm` from a clean copy, and check a few spec examples against the
delivered CLI under Node. It SHALL report the outcome, the wall time and the
per-task time and cost, and pass only when the outcome is `succeeded` and
the delivered package passes.

#### Scenario: Delivered package verified

- **WHEN** the end-to-end run finishes
- **THEN** the delivered package's tests pass under both runtimes from a clean copy, the spec examples hold, and the report lists every task with its time and cost

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
