# Design

## Context

See proposal.md and the decision record
`docs/superpowers/specs/2026-10-30-hackathon-scope.md`. This change starts
from the M1 merge commit on `main`. Facts from M1 it relies on:

1. `RunFactory.run` with `cutoffAtMs` and an abort signal; `--out` is the
   exact delivery directory; run options include `runTaskConcurrency`.
2. The cutoff today is passive: the scheduler awaits its active task
   runners, `supervise` checks stalls and aborts but not the cutoff, so a
   task that keeps emitting events runs past the cutoff, and delivery may
   start after the hidden-run script's hard deadline.
3. `src/adapters/child-env.ts`: `generatedCodeEnv`, `gitEnv`,
   `withScratchHome`; installs use `--ignore-scripts`.
4. `src/adapters/check-runner/process.ts`: `runCommand`,
   `killLiveProcessGroups`; `scripts/e2e-process.ts`: `createDeadline`,
   `remainingMs`, `runBeforeDeadline`, `tail`.
5. Task trees stay under `work/` because APB requires it.
6. The brain's primary provider is Claude through the JigJoy Anthropic
   gateway (Mozaik 4.2.0 `AnthropicMessages` with `{ baseURL, apiKey }`)
   when `JIGJOY_ANTHROPIC_BASE_URL` and `JIGJOY_ANTHROPIC_API_KEY` are set,
   Z.ai GLM-5.3-Flash the fallback (M1). The gateway is configured; a
   probe shows `claude-sonnet-4-6` and `claude-haiku-4-5` answering, and
   `claude-sonnet-5-5` and `claude-opus-5-5` returning 503 ("not available
   on Mozaik Cloud yet"). The brain uses `claude-sonnet-4-6`. The `ANTHROPIC_*` names are never
   used, because Claude Code, the coding agent, would pick them up.
7. Development is on Linux; the live demo and possibly the hidden run run
   on the owner's Mac (macOS, Apple Silicon assumed) with APB, OSB, Claude
   Code and Bun installed by the owner.

## Goals / Non-Goals

**Goals:** a hidden run that leaves a Node-runnable, committable package
for every spec before the owner's push; the minimal authoring
example; one demo spec that also proves parallel task runs; a README the
jury can follow.

**Non-Goals:** everything the decision record defers.

## Decisions

### D1. Active cutoff (application)

The run owns a cutoff timer. When it fires, the run aborts a cutoff
controller that every task runner, every executor wait slice and every
pending decision observes; the scheduler stops awaiting runners and calls
`stopAllLive` (each live executor run stopped with the 60 s confirmation,
in parallel; an unconfirmed one traced as abandoned and left), then
delivery. Results that arrive after the cutoff are discarded and traced.
A forced-cutoff smoke on the real adapters proves it.

### D2. Delivery copy before verification (application)

With `deliverUnverified`, `delivery.ts` copies the clean `main` (without
`.git` and `node_modules`) to the output directory first, then verifies.
The hidden-run script then builds in place (D6), because the copy holds no
build output.

### D3. Shared helpers (ours)

1. `src/domain/clock-time.ts`: `parseClockTime(value: string, now: Date):
   number` (ISO 8601 with a zone, or `HH:MM` local today; throws
   `RangeError` for garbage or a time not after `now`). Used by `--cutoff`
   and the hidden-run script.
2. `src/adapters/node-only-env.ts`: `nodeOnlyEnv(home: string, extra?:
   ChildEnv): ChildEnv`, which is `generatedCodeEnv` with `PATH` set to one
   filtered tool directory: a temporary directory (created once per
   process, removed at exit) of symlinks to `node`, `npm`, `npx`, `git`,
   `sh`, `bash`, `env` and the core utilities a package script may call
   (`NODE_ONLY_TOOLS` in the module: `awk`, `basename`, `cat`, `chmod`,
   `cp`, `cut`, `date`, `diff`, `dirname`, `echo`, `false`, `find`,
   `grep`, `head`, `ln`, `ls`, `mkdir`, `mktemp`, `mv`, `printf`, `pwd`,
   `rm`, `sed`, `sleep`, `sort`, `tail`, `tee`, `test`, `touch`, `tr`,
   `true`, `uname`, `uniq`, `wc`, `which`, `xargs`), each resolved from the
   factory's `PATH` (absolute entries only, first executable file wins),
   and never `bun` or `bunx`: a candidate whose real path is a file named
   `bun` or `bunx` (a `node` shim that is Bun) is skipped for the next one.
   Removing whole directories is not enough: Homebrew puts `bun`, `node`
   and `npm` in the same `/opt/homebrew/bin`. A tool not found is left out.
   `toolDir(path: string): string` builds the directory for one `PATH`
   value (once per value per process) and is exported for tests.
   `nodeOnlyEnv` sets `PATH` last, so an `extra` `PATH` is replaced; a
   caller that needs more commands prepends its directory to the result.
   Used by the check runner (CLI, command and HTTP checks, the `npm`
   package steps), the e2e verification (`npm` steps and examples) and the
   hidden-run script.
3. `scripts/e2e-process.ts` stays the process helper set for scripts.

### D4. Node launch and build before tests (check-runner, e2e)

CLI checks run `node <bin>`, HTTP servers `npm run start`, and every `npm`
step, all in `nodeOnlyEnv`. Package steps and `e2e-verify.ts` run install,
build when present, tests. The e2e script gets a minimal HTTP example
check: `npm start` on a free `PORT`, a TCP accept wait (15 s), each parsed
example with `fetch` (10 s), the group killed in `finally`.

### D5. CLI options and rebind guard

`--cutoff` on `parseClockTime` and `--task-concurrency` (the existing
`runTaskConcurrency` run option) in `src/cli/args.ts`. The recovery step
turns a rebind to any profile other than `claude` into a repair with the
same hint and a traced refusal.

### D6. Hidden run: two processes, two task runs each

The script starts one `factory run` per spec with `--task-concurrency 2`
(at most 4 Claude Code sessions for two specs), under a unique spec name
(`<name>-<HHMMSS>.md` copy, fresh `work/` repository) and `--out
hidden/<name>`. After the processes end or are killed at the hard
deadline, it replaces each delivery's `.gitignore` with `node_modules/`,
builds in place in a copy, lists ignored files as errors, and runs the
startup check on exactly the committable files. The factory's
`.gitignore` gets `!hidden/**` and `hidden/**/node_modules/` (ours).

### D7. Work split: the hidden-run wrapper goes to an external agent

The external agent (GLM-5.3-Flash through ZCode) gets only the wrapper,
its fake factory and their tests, in its own worktree on `feat/hidden-run`
from the M1 merge commit on `main` plus our group 1 (it starts once group 1
is merged, so the helpers below exist). It owns, and nobody else edits
until it is merged: `scripts/hidden-run.ts`, `scripts/hidden-run-steps.ts`,
`scripts/hidden-run.test.ts`, `scripts/hidden-run-steps.test.ts`,
`scripts/testing/hidden-fake-factory.ts`. We own the `.gitignore` lines,
the `package.json` script line, every file under `src/`, and the
integration. Authoring was rejected for the external agent (it touches
domain, ports, application, two adapters and the CLI).

Interfaces it may use, exactly:

```ts
// src/adapters/child-env.ts
export type ChildEnv = Readonly<Record<string, string>>;
export function gitEnv(): ChildEnv;
export function withScratchHome<T>(body: (home: string) => Promise<T>): Promise<T>;
// src/adapters/node-only-env.ts (ours, group 1)
export function nodeOnlyEnv(home: string, extra?: ChildEnv): ChildEnv; // PATH = filtered tool directory, no bun
export function toolDir(path: string): string; // the tool directory of one PATH value, built once per process
// src/domain/clock-time.ts (ours, group 1)
export function parseClockTime(value: string, now: Date): number;
// src/domain/spec.ts
export function specNameFromFileName(sourceFile: string): string;
// src/ports/check-runner.ts
export interface CommandOutcome { readonly exitCode: number | null; readonly timedOut: boolean; readonly spawnFailure: string | null; readonly stdout: string; readonly stderr: string; readonly elapsedMs: number }
// src/adapters/check-runner/process.ts
export interface RunCommandInput { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly timeoutMs: number; readonly stdin?: string; readonly env: ChildEnv; readonly secrets: readonly string[]; readonly signal?: AbortSignal | undefined; readonly termGraceMs?: number; readonly onOutput?: (chunk: Buffer, stream: 'stdout' | 'stderr') => void }
export function runCommand(input: RunCommandInput): Promise<CommandOutcome>;
export function killLiveProcessGroups(): void;
```

Interface it provides:

```ts
export interface HiddenOptions {
  readonly specPaths: readonly string[];
  readonly cutoff: string;               // passed to `factory run --cutoff`
  readonly hardDeadlineMs: number;       // epoch ms; factories get SIGTERM, SIGKILL after termGraceMs
  readonly reportByMs: number;           // epoch ms; every later step ends by then
  readonly repoRoot: string;
  readonly hiddenDir: string;            // default `${repoRoot}/hidden`
  readonly factoryCommand: readonly string[]; // default ['bun', 'run', 'src/cli/index.ts']
  readonly taskConcurrency: number;      // default 2
  readonly termGraceMs: number;          // default 30_000
  readonly git: (args: readonly string[], cwd: string) => Promise<string>;
  readonly write: (line: string) => void;
}
export interface StepOutcome { readonly ok: boolean; readonly detail: string }
export interface HiddenRow { readonly name: string; readonly factory: string; readonly delivered: boolean; readonly build: StepOutcome | null; readonly ignored: readonly string[]; readonly startup: StepOutcome | null }
export interface HiddenResult { readonly rows: readonly HiddenRow[]; readonly exitCode: 0 | 1 }
export function runHidden(options: HiddenOptions): Promise<HiddenResult>;
```

CLI: `bun run scripts/hidden-run.ts <spec.md>... [--cutoff HH:MM]
[--hard-deadline HH:MM] [--report-by HH:MM]` (configurable defaults 19:15,
19:22, 19:26); the `bun run hidden` alias is added by us at integration.

### D8. Minimal authoring

1. Domain: decision kind `playbook_review`; `PlaybookReview { verdict:
   approve | reject; reasons: string[] }` (at least one); trace events
   `authoring_started`, `authoring_step`, `authoring_ended { result:
   approved | rejected | none | failed }`.
2. Ports: `Brain.reviewPlaybook(draft, validation, trial, signal)`;
   `PlaybookAuthoring.stopTrials(playbookId, notBefore, deadlineMs)` over
   `runs_list`, `run_status`, `run_stop` (30 s per call); a capture comes
   first, and if runs cannot be attributed to the playbook no trial starts
   and the flow ends `failed`.
3. Application `author-playbook.ts`: `implement-task` YAML as the format
   example; draft (none ends `none`); `Bun.YAML.parse`; `id` set to
   `authored-<kind>-<suffix>-d<attempt>`; every node's profile `claude`;
   create (id checked); validate; one correction; trial (15 min); on
   timeout or the 30-minute flow deadline `stopTrials` and `failed`;
   Critic review; approve only when validation and trial passed and the
   review approves. `src/cli/author.ts` wires the command.
4. Attribution (decided from the capture, task 5.1): trial runs can be
   attributed. A model-free draft (start straight to finish) was created,
   trialled and deleted through `apb mcp`; the recordings are
   `tests/fixtures/apb/playbook_trial-succeeded.json`,
   `runs_list-trial.json`, `run_status-trial-succeeded.json` and
   `run_stop-terminal.json`. `runs_list` names each trial run with
   `playbook` equal to the draft id and `started_ts` (wall-clock ms) after
   the instant the trial call was made, and the run id is
   `<playbook id>-<ms>`. Because every draft attempt has its own id, the
   runs of `playbook == id` with `started_ts >= notBefore` are exactly that
   draft's trials. Two facts shape `stopTrials`: `run_status` of a run that
   has just succeeded can still report `driver_alive: true`, so a run that
   `runs_list` already shows terminal is reported `already_ended` without a
   stop; and `run_stop` on a terminal run answers `already_terminal`.
   Limit found in the first rehearsal: a trial of a playbook with
   `fs_write` runs in a throwaway worktree (`$TMPDIR/apb-trial-<id>-<ms>`)
   whose `.apb/runs/` holds the journal, so its run never appears in the
   project's `runs_list` and cannot be stopped through `apb mcp` while
   live. Such a trial is still bounded: the trial call's MCP timeout (15
   min) and the `apb mcp` process teardown when the authoring command
   ends; `stopTrials` then reports `no trial run found`, which the flow
   traces as an unconfirmed stop. The gap is written down for APB (list a
   worktree trial in the project's runs, or return its run id before the
   trial blocks).
5. Authoring policy (security): the brain's draft is untrusted, and the
   operator names the only input (a local example file, never a spec under
   a run). Before create, and again on the playbook APB returns before
   approve, a deterministic check allows only `start`, `finish` and
   `agent_task` nodes, every agent node on the `claude` profile, no
   connectors, workdir, isolation, interactive nodes, goal script checks or
   supervisor, and effects within those of the starter playbooks
   (`fs_read`, `fs_write`, `network`); params must carry defaults, since the
   trial passes only the example's instruction.

### D9. Readiness blockers

A failed HTTP delivery (task 3.2) or a failed hidden-script acceptance
(tasks 2.3 and 3.4) is a readiness blocker: the hidden run is not ready
until both pass. Everything optional (the executor overlap section, the
HTML report) gives way to them.

### D10. macOS readiness

1. Audit of `src/` and `scripts/` for Linux-only assumptions on the demo
   and hidden-run paths: `/proc`, a `setsid` binary, `pgrep` and `ps`
   flags, `sed -i`, `stat -c`, `readlink -f`, `timeout`, GNU `date`, bash 4
   features in `bash -c` strings (macOS ships bash 3.2), `/tmp` instead of
   `os.tmpdir()` (`$TMPDIR` on macOS), case-insensitive file names, process
   groups killed through `process.kill(-pid)` (works on both, `detached:
   true` needed), and the Node-only tool directory covering `~/.bun/bin` and
   `/opt/homebrew/bin` (the filtered tool directory of D3 handles
   both). Each finding on those paths is fixed with a test
   that does not depend on the platform; findings elsewhere are listed.
2. The Mac steps (doctor, one demo run, one hidden-run dry run) are done by
   an agent on the Mac from a ready-to-paste prompt we write; it reports
   back the outputs and every failure, and fixes come back here.
3. README "macOS setup": prerequisites (Homebrew or the official
   installers for Bun and Node, APB, OSB, Claude Code login), the same
   `.env`, `bun run apb:bootstrap`, `factory doctor`.

### D11. Gateway readiness

Gateway readiness is proven only by the gateway itself: one brain decision
with a tool call (a submit) answered by `claude-sonnet-4-6` through the
JigJoy gateway, and the Mac demo run with the gateway configured, both
recording the provider and model the usage records name. A run that
succeeds on the Z.ai fallback does not count.

## Risks / Trade-offs

- [Four concurrent Claude Code sessions still hit a rate limit] -> the
  joint dry run shows it; then the script passes `--task-concurrency 1`.
- [A factory killed at the hard deadline leaves APB runs live] -> accepted
  for the hackathon; they do not touch `hidden/`.
- [The external agent misses the brief] -> the orchestrator reviews the
  diff, runs the tests and the dry run before merging; if the branch is
  unusable, we finish the wrapper from the same brief.
- [A Linux-only call hides in a path the audit missed] -> the Mac demo run
  and dry run exercise both paths end to end before the demo.
- [Trial runs cannot be attributed] -> no trial; the authoring example
  fails visibly; the gap is written down for APB.
