# Running the factory

The `factory` commands and their options, the trust model, and the
end-to-end run. Back to the [README](../../README.md).

## Commands

```bash
bun run factory doctor                         # check the setup before a run
bun run factory run examples/specs/wordfreq.md # build a package from a spec
bun run factory report <runId>                 # print the report of a run
bun run factory intervene <runId> "<note>"     # record a human intervention
bun run factory author readme --example examples/authoring/readme-example.md
```

## `factory doctor`

`factory doctor` checks, one line each, that the brain model answers
through its submit tool (naming the provider and model that answered),
whether Mozaik Cloud is off, on or refused (see
[Configuration](configuration.md)), that `apb mcp` answers and the starter
playbooks and the agent profile are approved at their current versions,
that the agent CLI is logged in, that `o2b mcp` answers on the factory
vault, and that git, Bun and npm are installed. It names what to fix for
every failed check.

## `factory run`

`factory run <spec.md>` takes:

| Option | Effect |
| --- | --- |
| `--out <dir>` | Where the package is delivered (default `out/<spec name>`) |
| `--runtimes bun,npm` | The runtimes the delivered package must pass under (default `bun`, the stack the factory builds with) |
| `--deliver-unverified` | Copy the integrated `main` to `--out` before any verification step, so a run cut off or killed during verification still leaves a package |
| `--cutoff <time>` | `HH:MM` local time today or an ISO 8601 instant with a zone; at that moment the live executor runs are stopped (each stop confirmed within 60 s), late results are discarded and delivery starts with what is integrated |
| `--task-concurrency <n>` | Task runs at once for this run (default 3; at most 4 executor runs at once across the process) |

It prints the run id, every task transition and decision, then the
outcome, the delivered directory and the path of the run's report. The
run's state, trace and report live under `runs/<runId>/`
(`trace.jsonl`, `report.md`); task trees live under `work/`.
`factory report <runId>` rebuilds the report from the trace alone. Exit
codes: 0 succeeded, 1 failed, 2 usage error, 3 partial. The first SIGINT or
SIGTERM takes the cutoff path; a second one exits at once with 130, since
the run state is saved on every change.

## `factory author`

`factory author <kind> --example <file>` has the brain draft a playbook for
a kind of task from one worked example, APB create, validate and trial it,
and the brain's Critic approve or reject it. The example must be a local
file outside `runs/`, `work/`, `out/` and `hidden/`. It prints the outcome
and the playbook id and writes `runs/<runId>/authoring-report.md`. Exit
codes: 0 approved, 3 none found, 1 rejected or failed, 2 usage error.

## Trust model

The factory runs code it did not write. The acceptance commands are written
by the brain model, and the package under test is written by the coding
agents; both run on this machine as the operator's user. What limits them:

1. Every install, build, test, acceptance check and HTTP server sees an
   allowlisted environment only (`PATH`, `LANG`, `CI=1`, `PORT` where
   needed and a scratch `HOME` that lives for one batch), never the
   factory's own environment, so no provider key reaches it.
2. Installs run with `--ignore-scripts`; the build is its own step.
3. The run state and trace stay owner-only (`runs/<runId>/` is 0700, its
   files 0600), and the run state never holds a provider key.

This is not a sandbox: the code can read and write whatever the user can,
including this repository. The task trees live under `work/` inside it
because APB requires the trees it works in to be inside its project.
Run the factory on a machine or account you are fine exposing to that.

## The end-to-end run

```bash
bun run e2e examples/specs/wordfreq.md --deadline-min 30
```

The end-to-end run is the factory's main acceptance test. It runs
`factory run` on the practice spec under a unique spec name, then verifies
the delivered package on its own: the package tests under Bun from a clean
copy, the build under npm from another (a test script that calls bun is
not run there), and every example of the spec under Node. It prints
the outcome, the wall time and the time and cost of every task, and passes
only when the outcome is `succeeded`, both runtimes pass and every example
holds. Every child process ends by the absolute deadline.

A recorded passing run of the `wordfreq` spec (three tasks after one
runtime re-plan, brain on GLM-5.3 Flash, coding agent Claude Code on
Sonnet 5.5):

| Task | Time | Cost |
| --- | --- | --- |
| `scaffold` | 25 s | $0.063 |
| `count-words` | 1 min 9 s | $0.065 |
| `cli-main` | 32 s | $0.096 |
| Whole run | 2 min 50 s | $0.227 |

The costs are the ones the agents reported plus the brain calls computed
from `config/prices.json`; the report of a run says which is which.
