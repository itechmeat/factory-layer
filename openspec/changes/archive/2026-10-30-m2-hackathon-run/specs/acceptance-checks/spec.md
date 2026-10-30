# Spec Delta

## ADDED Requirements

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
