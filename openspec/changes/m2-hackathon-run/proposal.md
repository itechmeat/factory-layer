# Proposal

## Why

M1 proves one CLI spec end to end. For the hackathon the factory must turn
the hidden specs (CLI or HTTP API, published 18:00 CET) into packages in
`hidden/<spec name>/` that work under Node, by the owner's 19:30 push, and
show a live demo including the brain authoring a playbook. Everything else
is deferred; the decision record is
`docs/superpowers/specs/2026-10-30-hackathon-scope.md`.

## What Changes

- An active cutoff in the core: at the cutoff live runs are stopped with a
  bounded confirmation and delivery starts at once; with
  `deliverUnverified` the integrated `main` is copied before verification.
- `factory run --cutoff <HH:MM>` and `--task-concurrency <n>`; `--out`
  keeps its meaning.
- Acceptance checks and verification run under Node without `bun` on the
  `PATH` (on top of the allowlisted generated-code environment), and build
  before testing.
- A rebind to a profile other than `claude` is turned into a repair.
- The report gains executor-run intervals and their overlapping pairs
  (optional, dropped first).
- `bun run hidden <spec.md>...`: one `factory run` per spec in parallel
  with the cutoff and two task runs each, a hard deadline, a build in place, a table of `hidden/`
  and a startup check on exactly the committable files. The factory's
  `.gitignore` lets delivered build output be committed.
- `factory author <task-kind>`: the Architect drafts, the factory assigns a
  unique id and checks the profile, APB creates, validates and trials, the
  Critic reviews, APB approves; a trial past its deadline is found and
  stopped.
- An HTTP practice spec and one demo spec with two independent commands
  (the parallel proof), a forced-cutoff
  smoke, a joint hidden-run dry run; the e2e script gets a minimal HTTP
  example check; README "Running the factory" and one demo
  walkthrough.

- macOS readiness: the live demo (and possibly the hidden run) runs on the
  owner's Mac. A portability audit of `src/` and `scripts/` for Linux-only
  assumptions on the demo and hidden-run paths, `factory doctor` passing on
  the Mac, one demo run and one hidden-run dry run there (done by an agent
  on the Mac from a prompt we write), and a README "macOS setup" section.
- The brain's primary provider becomes Claude through the JigJoy Anthropic
  gateway when `JIGJOY_ANTHROPIC_BASE_URL` and `JIGJOY_ANTHROPIC_API_KEY`
  are set, with Z.ai as fallback; this lands in M1, and this change only
  rehearses with it.

Out of scope (deferred, see the decision record): several specs in one
process, terminal lanes, replay, resume, stop and replace commands, per-run
workspace namespacing, provoked-failure drills, limit tuning, a
clean-install rehearsal, a venue drill beyond one rehearsal. The HTML report
stays deferred unless the external agent's branch lands unchanged.

## Capabilities

### New Capabilities

- `platform-support`: the factory on Linux and macOS.
- `hidden-run`: the script from the hidden specs to committable packages in
  `hidden/`.
- `playbook-authoring`: the brain authoring, trialling and approving an APB
  playbook with no human.

### Modified Capabilities

- `factory-cli`: the cutoff and task concurrency options, the author
  command.
- `factory-orchestration`: active cutoff; delivery copy before
  verification; rebind limited to the `claude` profile.
- `acceptance-checks`: checks under Node; build before tests.
- `run-trace`: executor-run overlap in the report.
- `brain-decisions`: the Critic's playbook review.
- `apb-executor`: finding and stopping a playbook's trial runs.
- `end-to-end-run`: HTTP spec, demo spec with parallel tasks,
  forced-cutoff smoke, HTTP example check, build before tests.

## Impact

Layers: `domain` (review decision, authoring trace events), `ports`
(`Brain.reviewPlaybook`, `PlaybookAuthoring.stopTrials`), `application`
(authoring use case, delivery order, rebind guard), `adapters`
(`check-runner`, `report-markdown`, `hands-apb`, `brain-mozaik` prompt),
`cli` (`--cutoff`, `--task-concurrency`, `author`), shared helpers
(`domain/clock-time.ts`, `adapters/node-only-env.ts`), plus `scripts/`, `examples/specs/`,
`.gitignore` and `README.md`. The layer rule holds. No new dependencies
(the draft YAML is parsed with Bun's built-in YAML support).
