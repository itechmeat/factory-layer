# Design

## Context

See proposal.md for the motivation. The ports and the core come from change
`factory-core` (design D2: `Brain`, `Executor`, `PlaybookAuthoring`,
`Memory`, `TraceSink`, `RunStore`, `Workspace`, `CheckRunner`, `CostTable`,
`ExecutionSlots`). M0 delivered the stdio MCP client, the guarded inference
runner with attempt binding, and `followRun`/`stopAndConfirm`/
`recoverStart` for APB. Facts below were read from the published
`@mozaik-ai/core` 4.2.0 `dist/` and from live APB 1.0.0-beta.1 and OSB
1.96.0 answers (recorded, secrets redacted).

Mozaik 4.2.0:

1. `runLoop` returns nothing and nothing awaits or catches the loop; a runner
   error becomes an unhandled rejection (Bun prints it and later exits 1).
2. `runLoop` uses only `inferenceInput.context` and `inferenceInput.tools`;
   the agent's own instruction, tools and memory are ignored.
3. No step limit; only the first function call of a reply is executed, and
   every tool result is followed by another inference.
4. A tool's thrown error goes back to the model as text.
5. Concurrent loops on different agents and on the same agent work.
6. The optional per-call interception handler sees every transition and can
   replace the next state, which is the only per-call hook.
7. Each loop reads `.env` in the process directory for a Mozaik cloud key;
   with a key it sends the loop's events, prompts included, to the Mozaik
   cloud; without one it prints a warning per loop.

APB 1.0.0-beta.1:

8. `playbook_run` takes `params` as string to string, `worktree`,
   `supervise`; the token is returned only in that answer.
9. `supervisor_wait_event` takes the token (not the run id), `after_seq`,
   `timeout_ms`; wakes carry `node_failed`, `node_timeout`, `anomaly`;
   reviews, questions and host tasks arrive as reasons or `run_status`
   fields; `next_after_seq` may be null.
10. Supervisor commands answer `{posted_seq}` even for impossible requests
    and may be dropped later without an error.
11. `run_stop` answers `already_terminal`, `signaled_live_driver` or
    `finalized_dead_run`; a stopped run reports `aborted` and
    `driver_alive: null`.
12. Per-attempt usage exists only in `run_events` (`attempt_finished.usage`:
    input, output, cache read and write tokens, `cost_usd` when the agent
    reports it); `run_report` has the run total and `attempt_models` (model
    per attempt, often null, with the profile's `expected` model).
13. `runs_list` has no filters, inputs or worktree; `run_status` has the
    worktree.
14. No tool publishes an output schema.

OSB 1.96.0:

15. `brain_write_batch` with one `create_note` operation and a `request_id`
    is idempotent (a retry is reported `duplicate`).
16. `brain_search` with `match_mode: "any"` and `path_prefix` finds reworded
    queries; new notes are searchable about 2 s after the write.
17. A `type` frontmatter key fails the vault lint; refusals arrive as
    JSON-RPC errors with `data.code`, which the stdio client currently drops.

## Goals / Non-Goals

**Goals:** one practice spec delivered end to end with real adapters; every
adapter mismatch with the ports absorbed in the adapter; a `doctor` that
tells an operator what is wrong before a run.

**Non-Goals:** changes to `domain`, `ports` or `application` beyond the
amendment already made in `factory-core` D2d; concurrent specs in one
process (the shared slots exist, the CLI runs one spec); resume, replay and
the HTML report in the CLI.

## Decisions

### D1. Decision attempts (brain-mozaik)

`MozaikBrain` implements `Brain`. One runtime, three joined agents. A
decision attempt: create a `ModelContext` with the role's system prompt,
bind it to the guarded runner with the attempt deadline, build a submit
tool from the decision's domain schema (`toFunctionTool`, args validated;
invalid args return the Zod message to the model), and start `runLoop` with
the user message, the submit tool and an interception handler that (a) after
a valid submission replaces the next inference with a final model message,
(b) counts inference steps and stops at the cap, (c) detects a loop ending
without a submission. The attempt promise settles exactly once.

Attribution (fact 1): `runLoop` does not return its loop, so there is no
promise to catch. The guarded runner records every failure on the attempt
(with an unavailable usage record naming provider, model and reason) and
calls the attempt's failure callback, which settles the decision at once;
the runner then returns a synthetic final model message instead of
throwing, so the loop ends at idle with no unhandled rejection. A process
`unhandledRejection` handler stays as a safety net: it ignores errors
already attributed and logs the rest. An aborted `AbortSignal` cancels the
attempt the same way. The brain returns `{ decision, usage }`, failures
carry the usage recorded so far, and every usage record carries the
decision kind, which names the role (the domain record has no role field),
and the model the provider's answer named (`actual`) or the configured one
(`expected`), priced from the cost table.
The core traces the decision intervals; the brain does not trace.

Submit schemas are the domain schemas narrowed for the model: the plan's
playbook is `scaffold` or `implement-task`, and core-owned fields (ids are
the model's, revisions are not) are filled in by the adapter.

Fallback (deferred from M0): the runner's provider table holds primary and
fallback; a per-decision provider choice consults a cooldown map (provider
to `until`); a retryable error (`rate_limit`, `unavailable`, `timeout`)
marks the primary until now + 60 s. The `retry` of a decision (the core
retries up to 2 times) therefore lands on the fallback. The OpenAI client
inside the endpoint retries twice on its own and cannot be configured; the
attempt deadline bounds that, and the fallback test uses a fake endpoint. GLM thinking is switched off through the endpoint's
`extraBody` (`{ thinking: { type: "disabled" } }`), measured in the smoke.

Cloud guard (fact 7): construction checks `MOZAIK_API_KEY` and
`MOZAIK_PROJECT_KEY` in the environment and among the variable names of
the `.env` in the process directory (names only), and
`~/.mozaik/credentials.json`, and refuses. The
per-loop warning is filtered from the CLI's console output by exact prefix.

Prompts live in `src/adapters/brain-mozaik/prompts/` as plain strings per
role, each naming the submit tool and the decision's fields.

### D2. Executor and PlaybookAuthoring (hands-apb)

`ApbExecutor` implements `Executor` with one stdio client to `apb mcp`
(started from the repository root with `APB_EXECUTION=cli`). It keeps a map
run id to token (filled by `startRun` and `attach`) and registers every
token as a client secret. `startRun` writes the task text to
`.factory/task.md` inside the tree (the workspace excludes `.factory/` from
commits, `factory-core` D2d) and maps the typed inputs to string params per
playbook: `task_file`, `owned_paths` (one per line), `failing_checks`
(`repair`, one check id and reason per line), `conflict_paths` (`integrate`);
a start missing a declared param is refused before APB is called.
A parked run (a delivered node-failure wake, then `pending_supervisor` set)
maps to `quiet`; on `attach` a parked run with no delivered wake is reported
as its node failure. A dead `apb mcp` connection is replaced once and every
known run re-attached by token; then calls fail with a lost-connection
error. One session carries the waits of up to 3 runs concurrently (verified
in the capture, task 2.0). Mappings follow facts 8 to 13 as stated in the spec; schemas
for every answer live in `apb-run-schemas.ts` and are checked by contract
tests against the recorded answers under `tests/fixtures/apb/`.
`ApbAuthoring` implements `PlaybookAuthoring` (`playbook_list`, `get`,
`create`, `validate`, `trial`, `approve`), each call with an MCP timeout.

### D3. Memory (memory-osb)

`OsbMemory` implements `Memory` over `o2b mcp --config --vault` from the
environment: `remember` = `brain_create_note` under
`factory/runs/<spec>-<run id>.md` with `if_exists: "skip"` (idempotent, and
searchable at once; a `brain_write_batch` note waited for the 60 s index
refresh in a live probe), a JSON block in the body for the outcome (no `type`
frontmatter, fact 17); `recall` = `brain_search` (`match_mode: "any"`,
`path_prefix: "factory/runs/"`, limit), then read and parse each hit's JSON
block, skipping unparsable ones. The stdio client's `McpToolError` gains
the JSON-RPC `data.code` when present (additive).

### D4. CLI (composition root)

`src/cli/` parses arguments, loads `.env` values through `process.env` (Bun),
builds the adapters (brain, executor, authoring, memory, trace-fs run store
and sink, workspace-git, check-runner, cost table from a small price file,
system clock, shared slots), calls the core's `RunFactory`, prints events
from the trace sink as plain lines, and maps the outcome to the exit code.
`doctor` runs its checks concurrently, each with its own deadline. SIGINT
and SIGTERM trigger the core's cutoff path with an immediate cutoff time.

### D5. Agent profiles, starter approval, agent instructions and the practice spec

Profiles (owner decision 2026-10-30): the project ships one APB profile per
supported agent CLI, named after the CLI: `claude` (Claude Code, Sonnet 5.5,
no fallback), `codex`, `opencode`, `zcode`, `agy`, `grok`; no profile named
after a role. The starter playbooks default to `claude`, which is the only
agent used for the demo. `bun run apb:bootstrap --agent <cli>` republishes
the starter playbooks with that profile as their default (through APB's
`playbook_update`) and approves them, so an open-source user can run the
factory with any of these CLIs. The earlier role-named profile is removed.


Agent instructions: task trees live under the factory repository, and
Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from the working
directory and every directory above it up to the filesystem root, plus the
user's own `~/.claude/CLAUDE.md` (Claude Code docs, memory page). A coding
agent would therefore inherit the factory's own rules and the operator's
personal ones. The factory starts `apb mcp` with
`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` in its environment, which the agent
processes inherit (an APB profile's `process_env` only chooses which
variables are inherited and cannot set one), and that stops every CLAUDE.md
from loading; generated projects carry no CLAUDE.md of their
own, so nothing is lost. Project `.claude/settings.json` is read only from
the working directory, and skills stop at the repository or worktree root,
so the task tree (its own repository) does not pick up the factory's. Task
0.3 verifies this with a marker instruction in the factory's `CLAUDE.md`
path that the agent must not follow. Probe result (2026-10-30): a supervised
`implement-task` run of the `claude` profile in a task tree under `work/`,
with `work/CLAUDE.md` telling the agent to write a marker into its summary,
succeeded and its status-file summary carried no marker.


The four starters are approved by `playbook_approve` after a review of their
prompts and effects (the trial path needs the factory's own HEAD as the
tree, fact noted in M0), and `scripts/apb-bootstrap.ts` approves them on a
fresh machine. The end-to-end run (`tests/e2e/practice.test.ts`, run by
`bun run e2e`) is the real test of the starters. The practice spec is a
small CLI (for example a word-frequency tool) of the size and style the
track's hidden specs are expected to have; it names the command and requires
a `bin` that runs under Node. The end-to-end run is a script
(`scripts/e2e.ts`) with its own absolute deadline, using a unique spec name
per run. Prices for the cost table come from a small checked-in file
(`config/prices.json`, per model, input, output, cache read and cache write
per million tokens, with the date and source of each price); a reported
cost from the agent CLI wins over it.

## Risks / Trade-offs

- [factory-core lands late] -> group 0 waits for it; the order tonight is
  core, then executor and brain, then the CLI `run`, then the first
  end-to-end run; `doctor` (minimal), `report`, `intervene` and the memory
  recall smoke come after the first end-to-end attempt.
- [Model never calls submit] -> the step cap and `no_submission` end the
  attempt; the core retries and then takes the default.
- [APB drops a posted command] -> the core treats posts as accepted, not
  applied, and keeps following events; a stall ends in a stop and a repair.
- [End-to-end run cost and time] -> only on request; the report shows the
  per-task cost so the cost of a rehearsal is visible.
- [Mozaik warning noise] -> filtered by exact prefix in the CLI only.
