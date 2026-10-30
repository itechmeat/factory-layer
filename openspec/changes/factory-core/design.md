# Design

## Context

See proposal.md for the motivation. The product design
(`docs/superpowers/specs/2026-10-30-factory-layer-design.md`) fixes the
architecture: sections 6.1 (layers and ports), 6.2 (the brain only decides),
6.3 (supervised APB runs, repair runs after a finished run), 6.4 (workspace),
6.6 (limits and restart) and 6.7 (trace, cost, interventions). This change
builds everything of that core which needs no external service. Another
change (`m0-adapter-smokes`) builds the stdio MCP client and the guarded
brain runner at the same time; the real `Brain`, `Executor`,
`PlaybookAuthoring` and `Memory` adapters come in M1 and must fit the ports
defined here.

The repository today has a skeleton: `src/domain/index.ts` (product name),
`src/ports/index.ts` (`Clock`), `src/application/index.ts` (a status line),
`src/adapters/index.ts` (`systemClock`), `src/cli/index.ts`. The check tiers
(`scripts/check.sh`) and the layer rule (`.dependency-cruiser.cjs`) are in
place.

## Goals / Non-Goals

**Goals:**

1. A factory core that runs a whole spec end to end against fake ports in
   unit tests, deterministically and offline.
2. Port shapes that the APB, OSB and Mozaik adapters can implement without
   changing the core.
3. Real file-system, git and process adapters for the trace, the workspace
   and the checks.

**Non-Goals:**

1. Any MCP, Mozaik or network code besides HTTP checks against the package's
   own local server.
2. CLI commands, argument parsing and terminal rendering.
3. The HTML report; brain-authored playbooks beyond the port.

## Decisions

### D1. Module layout

```
src/domain/          spec.ts, acceptance.ts, plan.ts, task.ts, decisions.ts,
                     usage.ts, trace-event.ts, run-state.ts, limits.ts,
                     redact.ts, order.ts
src/ports/           brain.ts, executor.ts, playbook-authoring.ts, memory.ts,
                     trace-sink.ts, run-store.ts, workspace.ts,
                     check-runner.ts, cost-table.ts, execution-slots.ts
                     (Clock stays in index.ts)
src/application/     run-factory.ts (use case), scheduler.ts (readiness and
                     dispatch), task-runner.ts (one task's attempt loop),
                     decisions.ts (bounded brain calls with defaults),
                     integration.ts, replan.ts, cutoff.ts, delivery.ts,
                     reconcile.ts, intervention.ts, replay.ts, slots.ts
src/adapters/trace-fs/, workspace-git/, check-runner/, report-markdown/
```

Each `index.ts` re-exports its layer's public surface. Names are guidance;
the module headers and the 400-line smell decide the final split.

### D2. Port shapes

All inputs and outputs are domain types. Every method that can wait takes a
deadline in milliseconds or an `AbortSignal`, never waits unbounded, and
reports failures as typed results or typed errors (no strings).

1. `Brain`: `plan(spec, recalled)`, `correctPlan(spec, plan, reasons)`,
   `replan(spec, plan, failure, integrated)`, `deriveAcceptance(spec)`,
   `judge(task, report, checkResults)`, `chooseRecovery(task, failure,
   history)`, `proposePlaybook(taskKind, examples)`. Each takes an
   `AbortSignal` and returns `{ decision, usage: UsageRecord[] }` (one
   record per provider attempt inside the adapter); a failure is a typed
   error that also carries the usage records already incurred. The core wraps every call
   with the deadline, retries and defaults of the orchestration spec; the
   port itself is free of policy.
2. `Executor` (shaped after APB's supervised MCP surface):
   - `startRun({ dispatchKey, playbook, tree, inputs })` returns
     `{ runId, supervisorToken }` or a typed `indeterminate` failure. APB
     returns the supervisor token only in the start answer and keeps just its
     fingerprint, so a lost answer means a run that can be stopped but not
     supervised.
   - `findRuns({ playbook, tree, notBefore })` returns the runs of that
     playbook whose worktree is `tree` and that were created at or after
     `notBefore`, each `{ runId, status }`, never a token. APB's run listing
     carries no inputs, so the M1 adapter lists runs newer than `notBefore`
     and reads each one's `worktree` from `run_status`; the M1 adapter has a
     contract test against recorded APB response shapes.
   - `waitEvent(runId, afterSeq, sliceMs)` returns `{ event, nextAfterSeq }`
     where `event` is one of: `wake { seq, trigger, nodeId?, detail }` with
     `trigger` in `node_failed | node_finished | question | review |
     stalled | other` (APB's `node_timeout` is normalized to `node_failed`
     with the detail `timeout`); `terminal { status: succeeded | failed | aborted |
     stopped }`; `needs_host`; `quiet`. The adapter's MCP request timeout is
     longer than the slice.
   - `report(runId)` returns the run's final report: per node outcome and
     summary, and one usage record per node attempt with its actual model
     (unavailable for attempts that reported none), collected once.
   - `appendContext(runId, text)`, `retryNode(runId, nodeId)`,
     `rebindProfile(runId, nodeId, profile)`: each returns `{ accepted,
     postedSeq }`; acceptance does not mean the change took effect.
   - `stop(runId, deadlineMs)` returns `stopped` only when the run is
     terminal AND its driver is gone (APB writes the terminal event before
     the driver releases the tree lock, and a live driver still blocks a new
     run in that tree), else `unconfirmed`. The M1 adapter's contract test
     covers a terminal run whose driver is still alive.
   - `attach(runId, supervisorToken)` restores supervision after a restart.
3. `PlaybookAuthoring`: `list()`, `get(id)`, `create(draft)`,
   `validate(id)`, `trial(id, inputs)`, `approve(id)`.
4. `Memory`: `recall(spec, limit, signal)` and `remember(outcome, signal)`.
5. `TraceSink`: `emit(event)`.
6. `RunStore`: `save(state)`, `load(runId)`, `appendIntervention(runId,
   note)` (used from another process).
7. `Workspace`: `prepare(spec)`, `taskTree(spec, task, revision)`,
   `commitTask(tree, message)`, `prepareIntegration(spec, task, revision)`
   returning `{ tree, commit, base }` or `conflict { paths }`,
   `advanceMain(spec, commit, base)` (fast-forward only, fails if `main`
   moved), `mainCommit(spec)`, `handOverConflict(spec, task, revision)`,
   `unresolvedPaths(tree)`, `cleanCopy(spec)`, `deliver(copy, outDir)`.
8. `CheckRunner`: `packageSteps(dir, runtimes)` and `runChecks(dir,
   checks)`, both returning results, never throwing for a failing package.
9. `CostTable`: `price(model)` returning a price per million input and
   output tokens or `unavailable`.
10. `ExecutionSlots`: `acquire(runId, signal)` and `release(slot)`, one
    shared instance per process enforcing the global cap; the core enforces
    the per-run cap itself.

### D2a. Intents and reconciliation

Every side effect is bracketed in the run state: an intent is saved before
it (`start { dispatchKey, playbook, tree, at }`, `command { runId, nodeId, choice, hint,
profile?, step, postedSeq? }`, `stop { runId, purpose, continuation }`,
`integrate { task, revision, commit, base }`, `deliver`), and cleared or
replaced by its result after it. Resume walks the intents as the
orchestration spec states. Tests simulate a crash by taking the fake
`RunStore` snapshot at each intent and resuming a fresh core from it.

### D2b. Integration flow

`prepareIntegration` merges the task branch onto `main` in
`work/<spec>/.trees/integrate-<task>-r<revision>`. The core runs the package
steps and all checks there, compares with the last check results recorded
for `main` (kept in the run state), and calls `advanceMain` only when no
previously passing check fails and the package tests pass. On a conflict,
`handOverConflict` merges `main` into the task branch inside the task tree;
an `integrate` run resolves it; the core checks `unresolvedPaths` is empty,
commits, and prepares the integration again.

### D2c. Redaction

`domain/redact.ts` holds the one redaction function. The run's secret set
(credential values passed in run options, plus every supervisor token as it
is learned) is applied by the trace sink, the run store's error messages,
the check runner's outputs, the workspace's errors and the report.

### D3. One writer, explicit transitions

The run's state lives in one object owned by `run-factory`. Task state
changes go through one `transition(task, to, reason)` function that checks
the domain's allowed transitions, saves the run state through `RunStore`
and emits a trace event, in that order. Concurrency comes from independent
promises (task attempts, decisions) whose results come back to the owner;
no other module mutates task state.

### D4. Time and determinism

All time comes from the `Clock` port plus an injected `sleep` (or timer
port) so unit tests run on a fake clock. Limits are exported constants in
`domain/limits.ts` with units (`BRAIN_DECISION_DEADLINE_MS = 90_000`,
`BRAIN_DECISION_RETRIES = 2`, `TASK_ATTEMPT_BUDGET = 3`,
`RUN_REPLAN_BUDGET = 1`, `RUN_TASK_CONCURRENCY = 3`,
`EXECUTOR_WAIT_SLICE_MS = 60_000`, `EXECUTOR_STALL_LIMIT_MS = 600_000`,
`EXECUTOR_STOP_DEADLINE_MS = 60_000`, `GLOBAL_EXECUTOR_RUNS = 4`,
`MEMORY_DEADLINE_MS = 10_000`) and the
required runtimes default to both `bun` and `npm` and can be overridden per run through a
validated `RunOptions`.

### D5. Fakes are part of the deliverable

`src/application/testing/` holds in-memory fakes of every port with
scriptable behaviour (a fake brain answering per decision kind with delays,
a fake executor with scripted events, a fake workspace, a fake check runner,
an in-memory store and sink). They are test-only modules (imported only by
tests) and are reused in M1 for the CLI's `--dry-run`.

### D6. Real adapters

1. `trace-fs`: `appendFileSync`-equivalent append per event (one write per
   line), state written to a temp file in the same directory then renamed,
   `chmod 0600`; reading validates every line with Zod.
2. `workspace-git`: `git` through `Bun.spawn` with a timeout per command;
   `prepareIntegration` merges with `--no-ff` in the integration tree and on
   conflict reads the unmerged paths, aborts and removes that tree;
   `advanceMain` uses `git update-ref refs/heads/main <commit> <base>` (an
   atomic compare-and-swap); `cleanCopy` uses `git worktree add --detach`
   into a temporary directory under `work/<spec>/.delivery/`.
3. `check-runner`: commands through `Bun.spawn` in their own process group so
   a timeout kills the group; HTTP checks get a free port from a listener on
   port 0, wait for TCP accept, use `fetch` with a timeout.
4. `report-markdown`: a pure function from a list of trace events to
   Markdown, plus a thin writer.

### D7. Working alongside `m0-adapter-smokes`

Both changes are implemented in the same working tree at the same time. This
change owns `src/domain/`, `src/ports/`, `src/application/` and the four
adapter directories above. It must not edit `src/adapters/mcp-stdio/`,
`src/adapters/brain-mozaik/`, `tests/integration/`, `.apb/`, `README.md`,
`.env.example`, `knip.json` or `tsconfig.json`; if it needs a change there,
it states it in its report. Shared files it may touch: `src/adapters/index.ts`
(add re-exports only) and `docs/versions.md` (append only).

## Risks / Trade-offs

- [Port shapes do not fit APB or OSB] -> shapes follow the APB MCP surface
  (supervised start, `supervisor_wait_event` slices, context append, node
  retry, rebind, stop) and OSB recall and remember; M1 may adjust them in a
  follow-up change, with the core's tests as the safety net.
- [Fake-clock tests hide real concurrency bugs] -> the orchestration tests
  include overlap assertions on recorded intervals and one test on the real
  clock with short delays.
- [git and process adapters are platform sensitive] -> Linux and macOS only;
  tests use temporary directories and real `git`.
- [Size of the change] -> the tasks are grouped so each group ends green on
  `bun run check:fast`.
- [In-run parallelism] -> APB takes it only from the playbook
  (`defaults.max_parallel`), so the playbooks of `m0-adapter-smokes` set it
  to 2 and the core has no run option for it.
- [Finding a run without its start answer] -> correlation by playbook, tree
  and creation time (one run per tree at a time), a settle window before an
  empty lookup counts, and a new tree for the replacement; the core only
  depends on `findRuns`.
