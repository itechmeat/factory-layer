# acceptance-checks Specification

## Purpose
Running the black-box acceptance checks and the package commands (install,
build, tests) against a package directory, with bounded time and the output
kept for the critic and the report.

## Requirements

### Requirement: Bounded commands

Every command SHALL run in a given directory with a timeout. A command that
exceeds it SHALL be killed together with its child processes and reported as
timed out. The result SHALL carry the exit code, the elapsed time, and the
stdout and stderr, each redacted and truncated to a limit (default 64 KiB)
with the truncation stated. A command that cannot be spawned SHALL be a
typed spawn failure in the result, not an exception.

#### Scenario: Hanging command

- **WHEN** a command sleeps longer than its 1 s timeout
- **THEN** it is reported as timed out after about 1 s and no process of it remains

### Requirement: Package commands

The runner SHALL run install, the build script when present, and the test
script under each requested runtime (`bun`, `npm` or both), reporting a
result per runtime. A missing `test` script SHALL be a failed step, not a
pass.

#### Scenario: One runtime fails

- **WHEN** the tests pass under `bun` and fail under `npm`
- **THEN** the result reports `bun` passed and `npm` failed with its output

#### Scenario: Undeclared type library

- **WHEN** the package's `tsconfig.json` names the type library `node` in `compilerOptions.types` and its install leaves no `@types/node` in its own `node_modules`
- **THEN** the install step fails naming `node`, because the build would only pass through a parent directory's install

#### Scenario: Missing test script

- **WHEN** the package has no `test` script
- **THEN** the test step fails with a message saying the script is missing

### Requirement: CLI checks

A CLI check SHALL run the package's CLI entry (the `bin` of `package.json`,
else `main`) with the given arguments and stdin, and SHALL pass only when
the exit code, stdout and stderr match the expectations. A failure SHALL
state each mismatch with expected and actual values.

#### Scenario: Wrong exit code

- **WHEN** a CLI check expects exit code 2 and the CLI exits with 0
- **THEN** the check fails stating expected 2 and actual 0

### Requirement: Command checks

A command check SHALL run its shell command in the package directory with
the package's command names on the PATH, and SHALL pass only when the exit
code and, when given, the expected stdout and stderr match; a failure
states each mismatch with expected and actual values.

#### Scenario: Wrong stdout

- **WHEN** a command check expects stdout `out` and the command prints `other`
- **THEN** the check fails stating the expected and the actual stdout

### Requirement: HTTP checks

HTTP checks of a package SHALL start its server once per check batch with
the package's start script on a free port passed in `PORT`, wait for the
port to accept connections (bounded, default 15 s), run the requests, compare
status and body, and stop the server and its children afterwards whatever
the outcome.

#### Scenario: Server never starts

- **WHEN** the server does not listen within the start deadline
- **THEN** every HTTP check of the batch fails with a start-timeout reason and no server process remains

### Requirement: Check batch result

Running a set of checks SHALL return one result per check (passed, failed
with reasons, or errored) and SHALL never throw for a failing package.

#### Scenario: Mixed batch

- **WHEN** a batch has one passing and one failing check
- **THEN** both results are returned with their status and the batch call resolves

### Requirement: Checks run under Node

CLI checks SHALL run the package's CLI entry with `node`, and HTTP checks
SHALL start the server with `npm run start`; these and every `npm` package
step SHALL run in the allowlisted generated-code environment whose `PATH`
is the Node-only tool directory (no `bun` or `bunx`).

#### Scenario: Bun-only server

- **WHEN** the start script is `bun src/server.ts`
- **THEN** the start fails because `bun` is not on the `PATH`, and every HTTP check of the batch fails with a start reason

### Requirement: Build before tests

The package steps SHALL run the build script, when one exists, after the
install and before the tests under every required runtime; a failing build
SHALL fail that runtime without running its tests.

#### Scenario: Broken build

- **WHEN** the build script exits non-zero under `npm`
- **THEN** the `npm` steps report the build failure and no `npm` test step runs
