# hidden-run Specification

## Purpose
One rehearsed command from the published hidden specs to packages in
`hidden/<spec name>/` that the owner can commit and push at the submission checkpoint.

## Requirements

### Requirement: One factory process per spec

`bun run hidden <spec.md>...` SHALL start one `factory run` per spec at the
same time, each under a spec name unique to this invocation (so it starts
from a fresh work repository), with `--out hidden/<spec name>`, the cutoff
(default 19:15), `--task-concurrency 2` and `--deliver-unverified`.

#### Scenario: Two hidden specs

- **WHEN** the script is started with `todo-api.md` and `csv-tool.md`
- **THEN** two factory processes run at once and deliver into `hidden/todo-api/` and `hidden/csv-tool/`

### Requirement: Hard deadline

A factory process still running at the hard deadline (default 19:22) SHALL
get a signal and be killed 30 s later. The steps after the runs (ignore
file, build in place, checks) SHALL end by the report time (default
19:26), with unfinished steps marked, and the table SHALL then be printed.

#### Scenario: Factory hangs after the cutoff

- **WHEN** a factory process is still verifying at 19:22
- **THEN** it is ended, its provisional delivery stays in `hidden/<spec name>/`, and the table is printed by the report time

### Requirement: Committable build output

The factory's ignore rules SHALL re-include `hidden/**` except
`node_modules/`, the script SHALL replace each delivery's `.gitignore` with
one line `node_modules/`, and SHALL build each delivery in a copy and put
the built files (without `node_modules`) back into `hidden/<spec name>/`.

#### Scenario: Built files committable

- **WHEN** a delivery's build writes `dist/cli.js` and `dist/commands.js`
- **THEN** both are in `hidden/<spec name>/` and git does not ignore them

### Requirement: Startup check and table

The script SHALL copy exactly the files git would commit for each
`hidden/<spec name>/`, install with lifecycle scripts disabled, run each
`bin` under `node` and, for an HTTP package, `npm start` until it accepts a
connection, without `bun` on the `PATH`; and print one row per spec.

#### Scenario: Missing built import

- **WHEN** `npm start` runs `node dist/server.js`, which imports a file missing from the committable files
- **THEN** that spec's row reads startup failed with the error

### Requirement: No git changes

The script SHALL run no git command that changes the repository or a
remote, and SHALL end with the owner's steps: review the table, stage
`hidden/`, commit, push, and check the remote commit.

#### Scenario: Script ends

- **WHEN** the script exits
- **THEN** the steps are printed and the repository's git state is unchanged
