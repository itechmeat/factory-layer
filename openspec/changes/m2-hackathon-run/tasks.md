# Tasks

The necessary scope in dependency order. Each group ends with `bun run
check:fast` green; unit tests are written test first, for failure paths
only. Readiness blockers: a failed HTTP delivery (3.2) or a failed
hidden-script acceptance (2.3, 3.4). Optional: 1.6 and group 7. Blocker for the live demo: 4.4.

## 0. Preconditions

- [x] 0.1 M1 is merged into `main` (the M1 merge commit), this branch is rebased onto it (including the JigJoy Anthropic gateway as the brain's primary provider; rehearsals run with it when configured), and `bun run check:fast` is green
- [x] 0.2 Gateway readiness (design D11): one brain decision with a submit tool call through the JigJoy gateway on `claude-sonnet-4-6`, provider and model recorded from the usage records (blocker)
  - proven in M1: `factory doctor` answered through `jigjoy/claude-sonnet-4-6` with a submit tool call, and the brain smoke recorded that provider and model; the Mac demo run (4.4) proves it again

## 1. Cutoff, delivery and Node-only (ours)

- [x] 1.1 Tests then code: active cutoff (timer, runners and waits aborted, live runs stopped in parallel with 60 s confirmation, late results discarded, delivery starts); verify with a fake-clock test where a task keeps emitting events past the cutoff
- [x] 1.2 Tests then code: with `deliverUnverified` the clean `main` is copied before any verification step; verify with a delivery test whose verification never ends
- [x] 1.3 Tests then code: `src/domain/clock-time.ts` (`parseClockTime`) and `src/adapters/node-only-env.ts` (`toolDir`, `nodeOnlyEnv` with the filtered tool directory of design D3); verify with tests where `node`, `npm` and a fake `bun` sit in one directory: a valid Node package starts, a Bun-only package fails, no `bun` or `bunx` link exists, the sentinel variable is absent
- [x] 1.4 Tests then code: check runner CLI checks as `node <bin>`, HTTP as `npm run start`, `npm` steps in `nodeOnlyEnv`; package steps and `e2e-verify.ts` build before tests; verify against fixtures (`"start": "bun src/server.ts"` fails, broken build fails the runtime)
- [x] 1.5 Tests then code: `--cutoff`, `--task-concurrency`, rebind guard; verify with the args and recovery tests
  - `--cutoff` and `--task-concurrency` are done (`src/cli/args.test.ts`); the rebind guard in `src/application/recovery.ts` refuses any profile but `claude` (`src/application/recovery.test.ts`)
- [x] 1.6 Tests then code (optional): `executorIntervals`, generic `overlappingPairs`, `## Executor runs` section; verify with the report tests
  - dropped as optional: the overlap evidence comes from the trace (3.3)
- [x] 1.7 Merge group 1 into `main` and send the hidden-run brief to ZCode (group 2); its base is `main` with the M1 merge and group 1
  - superseded: ZCode branched from `feat/m2` instead of `main`, so no separate merge was needed

## 2. Hidden-run path

ZCode owns, until merged: `scripts/hidden-run.ts`, `scripts/hidden-run-steps.ts`, `scripts/hidden-run.test.ts`, `scripts/hidden-run-steps.test.ts`, `scripts/testing/hidden-fake-factory.ts`. It uses only the interfaces of design D7. We own everything else.

- [x] 2.1 ZCode builds the wrapper from the hidden-run brief; meanwhile we add `!hidden/**` and `hidden/**/node_modules/` to `.gitignore` (verify with `git check-ignore` on a sample) and write the HTTP practice spec and the e2e HTTP example check (3.1)
  - our part is done: `.gitignore` has both lines plus `hidden/**/.env` (verified: `hidden/x/dist/cli.js` committable, `hidden/x/node_modules/a` ignored, `dist/` elsewhere still ignored); the ZCode wrapper landed untracked in this tree and was reviewed in 2.2
- [x] 2.2 Review the ZCode diff, run its tests and `bun run check:fast`, add the `hidden` script to `package.json`, merge; if the branch is unusable, finish the wrapper ourselves from the same brief
  - reviewed and fixed here, not sent back: a malformed `package.json` crashed the run before the table (now a failed step), the table cell showed the stack-trace tail instead of the error (now the head, full detail printed under the table), Ctrl-C left the detached factories running (first signal forwards SIGINT, second kills all), a spawn failure read `exit null`, stdout and stderr shared one line buffer, the cutoff was not checked against the hard deadline, CLI defaults were duplicated; tests added for the in-place build, the missing-import row, the CLI parsing and the signals (29 tests); `bun run hidden` in `package.json` and the README
- [x] 2.3 Forced-cutoff smoke: `factory run examples/specs/demo-units.md --cutoff <a time while tasks are still running> --deliver-unverified --out <scratch>`; live runs are stopped and the output directory holds the integrated `main` (blocker)
  - run `demo-units-20261030t204052z-e753`, cutoff at start +90 s with `format` in judging and three tasks pending: the judge call was aborted and its late verdict discarded, all four tasks failed with `cutoff`, the unverified copy of `main` (scaffold merged) landed 7 ms after `cutoff_reached` and the verified copy 3 s later, exit 3 `partial`; no executor run was live at that instant (both runs had ended and were released with a confirmed stop), so the live-stop path rests on the 1.1 fake-clock test

## 3. Rehearsals

- [x] 3.1 `examples/specs/notes-api.md` (HTTP) and `examples/specs/demo-units.md` (two independent commands, the demo and the parallel proof); tests then code for the e2e HTTP example check (fixture server, server that never listens); verify by parsing both specs' examples
- [x] 3.2 `bun run e2e examples/specs/notes-api.md` passes (blocker)
  - two rehearsals delivered a correct server (both runtimes pass, 13/13 examples, `--delivered` re-check PASS) but ended `partial` on wrong analyst checks (a header rule as a body substring; a `command` check using `curl` and `seq`); both fixed in the prompts (`CHECK_SHELL_RULES`, rule 11)
  - rehearsal 3: delivery correct again (13/13 examples), `partial` on a `command` check that started its own server (fixed: no background processes in check commands); rehearsal 4: `http-routes` failed after the Critic, reviewing HTTP checks in batches of five, dropped a `DELETE` whose earlier creates sat in another batch (fixed: HTTP checks reviewed in one ordered batch, analyst and Critic told the checks share one server)
  - rehearsal 5 passed (`succeeded`, 3m 14s, bun and npm pass, 13/13 examples) after the spec examples became authoritative: HTTP examples are example checks, failed derived checks are advisory while every example check passes
- [x] 3.3 `bun run e2e examples/specs/demo-units.md` passes in under 10 minutes with an overlapping executor pair in the report (or in the trace when 1.6 was dropped); keep its plain log and reports as the offline fallback
- [x] 3.4 Hidden dry run with both specs together: `bun run hidden` on `demo-units.md` and `notes-api.md` saved as `hidden-a.md` and `hidden-b.md`, with `--cutoff`, `--hard-deadline` and `--report-by` set relative to the start; both rows filled and the startup check passing; `hidden/` cleared afterwards (blocker)
  - dry run with `demo-units.md` and `wordfreq.md` (owner's choice of specs), brain on Z.ai, cutoff/hard deadline/report time at start +25/+30/+33 min: both rows delivered, built in place and passed the startup check under Node; wordfreq `succeeded` (exit 0), demo-units `partial` (exit 3, the `temp` task spent its budget) in 6 min 27 s; `hidden/` and both `work/` trees deleted

## 4. macOS readiness

- [x] 4.1 Portability audit of `src/` and `scripts/` (design D10.1); tests then code for every finding on the demo and hidden-run paths (including the tool directory with `~/.bun/bin` and `/opt/homebrew/bin` layouts); verify with the tests and `bun run check:fast`
- [x] 4.2 README "macOS setup" (design D10.3)
- [x] 4.3 Write the Mac agent prompt (Russian, git-ignored private notes): clone or update the repository, `bun install`, `.env`, `bun run apb:bootstrap`, `factory doctor`, one demo run of `demo-units.md`, one hidden-run dry run with the two practice specs, report every output and failure, no commits or pushes
- [ ] 4.4 The Mac agent runs the prompt; every failure is fixed here and re-run there until `factory doctor`, the demo run and the dry run pass on the Mac with JigJoy configured, recording the provider and model the demo run used (a fallback success does not count; blocker for the live demo)

## 5. Playbook authoring (after the hidden-run path is proven)

- [x] 5.1 Capture `runs_list` and `run_status` of one trial run into `tests/fixtures/apb/`; decide whether trial runs can be attributed (design D8.2)
- [x] 5.2 Tests then code: domain types and events, `Brain.reviewPlaybook` with the Critic prompt, `stopTrials` with a contract test, `author-playbook.ts`, `src/cli/author.ts`; verify with tests on the fakes
- [x] 5.3 Rehearsal: `factory author readme --example examples/authoring/readme-example.md` ends `approved` under its assigned id; record the run id
  - Run `author-readme-20261030t195637z-d755` approved `authored-readme-mvve7wt0-d1` (trial run `authored-readme-mvve7wt0-d1-1793390212375`); the first rehearsal `author-readme-20261030t195353z-3f58` ended `rejected` (the Critic asked for file contents a worktree trial cannot show)

## 6. README and demo walkthrough

- [x] 6.1 README "Running the factory": `doctor`, `run` with `--out`, `--cutoff`, `--task-concurrency`, reports, `author`, the hidden-run script and its configurable times (defaults: cutoff 19:15, hard deadline 19:22, report by 19:26), the trust model (task trees under `work/` because APB requires it, the allowlisted environment), the demo steps; no machine paths
- [ ] 6.2 One demo walkthrough on the Mac following the README: doctor, APB dashboard, a live run of `demo-units.md` (its acceptance: under 10 minutes, overlapping executor runs), reports, the authoring result, the offline fallback; problems fixed

## 7. HTML report (optional, last)

- [x] 7.1 Only if the report-html branch passes review unchanged and costs no review time: merge it and add an `html-report` delta (`/opsx:update`); otherwise record that it stays deferred
  - stays deferred: the report-html branch was not delivered for review

## 8. Delivery

- [x] 8.1 Full gate `bun run check` green and code-ranker clean
  - `check.sh: OK (full)`: 884 unit and 18 integration tests pass, code-ranker no violations, `bun audit` clean; `openspec validate --all --strict` 15 passed
- [x] 8.2 Report: rehearsal run ids, what failed, what was dropped
  - rehearsals: `notes-api` runs `...-db46`, `...-9e4b`, `...-7fde`, `...-4a44` ended `partial` on wrong derived checks with a correct server each time, run 5 `notes-api-20261030t201746z-20261030t201746z-de39` `succeeded` (3m 14s, 13/13 examples); `demo-units` runs `demo-units-20261030t195456z-20261030t195456z-a8bd` (kept as the offline fallback in `examples/replay/demo-units/`) and `demo-units-20261030t203637z-20261030t203637z-132c` both `succeeded` in about 3.5 min; hidden dry run `wordfreq-212539-20261030t202539z-f541` `succeeded` and `demo-units-212539-20261030t202539z-de3d` `partial`, both delivered and passing the Node startup check; authoring `author-readme-20261030t195637z-d755` approved `authored-readme-mvve7wt0-d1` after one `rejected` rehearsal; forced-cutoff smoke `demo-units-20261030t204052z-e753` `partial` as intended, delivery 7 ms after the cutoff
  - failed and fixed: analyst checks that tested headers as body text, used `curl`, `seq` or a background server (shell rules for checks); the Critic splitting ordered HTTP checks into batches (one ordered batch, one shared server); derived checks overruling a correct delivery (spec examples authoritative, derived checks advisory); the hidden dry run's `partial` (a check imported a function from the CLI entry and repair runs never saw the check command: imports only from exported entries, repairs get each failing check's invocation); the authoring Critic asking for file contents a trial cannot show (Critic told a trial shows paths only); the hidden-run wrapper defects listed under 2.2
  - dropped or deferred: 1.6 executor overlap section (the trace shows the overlap), 7.1 HTML report; open for the owner: 4.4 and 6.2 on the Mac

## Workflow follow-up

- Independent review of the diff, findings fixed, full gate again.
- Archive the change, then `openspec validate --all --strict`.
- The owner approves the commit.
