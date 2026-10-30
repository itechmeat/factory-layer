# factory-orchestration Specification

## Purpose
How one factory run moves from a spec to a delivered package. The
application is the single writer of task state: it asks the brain only for
typed decisions, asks the hands only to run work, and owns every
transition, deadline, budget, recovery, integration and the delivery.

## Requirements

### Requirement: Concurrent start

A run SHALL start by recalling similar past runs from memory (bounded at
10 s; a memory failure is traced and the run continues with no recall), then
SHALL ask the brain for a plan and for acceptance checks concurrently: both
requests are issued before either answer is awaited.

#### Scenario: Plan and acceptance overlap

- **WHEN** a run starts with a brain whose plan and acceptance answers each take 100 ms
- **THEN** both requests are issued before either completes, and the trace records both decision intervals overlapping

### Requirement: Spec-true acceptance checks

The run's acceptance checks SHALL start with the checks taken from the
spec's own shell examples (ids `spec-example-N`), derived without any
model; examples that need a network service are left out. A
derived check that takes an example id, a command check that names none of
the commands the examples run and no runtime, or a check that runs an
example's invocation with a different expectation SHALL be dropped and traced with its id, stage
and reason; example checks are never dropped.

#### Scenario: Check contradicting an example

- **WHEN** the spec's example pipes `a` into the tool and expects `A`, and a derived check pipes `a` and expects `a`
- **THEN** the derived check is dropped before any task runs and the trace names it with the contradicted example

### Requirement: Acceptance review

The remaining derived checks SHALL go to the brain's acceptance review, one
decision per batch of derived checks, run concurrently while planning goes
on; a check it objects to SHALL be dropped and traced with the objection.

#### Scenario: Critic objects to a check

- **WHEN** the acceptance review objects to one derived check
- **THEN** the run's checks are the example checks and the other derived checks, and the dropped check is traced with the objection

#### Scenario: Review unavailable

- **WHEN** a review decision fails three times
- **THEN** the checks of its batch are kept

### Requirement: Initial plan correction

An invalid first plan SHALL be sent back to the brain once with the reasons.
This correction is separate from the runtime re-plan allowance. A second
invalid plan, or a plan decision that fails after its retries, SHALL end the
run as `failed` before any task starts.

#### Scenario: Overlapping plan repaired

- **WHEN** the first plan has overlapping parallel tasks and the corrected plan is valid
- **THEN** the run continues with the corrected plan, the trace records the rejection reasons, and the runtime re-plan allowance is still available

### Requirement: Brain decision handling

Each brain decision SHALL be bounded by a deadline (default 90 s) and
retried up to 2 times on failure or timeout.

#### Scenario: Critic unavailable

- **WHEN** the judge decision fails three times for a finished task
- **THEN** the task is treated as rejected with reason `brain_unavailable` and the recovery path applies

#### Scenario: Acceptance unavailable

- **WHEN** the acceptance decision fails three times
- **THEN** the run continues with only the spec's example checks and its outcome cannot be `succeeded`

### Requirement: Aborted decision grace

When a decision attempt reaches its deadline, the application SHALL abort
the call and wait at most `BRAIN_ABORT_GRACE_MS` (5 s) for it to settle; a
call that does not settle by then is abandoned as timed out with an
unavailable usage record, so a brain that ignores the abort cannot hang the
run.

#### Scenario: Brain ignores the abort

- **WHEN** a judge call ignores the abort after its deadline
- **THEN** the attempt ends as timed out 5 s after the deadline and the next attempt starts

### Requirement: Resolved run limits

The orchestration SHALL work under the run's resolved limits (the run
options over the constants): the attempt budget, the re-plan budget, the
run's task concurrency, the stall limit and the decision deadline, never
the bare constants.

#### Scenario: One attempt allowed

- **WHEN** a run's options set the attempt budget to 1 and the re-plan budget to 0 and the first attempt fails
- **THEN** the task is `failed` with `budget_spent` and no recovery decision is asked

### Requirement: Decision defaults

After that the application
SHALL apply the default of the decision kind: plan or initial correction,
end the run as `failed`; acceptance checks, continue with only the spec's
example checks and mark the run `acceptance_unavailable`, which caps the
outcome at `partial`; acceptance review, keep the reviewed checks; verdict, reject with the reason `brain_unavailable`; recovery
choice, `give_up`; runtime re-plan, keep the current plan and fail the task
that asked for it.

#### Scenario: Re-plan unavailable

- **WHEN** a runtime re-plan decision fails three times
- **THEN** the current plan is kept and the task that asked for the re-plan is marked `failed`

### Requirement: Execution order

Tasks SHALL be dispatched and integrated in a stable topological order of
the plan (dependencies first, plan order as the tie-breaker), so a valid plan
listed in any order makes progress. A task becomes ready when every task it
depends on is integrated; a task that depends on a failed task SHALL be
marked `failed` with the reason `dependency_failed`, and independent tasks
continue.

#### Scenario: Dependant listed first

- **WHEN** the plan lists task B (depends on A) before task A
- **THEN** A is dispatched first and B becomes ready after A is integrated

### Requirement: Dispatch

Ready tasks SHALL be dispatched without exceeding the run's cap (default 3
live executor runs) and a cap shared by all runs in the process (default 4).
Task, repair and integrate runs all count against both caps. The in-run
parallelism limit (2) is a property of the playbooks, not a run option.

#### Scenario: Cap respected

- **WHEN** five independent tasks are ready and the run cap is 3
- **THEN** exactly 3 executor runs are live until one of them finishes

#### Scenario: Shared cap

- **WHEN** two runs in one process each have three ready tasks and the shared cap is 4
- **THEN** at most 4 executor runs are live in total

### Requirement: Dispatch sequence

For each
dispatch the application SHALL create the task's tree, persist a start
intent with a dispatch key (run id, task, revision, attempt), the playbook,
the tree and the intent time, then start a
supervised executor run carrying that key, then persist the executor run
mapping.

#### Scenario: Intent before start

- **WHEN** a task is dispatched
- **THEN** the run state holds its start intent with the dispatch key before the executor run is started

### Requirement: Idempotent dispatch

Dispatch SHALL be idempotent per dispatch key: dispatching the same key again
SHALL NOT start another executor run.

#### Scenario: Duplicate dispatch

- **WHEN** the same task, revision and attempt are dispatched twice
- **THEN** only one executor run exists for them

### Requirement: Waits the factory cannot serve

A run that waits for a question answer or a review, or that the executor
reports stalled, SHALL be stopped and treated as an executor failure at
once, like a run that waits for a host agent.

#### Scenario: Review gate

- **WHEN** a run reports it waits for a review
- **THEN** the application stops it and the task enters recovery with an executor-failure reason

### Requirement: Refused start

When the executor refuses a start by policy (for example an untrusted
playbook), the task SHALL be marked `failed` with the reason
`executor_refused` and the policy, without a run lookup, a settle window or
a recovery attempt.

#### Scenario: Untrusted playbook

- **WHEN** the executor refuses a task's start because its playbook is not trusted
- **THEN** the task is `failed` with `executor_refused` and the policy, and no other run starts for it

### Requirement: Bounded executor waits

The application SHALL wait for executor events in slices (default 60 s)
after the last persisted event cursor and SHALL persist the new cursor after
each event. A run with no event for the stall limit (default 10 min) SHALL
be stopped and treated as an executor failure. A run that waits for a host
agent SHALL be stopped and treated as an executor failure at once. A node
failure reported while the run is live SHALL enter recovery for that node
without waiting for the run to end.

#### Scenario: Stalled run

- **WHEN** an executor run produces no event for longer than the stall limit
- **THEN** the application stops it and the task enters recovery with an executor-failure reason

#### Scenario: Live node failure

- **WHEN** a live run reports that node `code` failed
- **THEN** the task enters recovery for node `code` while the run is still live

### Requirement: Judging

When an executor run of a task ends successfully, the application SHALL run
the package tests and all acceptance checks in the task's tree and ask the
brain for a verdict with the task, the executor's report and every check
result. Check results inform the verdict; the critic MAY accept a task while
checks outside the task's scope fail. When several tasks finish close
together, their judge decisions SHALL run concurrently.

#### Scenario: Overlapping critics

- **WHEN** two tasks finish within 10 ms of each other and each judge decision takes 100 ms
- **THEN** both judge decisions are in flight at the same time and the trace shows their intervals overlapping

#### Scenario: Scaffold before features

- **WHEN** a scaffold task finishes and the feature checks fail because the features do not exist yet
- **THEN** the critic receives those results and an `accept` verdict moves the scaffold on to integration

### Requirement: Recovery budget

A task SHALL have 3 attempts (the first plus two recoveries); each accepted
recovery command or new repair run consumes one attempt. When a task's
attempts are spent and the run's single runtime re-plan is still available,
the application SHALL ask the brain to re-plan with the failure; when it is
spent, the task SHALL be marked `failed`, after its live run is stopped and
confirmed terminal (an unconfirmed stop holds the slot as for an orphan).

#### Scenario: Budget spent, re-plan available

- **WHEN** the third attempt of a task is rejected and no runtime re-plan was used
- **THEN** the brain is asked for a new plan with that failure

#### Scenario: Budget spent, re-plan used

- **WHEN** the third attempt of a task is rejected after the runtime re-plan was used
- **THEN** the task and its dependants are marked `failed` without a brain decision

### Requirement: Replacement budgets

Tasks of a replacement plan SHALL start with a fresh budget.

#### Scenario: Fresh budget after re-plan

- **WHEN** a replacement plan gives task A a new revision
- **THEN** A has 3 attempts again

### Requirement: Recovery choices

A task in recovery SHALL ask the brain for a recovery choice with the
failure and the task's history and apply it. On a live run, `retry` SHALL
append the hint and retry the failed node, `rebind` SHALL append the hint,
rebind the node and retry it, and `repair`, `replan` and `give_up` SHALL
first stop the run and confirm it terminal.

#### Scenario: Retry on a live run

- **WHEN** the brain chooses `retry` while the run is live with node `code` failed
- **THEN** the hint is appended to the run and node `code` is retried, and the task keeps waiting for events

### Requirement: Recovery triggers

Failed or aborted terminals and
node timeouts (normalized to node failures) SHALL enter recovery. A posted command counts as accepted, not as applied: the task
keeps waiting for the run's events.

#### Scenario: Node timeout

- **WHEN** APB reports that node `code` timed out
- **THEN** the task enters recovery as a failure of node `code` with the reason timeout

### Requirement: Tree release

Before any new run uses the tree of a finished run, the application SHALL
confirm through a bounded stop that the run's driver is gone (a terminal
event can arrive while the driver still holds the tree); an unconfirmed stop
follows the unconfirmed-stop rules.

#### Scenario: Terminal event with a live driver

- **WHEN** a run reports a failed terminal while its driver still holds the tree
- **THEN** the repair run starts only after the stop confirms the driver is gone

### Requirement: Recovery on a finished run

On a finished run, `retry` and `rebind` SHALL start a `repair` run in the
same tree with the hint (a rebind is traced as downgraded to repair).
`repair` SHALL start a `repair` run in the same tree with the failing
checks. `replan` SHALL use the run's runtime re-plan while the run's
re-plan budget lasts; past it, live or finished, `replan` SHALL start a
`repair` run with the failure as the hint, traced as downgraded, and spend
no re-plan. `give_up` SHALL mark the task `failed`.

#### Scenario: Replan past the budget

- **WHEN** the brain chooses `replan` and the run's re-plan budget is spent
- **THEN** a `repair` run starts in the task's tree with the failure as the hint, the trace records the downgrade, and no re-plan starts

#### Scenario: Rebind after the run finished

- **WHEN** the brain chooses `rebind` for a task whose executor run has finished
- **THEN** a `repair` run starts in the same tree with the hint and the trace records the downgrade

### Requirement: Runtime re-plan

A runtime re-plan SHALL be serialized: dispatch pauses; every live executor
run of a task that is not integrated is stopped and confirmed terminal;
pending decisions of those tasks are cancelled; the brain is asked for a new
plan that keeps every integrated task unchanged; the new plan is validated
(including that it keeps the integrated tasks); every non-integrated task
gets a new revision; dispatch resumes. Results that arrive for an older
revision SHALL be discarded and traced.

#### Scenario: Re-plan with work in flight

- **WHEN** a re-plan starts while task A is running and task B is being judged
- **THEN** A's run is stopped and confirmed terminal, B's judge result is discarded when it arrives, and both continue only as new revisions of the new plan

### Requirement: Failed re-plan

When the re-plan decision fails, returns an invalid plan, or a stop cannot be
confirmed, the re-plan allowance SHALL be spent, the asking task and any task
whose stop was not confirmed SHALL be marked `failed`, and every other task
SHALL continue under the current plan: a finished run's judge decision is
issued again, and a stopped task is dispatched again as a new revision with
its remaining attempts (the stop consumes none).

#### Scenario: Invalid replacement plan

- **WHEN** the replacement plan is invalid while task A was stopped and task B was waiting for its verdict
- **THEN** the asking task is `failed`, A is dispatched as a new revision with its attempts unchanged, B is judged again, and no further re-plan is possible

### Requirement: Transactional integration

Accepted tasks SHALL be integrated one at a time in execution order. The
application SHALL merge the task's branch onto the current `main` in a
separate integration tree, run the package tests and all acceptance checks
there, and advance `main` to the result only when no check that passed on
`main` before now fails and install, build and package tests pass. Otherwise `main` stays
where it was and the regression is sent to the brain as a rejection of that
task.

#### Scenario: Regression kept off main

- **WHEN** a merged task makes a previously passing check fail in the integration tree
- **THEN** `main` is unchanged and the task enters recovery with the regression

#### Scenario: Conflict

- **WHEN** a task branch conflicts with `main`
- **THEN** an `integrate` run starts in the task's tree with the conflicting paths and `main` is unchanged

### Requirement: Conflict resolution

A merge conflict SHALL be resolved in the task's own tree: `main` is
merged into the task branch there, an `integrate` executor run resolves the
conflict and commits, and integration is tried again; this counts as a
recovery attempt.

#### Scenario: Resolved conflict integrates

- **WHEN** the `integrate` run resolves the conflict in the task tree and commits
- **THEN** integration is tried again on the current `main`

### Requirement: Cutoff

A run SHALL have an optional absolute cutoff time. From the cutoff on, no
dispatch, recovery, re-plan or integration starts, pending decisions are
cancelled, and every live executor run is stopped with a bounded wait for its
terminal state (default 60 s); a run whose stop cannot be confirmed is
traced as abandoned; every task that has not ended is marked `failed` with
the reason `cutoff`. Then delivery starts. A cutoff reached during planning
ends the run as `failed`.

#### Scenario: Cutoff during execution

- **WHEN** the cutoff passes while two tasks are running
- **THEN** both runs are stopped and confirmed terminal, no new work starts, and delivery begins

### Requirement: Caller cancellation

A caller's cancellation of a run SHALL set the run's cutoff to the moment of
cancellation and persist it; the cutoff rules then apply.

#### Scenario: Caller cancels the run

- **WHEN** the caller cancels a run while two tasks are running
- **THEN** the cutoff is saved as that moment, both runs are stopped, and delivery begins

### Requirement: Slots held by unconfirmed runs

When tasks wait for a slot while every slot of the run is held by runs
whose stop or release is unconfirmed, the application SHALL check those runs
again every lookup interval, release a slot once its run is seen stopped,
and mark the waiting tasks `failed` with the reason `slots_held` when no slot
comes back within the run's stall limit, before delivery starts.

#### Scenario: Slot never comes back

- **WHEN** the run's only slot is held by a run whose release stays unconfirmed and another task is ready
- **THEN** the run is asked to stop again every lookup interval, and after the stall limit the ready task is `failed` with `slots_held` before delivery

### Requirement: Delivery

Delivery SHALL start when every task is `integrated` or `failed`, or at the
cutoff. From a clean copy of `main` it SHALL install dependencies, build when
a build script exists, run the package tests under every required runtime
(default both `bun` and `npm`; a run option overrides it when the spec
states a convention) and all acceptance checks.

#### Scenario: One runtime fails

- **WHEN** the package tests pass under `bun` and fail under `npm`
- **THEN** nothing is copied, the outcome is `failed` with the verification failure, unless `deliverUnverified` is set

### Requirement: Delivery gate

The tree SHALL be copied to
the output directory without `.git` and `node_modules` only when install,
build (when present) and tests all pass under every required runtime, unless the run option
`deliverUnverified` is set, in which case it is copied and the outcome
records the failed verification.

#### Scenario: Build fails

- **WHEN** the tests pass under both runtimes but the build fails under `npm`
- **THEN** the tree is not verified and nothing is copied unless `deliverUnverified` is set

#### Scenario: Verified copy

- **WHEN** the package tests pass under both runtimes
- **THEN** the tree is copied to the output directory without `.git` and `node_modules`

### Requirement: Run outcome

The run outcome SHALL be `succeeded` when every task is integrated, install,
build and tests pass under every required runtime and every acceptance check
passes; `partial` when a verified tree was delivered with failed tasks (even
when no task was integrated), failed acceptance checks or unavailable
acceptance (an empty set of acceptance checks counts as unavailable); and
`failed` when no verified tree was delivered. A run without an output
directory delivers its verified tree in place.

#### Scenario: One failed task

- **WHEN** one of three tasks failed and the verified integrated state of the other two was delivered
- **THEN** the outcome is `partial`

### Requirement: Wrong checks excused at delivery

When the run has example checks and every one of them passed on the
delivered copy, the derived checks that failed SHALL go to the brain's
acceptance review with the check results; a failed check it objects to is
traced as dropped at delivery and does not count as failed. A failed
example check is never excused.

#### Scenario: Wrong check excused at delivery

- **WHEN** every example check passed, one derived check failed and the acceptance review objects to it as contradicting the spec
- **THEN** that failure does not count and the outcome can be `succeeded`

### Requirement: Memory of outcomes

At the end of a run the application SHALL remember the outcome (spec name,
plan summary, per-task outcomes and attempts, failed checks, duration) in
memory, bounded at 10 s; a failure is traced and does not change the
outcome.

#### Scenario: Memory down at the end

- **WHEN** remembering the outcome fails
- **THEN** the run still ends with its outcome and the trace records the memory failure

### Requirement: Restart reconciliation

The persisted run state SHALL hold everything needed to resume: the spec,
the plan, the acceptance checks, the run options and cutoff, task states and
budgets, intents of side effects in progress, executor run mappings and
event cursors.

#### Scenario: Crash between start and mapping

- **WHEN** the process stopped after starting an executor run but before saving its mapping
- **THEN** on resume the run is found by its tree, stopped and confirmed terminal as an orphan, and only then is the task dispatched again

#### Scenario: Crash after main advanced

- **WHEN** the process stopped after advancing `main` but before marking the task integrated
- **THEN** on resume the task is marked integrated without merging again

### Requirement: Reconciling intents

On resume the application SHALL reconcile every start intent without a
recorded run as an indeterminate start (see indeterminate start).

#### Scenario: Live run re-attached

- **WHEN** a run is resumed and the state records task A running as executor run R with cursor 7
- **THEN** no new executor run is started for A and the application waits on R after event 7

### Requirement: Orphan handling

An executor run the application cannot supervise (a run found for a start
intent without its token, or any run seen later in an abandoned tree) SHALL be stopped and
confirmed terminal (bounded, default 60 s) before any replacement run of
that task starts, and it keeps its slot until then. An orphan whose stop
cannot be confirmed SHALL mark the task `failed` (`orphan_unconfirmed`) and
hold its slot until it is seen terminal or the factory run ends.

#### Scenario: Lost start answer

- **WHEN** the start call times out but the run was created
- **THEN** the run is found by its key, stopped and confirmed terminal, and a replacement run starts afterwards with a new key

### Requirement: Lost starts without a replacement

A lost start of a repair or integrate run SHALL NOT be replaced in a new
tree (it would lack the task's code): once settled, the task SHALL be marked
`failed` (`start_lost`). The cutoff or a re-plan during the settling SHALL
end it with no replacement, the tree abandoned and the slot freed.

#### Scenario: Lost start of an integrate run

- **WHEN** the start call of an integrate run times out and no run appears within the settle window
- **THEN** no replacement starts, nothing is integrated, and the task is `failed` with `start_lost`

### Requirement: Command handling

A recovery command on a live run SHALL be persisted as an intent before it
is posted (run, node, choice, hint, profile, step reached, posted sequence).
One logical recovery consumes one attempt, when its intent is created. On
resume, a step whose posting is indeterminate SHALL NOT be re-posted: the
run is stopped and confirmed terminal and a `repair` run starts with the
hint, within the same attempt.

#### Scenario: Crash after posting a retry

- **WHEN** the process stopped after posting a node retry but before saving its sequence
- **THEN** on resume the run is stopped and confirmed terminal, one `repair` run starts with the hint, and the task's attempts increase only once

### Requirement: Command steps on resume

On resume the steps of a command intent SHALL be reconciled in order: a step
with a recorded sequence is done and the next unposted step is posted. The
task waits for events only once the final retry is known posted.

#### Scenario: Crash between context and retry

- **WHEN** the process stopped after the context append was recorded but before the retry was posted
- **THEN** on resume the retry is posted, its sequence recorded, and the task waits for events within the same attempt

### Requirement: Reconciling live work

On resume, after stop intents are finished, a recorded live run with its
token SHALL be re-attached from its cursor; a command intent SHALL be reconciled as the
command handling states; a run that finished successfully without a stop intent SHALL be judged, and
a run that ended failed or aborted SHALL enter recovery; an integration intent SHALL check whether
`main` already points at the integration result; a delivery intent SHALL be
repeated from the start.

#### Scenario: Live run re-attached from its cursor

- **WHEN** the state records task A running as executor run R with cursor 7 and its token
- **THEN** no new run starts for A and the application waits on R after event 7

### Requirement: Unconfirmed stop

Every stop the application issues SHALL be bounded (default 60 s). When it
cannot be confirmed, the run SHALL be recorded as unconfirmed, its slot SHALL
stay held, its tree SHALL NOT be used again, and the stop's continuation
SHALL NOT start; the task SHALL be marked `failed` with the reason
`stop_unconfirmed`, and the application SHALL keep checking the run (on every
reconciliation, whenever tasks wait for a slot it holds, and before
delivery) and release the slot once it is seen stopped.

#### Scenario: Repair blocked by an unconfirmed stop

- **WHEN** a live run is stopped for a `repair` recovery and the stop is not confirmed within the deadline
- **THEN** no repair run starts, the task is `failed` with `stop_unconfirmed`, and the slot stays held until the run is seen stopped

### Requirement: Stop intents on resume

A stop intent SHALL hold its purpose (recovery, give up, budget spent,
re-plan, cutoff, orphan, storage) and its continuation (the recovery to
start, the re-plan phase reached). On resume every stop intent SHALL be
finished first: the stop is confirmed and the continuation performed before
any judging or dispatch.

#### Scenario: Stop for give up

- **WHEN** the process stopped while stopping a run for `give_up`
- **THEN** on resume the stop is confirmed and the task is marked `failed`

#### Scenario: Stop still unconfirmed on resume

- **WHEN** a stop intent cannot be confirmed on resume
- **THEN** the continuation does not run and the unconfirmed-stop rules apply

#### Scenario: Crash after stop, before repair

- **WHEN** the process stopped after confirming the stop of a run for a `repair` recovery but before starting the repair run
- **THEN** on resume the repair run starts and the finished run is not judged

#### Scenario: Crash midway through a re-plan

- **WHEN** the process stopped after stopping one of two runs for a re-plan
- **THEN** on resume the second run is stopped and confirmed, and the re-plan continues from that phase before any dispatch

### Requirement: Indeterminate start

A start call that fails or times out without an answer, and a start intent
found without a recorded run on resume, SHALL be treated as indeterminate.
The run is looked up by its correlation: a run of the intent's playbook in
the intent's tree, created at or after the intent time (the core never runs
two executor runs in one tree at once, so the match is unique). A found run
is an orphan.

#### Scenario: Start answer lost, run appears late

- **WHEN** the start call times out, the first lookup is empty, and the run appears 30 s later
- **THEN** the run is found within the settle window, stopped as an orphan, and only then is a replacement started

### Requirement: Settle window

An empty lookup SHALL NOT be definitive until a settle window (default
120 s from the start call) has passed with repeated lookups; the intent and
its slot are kept meanwhile. After the window the tree is abandoned and the
task is dispatched again as a new revision in a new tree within the same
attempt; a run that appears later in an abandoned tree is stopped as an
orphan.

#### Scenario: Start answer lost, run never created

- **WHEN** the start call times out and no run appears within the settle window
- **THEN** the task is dispatched again as a new revision in a new tree within the same attempt

### Requirement: Storage failure

When the run state cannot be saved, the application SHALL stop every live
executor run, trace the storage failure when the trace still accepts it,
and end the run as `failed`, because it can no longer guarantee a resume.

#### Scenario: Disk full

- **WHEN** saving the run state fails during execution
- **THEN** live runs are stopped and the run ends as `failed` with a storage-failure reason

### Requirement: Interventions

A human intervention SHALL be recordable for a run with a timestamp and a
note, from outside the running process, and SHALL appear in the trace and
the report.

#### Scenario: Intervention recorded

- **WHEN** an intervention with a note is recorded for a run
- **THEN** the trace of that run contains it with its time and note

### Requirement: Replay

A recorded trace SHALL be replayable: replay emits the recorded events in
order, preserving their relative timing scaled by a speed factor, to a trace
sink, without calling the brain, the executor or the workspace.

#### Scenario: Fast replay

- **WHEN** a trace spanning 60 s is replayed at speed 60
- **THEN** all events are emitted in their original order within about 1 s and no port other than the sink is called
