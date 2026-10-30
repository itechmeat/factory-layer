# Proposal

## Why

The factory needs a core that turns a spec into delivered code by asking the
brain for decisions and the hands for work, while owning every state change,
deadline, budget and recovery itself. This core is independent of the
concrete brain, hands and memory: it is written and tested against ports
with fakes, so it can be built in parallel with the adapter smokes (change
`m0-adapter-smokes`) and wired to the real adapters in M1.

## What Changes

- The domain model with Zod schemas: spec, acceptance checks, plan (a DAG of
  tasks with owned paths), task state, verdicts, recovery choices, playbook
  references, interventions, trace events, usage and cost, run state; and
  the pure rules over them (plan validity, readiness, budgets).
- The ports the core depends on: `Brain`, `Executor`, `PlaybookAuthoring`,
  `Memory`, `TraceSink`, `RunStore`, `Workspace`, `CheckRunner`,
  `CostTable` (next to the existing `Clock`).
- The application: the factory state machine and the use cases
  `RunFactory`, `RecordIntervention` and `ReplayRun`, with concurrent
  planning and acceptance analysis, dispatch under concurrency caps,
  supervised waits with deadlines, judging, recovery within budgets,
  integration, verification, delivery, a delivery cutoff, and restart
  reconciliation.
- Adapters that need no external service: `trace-fs` (JSONL trace and atomic
  run state), `workspace-git` (a git repository per spec, a worktree per
  task, merges, clean delivery), `check-runner` (black-box acceptance checks
  for CLI and HTTP packages, and the package test commands) and
  `report-markdown` (the per-task time and cost report).

Out of scope: the real `Brain` (Mozaik), `Executor` and `PlaybookAuthoring`
(APB) and `Memory` (OSB) adapters, the CLI commands and their composition,
the HTML report, playbook authoring by the brain (only the port and the
decision hook exist).

## Capabilities

### New Capabilities

- `factory-domain`: the factory's data model and its pure rules.
- `factory-orchestration`: how a run moves from a spec to a delivery, owning
  every task transition, deadline, budget and recovery.
- `run-trace`: the run's trace, persisted run state, interventions and the
  report built from them.
- `task-workspace`: the git layout of a run (spec repository, task trees,
  integration, delivery).
- `acceptance-checks`: executing black-box checks and package test commands
  with bounded time and captured output.

### Modified Capabilities

None.

## Impact

Layers: `domain`, `ports`, `application`, and four new adapters
(`src/adapters/trace-fs/`, `workspace-git/`, `check-runner/`,
`report-markdown/`). Each module imports only its own or a lower layer; the
application imports no adapter and no SDK; nothing here imports
`@mozaik-ai/core` or `@modelcontextprotocol/sdk`. No new dependencies are
expected (Bun's `spawn`, `fetch` and file APIs, `git` on the PATH). The
existing `Clock` port and `systemClock` stay where they are.
