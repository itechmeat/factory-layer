# Spec Delta

## Purpose

The factory's main acceptance test: a practice spec run end to end with the
real brain, hands and memory, and the delivered package verified
independently of the factory.

## ADDED Requirements

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
