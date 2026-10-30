# platform-support Specification

## Purpose
Where the factory runs: development on Linux, the live demo and possibly
the hidden run on macOS (Apple Silicon), with the same commands and
results on both.

## Requirements

### Requirement: Linux and macOS

`factory doctor`, `factory run`, the end-to-end run and the hidden-run
script SHALL work on Linux and on macOS without Linux-only tools or paths:
no `/proc`, no GNU-only flags of system tools, no bash 4 features in shell
strings, temporary files under the system temporary directory, and child
process groups handled through Node's process APIs.

#### Scenario: Doctor on a Mac

- **WHEN** `factory doctor` runs on a Mac with APB, OSB, Claude Code and Bun installed
- **THEN** every check passes or names the missing piece, and no check fails because of the platform

#### Scenario: Hidden-run dry run on a Mac

- **WHEN** the hidden-run script runs on a Mac with two practice specs
- **THEN** both factory processes deliver, the build in place and the startup check run, and the table is printed

### Requirement: Node-only tool directory

The Node-only environment SHALL use as `PATH` one directory of links to
`node`, `npm`, `npx`, `git`, `sh`, `bash`, `env` and the core utilities a
package script calls, resolved from the factory's `PATH`, and never to
`bun` or `bunx`, so Node stays available when Bun sits in the same
directory.

#### Scenario: Node package with Bun alongside

- **WHEN** `node`, `npm` and `bun` are in the same directory and a package's start script is `node server.js`
- **THEN** the server starts in the Node-only environment

#### Scenario: Bun-only package with Bun alongside

- **WHEN** `node`, `npm` and `bun` are in the same directory and a package's start script is `bun server.js`
- **THEN** the start fails because `bun` is not found
