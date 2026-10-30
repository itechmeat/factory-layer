# Tasks

Every failure-path behaviour named in a task below is done test first:
write the failing test, see it fail, then write the code until it passes.
Happy-path behaviour named in a task (round trips, clean advances,
successful outcomes and the like) is proven by the end-to-end test on fakes
(3.13) or the adapters' tests against real git and processes, not by its own
unit test. Each group ends with `bun run check:fast` green.

Test policy (project rule since 2026-10-30): end-to-end runs are the main
gate. Unit tests are for failure paths an end-to-end run cannot reproduce
(deadlines, stops, crash points, restart reconciliation, redaction,
boundary validation). The happy path of the orchestration is proven once by
the end-to-end test on fakes (3.13) and the adapters' tests against real
git and processes; do not add separate happy-path unit tests for what those
already cover.

## 1. Domain (`src/domain/`)

- [ ] 1.1 Tests then code: spec (name from file), acceptance check kinds (CLI, HTTP, command) with default timeout, round trip
- [ ] 1.2 Tests then code: plan schema; validity reasons (duplicate ids, unknown dependency, cycle); owned-path overlap of parallel tasks incl. ancestor paths and the sequential exception
- [ ] 1.3 Tests then code: stable topological order (reversed listing gives A, B; plan order breaks ties)
- [ ] 1.4 Tests then code: task states, allowed and illegal transitions, readiness
- [ ] 1.5 Tests then code: verdicts, recovery choices (retry without hint rejected), budgets (attempts spent, re-plan available or used), limits constants and validated run options
- [ ] 1.6 Tests then code: usage, cost, usage records with provenance per brain attempt and per executor node attempt, aggregation that keeps unavailable parts, failed decisions carrying incurred usage
- [ ] 1.7 Tests then code: redaction of strings and nested JSON values
- [ ] 1.8 Tests then code: trace event and run state schemas (spec, plan, checks, options, cutoff, intents, cursors, tokens, last `main` check results)

## 2. Ports and fakes (`src/ports/`, `src/application/testing/`)

- [ ] 2.1 Port interfaces of design D2 with JSDoc on each method stating its deadline and failure behaviour; typecheck green
- [ ] 2.2 Tests then code: scriptable fakes of every port (brain with per-kind answers and delays, executor with scripted event sequences, cursors, `findRuns` with late-appearing runs, and stop outcomes, workspace with conflict and advance outcomes, check runner, in-memory store that can fail on demand, sink, shared slots)

## 3. Orchestration (`src/application/`)

- [ ] 3.1 Tests then code: bounded brain decisions with retries; defaults per decision kind (plan fails the run, acceptance unavailable caps the outcome, verdict rejects, recovery gives up, re-plan keeps the plan and fails the asker)
- [ ] 3.2 Tests then code: run start with recall deadline, concurrent plan and acceptance with recorded overlap, initial correction once, second invalid plan fails the run
- [ ] 3.3 Tests then code: dispatch in topological order, run cap and shared cap across two runs, intent before start, mapping after, idempotent dispatch key, indeterminate start (lookup by playbook, tree and time; run appearing late within the settle window; replacement as a new revision in a new tree after the window), orphan stop before replacement, unconfirmed orphan holds its slot
- [ ] 3.4 Tests then code: waits in slices with persisted cursors, stall stop, `needs_host` stop, live node failure enters recovery while the run is live
- [ ] 3.5 Tests then code: judging with package steps and all checks, concurrent critics with overlap, scaffold-then-feature accepted
- [ ] 3.6 Tests then code: recovery on a live run (retry, rebind with persisted command steps, commands accepted not applied; repair, replan and give up stop and confirm first), failed, aborted and node-timeout terminals, on a finished run (driver-gone confirmation before the tree is reused, a terminal event with a live driver makes the repair wait for confirmed release; retry and rebind to repair with downgrade traced, repair), budget spent with re-plan available and with re-plan used, dependants failed
- [ ] 3.7 Tests then code: serialized runtime re-plan with a running and a judging task, stop confirmation, cancelled decisions, stale-revision results discarded, integrated tasks kept, fresh budgets; failed re-plan (decision failure, invalid plan, unconfirmed stop) restores the other tasks and spends the allowance
- [ ] 3.8 Tests then code: transactional integration (regression keeps `main`, clean advance, `main` moved), conflict hand-over to an `integrate` run and retry, conflict counts as an attempt
- [ ] 3.9 Tests then code: cutoff during execution, during recovery and during planning; unconfirmed stop traced as abandoned; no dispatch after the cutoff; unconfirmed stop of an ordinary repair or give-up (no continuation, task failed, slot held, tree not reused, released once seen stopped)
- [ ] 3.10 Tests then code: delivery gate with install, build and tests under both runtimes, install failure, build failure, one runtime failing, `deliverUnverified`, outcomes succeeded, partial and failed
- [ ] 3.11 Tests then code: memory of outcomes with failure, storage failure stops live runs and fails the run, interventions, replay with speed factor
- [ ] 3.12 Tests then code: crash-point resume from every intent kind (start without mapping found by key and stopped as an orphan, start not found re-dispatched, live run from cursor, command at each step (crash between context and retry, between rebind and retry, indeterminate posting turned into stop and repair) within one attempt, stop intents finished before judging (after a confirmed stop before the repair run; midway through stopping runs for a re-plan), run finished successfully judged, failed or aborted run sent to recovery, unconfirmed stop on resume, `main` already advanced, delivery repeated)
- [ ] 3.13 End-to-end test on fakes: a three-task plan listed out of order with one live recovery and one conflict reaches `succeeded`; the trace shows overlapping plan and acceptance and overlapping critics

## 4. Adapters

- [ ] 4.1 Tests then code `trace-fs`: JSONL append and validated read-back with line numbers, redaction with a sentinel secret, no supervisor token in the trace, atomic 0600 run state, typed storage error, interventions from another handle; temporary directories
- [ ] 4.2 Tests then code `workspace-git` with real `git` in temporary directories: spec repository, idempotent task trees, commit, integration tree clean and conflicting, advance as compare-and-swap (fails when `main` moved), conflict hand-over leaves markers and reports unresolved paths, clean copy, delivery without `.git` and `node_modules`, command timeout and redacted stderr
- [ ] 4.3 Tests then code `check-runner` against small fixture packages: bounded commands with process-group kill, spawn failure as a result, redacted truncated output, package steps per runtime with one runtime failing, missing test script, CLI checks with mismatch reasons, HTTP checks with started server, start timeout and guaranteed stop
- [ ] 4.4 Tests then code `report-markdown`: per-task table from usage records with actual models, brain usage per decision kind, unavailable shown as unavailable, overlapping decision pairs, recoveries, failed checks, intervention log (empty stated), redacted

## 5. Delivery

- [ ] 5.1 `bash scripts/check.sh standard` green
- [ ] 5.2 Report to the orchestrator: files changed, verbatim last lines of every check, deviations with reasons, open risks, port details the M1 adapters must know

## Workflow follow-up

- The orchestrator runs one combined full gate (`bun run check`) after both this change and `m0-adapter-smokes` land, with code-ranker clean.
- The orchestrator and Sol review the diff; the implementer fixes the findings; the combined full gate runs again.
- Archive the change (`/opsx:archive`), then `openspec validate --all --strict`.
- The owner approves the commit.
