# factory-layer: design

Date: 2026-10-30. Status: approved by the owner (after a builder check
and review rounds 1-3 with Codex gpt-6.1-sol, final verdict: ready to build).

## 1. Intent

`factory-layer` is a software factory: it takes a one-page product spec and
autonomously produces a small TypeScript project (CLI or HTTP API) whose tests
pass. It is the owner's entry to the JigJoy hackathon, Software Factory track
(submission deadline 2026-10-31 20:00 CET; hidden specs are published
2026-10-31 18:00 CET and the factory output goes to `hidden/<spec>/`).

The idea: **a brain and hands**.

1. The brain is a team of concurrent Mozaik agents (`@mozaik-ai/core`). It
   reasons: plans the work, derives acceptance checks, judges results,
   chooses recoveries, and authors new playbooks for repeating kinds of work.
2. The hands are APB (agentic-playbooks, `apb`), the owner's existing playbook
   runner. It executes the coding work through agent CLIs (Claude Code,
   Codex) with retries, profile fallbacks and a journaled event log.
3. The memory is OSB (open-second-brain), the owner's persistent memory vault.
   The published Mozaik 4.2.0 (npm, verified in its `dist/index.d.ts`) keeps
   agent context in process only; nothing persists across runs. Mozaik's
   unreleased git main is moving to a pluggable memory with a mem0
   implementation, so we do not compete with upstream memory: OSB is exposed
   to the brain through a `Memory` port of our own.

Why: a thin reasoning layer on top of a robust execution engine
gives a factory that is autonomous, recoverable, observable, and improves with
use (memory of past runs, new playbooks).

## 2. Goals

1. One command turns a spec into a tested TypeScript project with zero human
   interventions in the happy path.
2. At least two Mozaik agents reason genuinely concurrently, with clear roles
   and shared state, and the trace proves the overlap.
3. Failures are handled by the factory (retry with a hint, rebind, repair run,
   re-plan) before a human is ever asked.
4. Every run produces a trace: per task wall time, attempts, models, tokens
   and cost (measured, estimated or unavailable, never invented), critic
   verdicts, published playbooks, and an intervention log.
5. The brain can author, validate, trial and publish a new APB playbook with
   no human approval (the brain is the approver; the decision is journaled).
   Required scope: one rehearsed create, trial, approve example.
6. A polished live demo at the venue.

## 3. Non-goals

1. No coding agent on Mozaik. Code is written only by APB nodes.
2. No changes to APB. Everything goes through its public MCP surface
   (`apb mcp`, stdio). A gap is noted for a separate APB change, not patched.
3. No everyday-life or business showcase cases.
4. The EINSTEIN track case only if time remains after milestone M4.
5. No hosted service, no web UI of our own beyond a generated report.
6. No use of the JigJoy desktop app or Mozaik Cloud.
7. No persistence of Mozaik agent contexts across restarts (no supported
   restoration path in 4.2.0).

## 4. Anti-goals (failure even if it technically works)

1. The core imports Mozaik. Mozaik lives only in its adapter behind the
   `Brain` port.
2. "Concurrency" that is really sequential.
3. Hidden human steps: any manual action during a run that is not logged.
4. Internal notes in the public repo.
5. A demo that depends on luck: no rehearsed spec, no offline fallback.
6. A run that hangs: every wait has a deadline.

## 5. Constraints

1. Mozaik is mandatory, at least two concurrent agents. Pin npm 4.2.0 and
   code against its published `dist/index.d.ts` (`defineRuntime`,
   `createAgent`, `RuntimeState`, `sendEvent`, `runLoop`,
   `OpenAIChatCompletions`, `AnthropicMessages`). The GitHub main branch has
   diverged (peers, policies, a network server); never use it as reference.
2. Mozaik's MCP client is HTTP-only. APB and OSB speak MCP over stdio, so the
   factory ships its own stdio MCP client (official MCP TypeScript SDK,
   `StdioClientTransport`) used by the application layer. Where an agent
   needs a capability as a tool, the Mozaik adapter wraps a port method as a
   function tool `{ type: "function", name, description, strict: false,
   parameters, invoke }` (`strict` is mandatory in 4.2.0).
3. Brain model: GLM-5.3-Flash on the Z.ai coding plan, OpenAI-compatible base
   URL `https://api.z.ai/api/coding/paas/v4`, model id `glm-5.3-flash`, key
   `ZAI_API_KEY` (env `ZAI_API_KEY`, `ZAI_BASE_URL`, `ZAI_MODEL`; same as
   jeex-studio). Wiring: an entry in `inferenceRunnerConfig.supportedModels`
   with `new OpenAIChatCompletions(undefined, { baseURL, apiKey })` and a
   model specification typed through the exported `InferenceRunnerConfig`
   (`ModelSpecification` itself is not exported). Fallbacks, config only:
   Z.ai's Anthropic-compatible endpoint via `AnthropicMessages`, then a
   second provider key. Z.ai daytime limits are smaller than at night and the
   hidden run is 18:00-20:00, so provider cooldown and fallback are built in.
   First task of implementation: a live smoke that GLM-5.3-Flash does
   function calling through this adapter.
4. Hands: APB in `cli` execution mode only. The spawned `apb mcp` gets
   `APB_EXECUTION=cli` and the project `.apb/config.yaml` sets
   `execution: { fallback_to_host: false }`: the factory has no host agent, so
   an unexpected `pending_tasks` is classified as an executor failure, never
   waited on and never answered. Profiles: Claude Code primary, Codex
   fallback.
5. Public GitHub repo (track requirement); the README is judged.
6. English only in the repo. No em-dashes, no exclamation marks in docs.
7. Owner rules for every change: modular code, SOLID and DRY, fix what you
   find in the same change, commits only with the owner's approval, no AI
   co-author trailers, nothing leaves the machine (push, publish) without
   the owner's per-action approval, no Tailwind anywhere.

## 6. Architecture

### 6.1 Layers (enforced by dependency-cruiser)

A module may import its own layer or a lower one, never a higher one.

1. `domain`: pure types and rules. Spec, AcceptanceCheck, Plan, Task (DAG
   node: id, revision, dependencies, owned paths), TaskState, Verdict,
   RecoveryChoice, PlaybookRef, Intervention, TraceEvent, Usage (measured,
   estimated or unavailable). No IO, no SDKs. Zod schemas at every boundary.
2. `ports`:
   2.1. `Brain`: typed decisions only, no orchestration.
        `plan(spec, recalled) -> Plan`,
        `deriveAcceptance(spec) -> AcceptanceCheck[]`,
        `judge(task, result, checks) -> Verdict`,
        `chooseRecovery(task, failure, history) -> RecoveryChoice`,
        `proposePlaybook(taskKind, examples) -> PlaybookDraft | none`.
        Implemented by `brain-mozaik`.
   2.2. `Executor`: start a supervised APB run, wait for its events with a
        deadline, append supervisor context, retry or rebind a node, start a
        repair run, read events, usage and report. Implemented by
        `hands-apb`.
   2.3. `PlaybookAuthoring`: list, get, create, validate, trial, approve.
        Implemented by `hands-apb`.
   2.4. `Memory`: remember a run outcome, recall similar runs and playbook
        fitness. Implemented by `memory-osb`.
   2.5. `TraceSink`, `Clock`, `CostTable`, `Workspace` (git operations for
        task trees, see 6.4).
3. `application`: owns the factory state machine. The single writer of task
   state: dependency readiness, dispatch, concurrency caps, budgets and
   deadlines, idempotent dispatch keyed by task id and revision, integration,
   acceptance verification, restart reconciliation. It calls `Brain` for
   decisions and never knows how the brain reasons. Use cases:
   `RunFactory(spec)`, `ReplayRun(trace)`, `Doctor()`,
   `RecordIntervention(run, note)`.
4. `adapters`: `brain-mozaik`, `hands-apb`, `memory-osb`, `mcp-stdio` (shared
   stdio MCP client with request timeouts), `workspace-git`, `trace-fs`,
   `report-html`.
5. `cli`: composition root and commands; the only place that picks adapters.

Only `brain-mozaik` imports `@mozaik-ai/core`; the composition root wires it
to the `Brain` port.

### 6.2 The brain: Mozaik agents on one bus

Inside `brain-mozaik`, all agents join one Mozaik runtime with a shared
`RuntimeState`. Each `Brain` method is one decision attempt on the agent
that owns it: a loop with the role's prompt and a submit tool built for
that attempt from the decision's Zod schema. The answer arrives as the
model's call of that per-attempt submit tool, not as a `sendEvent`: the
tool validates the arguments (invalid ones go back to the model with the
Zod message), a valid submission settles the attempt's promise once, and
the next inference is replaced by a final message so the loop ends. A step
cap and a loop that ends without a submission fail the attempt. The caller
(the application) bounds and retries each decision.

Loop lifecycle contract (`runLoop` returns `void` and the published runtime
does not await or catch the loop promise):

1. Attempt correlation: every attempt has its own submit tool and settles
   exactly once, so a late submission of a cancelled or timed-out attempt
   cannot answer a newer one.
2. Guarded inference: the adapter installs its own `InferenceRunner` (via
   `inferenceRunnerConfig.runner`) wrapping `DefaultInferenceRunner` with a
   per-call deadline, provider fallback, and a cancellation check: once an
   attempt is cancelled or timed out, its next inference throws a
   cancellation error, so the orphaned loop stops at its next step.
   The published runtime calls both `run(input)` and `stream(input)` of
   the configured runner, so the guard wraps both. Cancellation is
   cooperative: it bounds the caller's wait and stops later inference, it
   does not abort a provider request already in flight.
3. Guarded tools: every function tool `invoke` catches and times out, and
   returns an error result instead of throwing.
4. Process guard: an `unhandledRejection` handler attributes the rejection
   to its attempt when possible, fails that attempt's pending promise, and
   never crashes the factory.
5. A failed or timed-out decision is retried per 6.6.2; after that the
   application takes the deterministic default (accept nothing, mark the
   task failed, or keep the current plan).
6. The M0 smoke covers a provider error and a timeout, not only success.

Roles (three LLM agents; Recorder is deterministic code, not an agent):

1. **Architect**: `plan` (with recalled memory) and `proposePlaybook`.
2. **Acceptance analyst**: `deriveAcceptance`: black-box checks from the
   spec (exports, CLI arguments, stdout and stderr, exit codes, HTTP routes,
   status codes, validation and edge cases).
3. **Critic**: `judge` and `chooseRecovery`, one loop per finished task, so
   several Critic loops overlap while tasks finish in parallel.

Guaranteed overlap, by construction: at run start `plan` and
`deriveAcceptance` run concurrently on the same spec; during execution Critic
loops for different tasks overlap. The adapter records each loop's start and
end so the trace shows overlapping intervals.

### 6.3 The hands: APB

1. The factory repo carries its APB project config under `.apb/`
   (`config.yaml` with `fallback_to_host: false`, playbooks, profiles).
2. Starter playbooks, approved once during setup: `scaffold` (package
   skeleton that runs under both `npm test` and `bun test`), `implement-task`
   (code plus unit tests for the owned paths), `repair` (fix given failing
   checks), `integrate` (resolve a merge conflict). Brain-authored playbooks
   are approved by the Critic via `playbook_approve`, journaled in the trace.
3. Every task run starts with `supervise: "self"`; the adapter keeps the
   supervisor token and drives `supervisor_wait_event` in slices with a
   deadline (MCP request timeout longer than the slice). Recovery while the
   run is live: `supervisor_context_append` + `supervisor_node_retry`, or
   `supervisor_rebind_profile`. Criticism after a run finished: a fresh
   `repair` run on the same task tree, never a retry on a finished driver.
4. One `apb mcp` process rooted at the factory repo serves all runs.

### 6.4 Workspace: task trees and integration

1. Each spec gets its own git repository under `work/<spec>/` (git-ignored,
   inside the factory project, so APB accepts it as a run worktree); branch
   `main` holds the integrated state.
2. The application (`workspace-git`) creates one git worktree per task from
   the current `main` (`work/<spec>/.trees/<task>-r<revision>`) and passes it
   as the run's worktree. APB never creates trees.
3. File ownership: every task in the Plan declares the paths it owns; the
   Architect's plan is rejected (re-plan) if owned paths overlap between
   tasks that can run in parallel.
4. Integration: an accepted task's branch is merged into `main` in task
   order; a conflict starts an `integrate` run; after every merge the unit
   tests and the acceptance checks run on `main`.
5. Delivery: from a clean copy of `main` (no `node_modules`): install, build,
   unit tests, acceptance checks under both `npm test` and `bun test`. Only
   then is the tree (without `.git`) copied to `hidden/<spec>/` (or
   `out/<spec>/` for practice runs).
6. Rehearsal requirement: two independent tasks reaching one tested
   deliverable.

### 6.5 Memory: OSB

`memory-osb` implements `Memory` over OSB's MCP server (stdio). The
application remembers outcomes at run end; the Architect receives recalled
runs as input to `plan`. A dedicated vault for the factory; never the owner's
personal notes.

### 6.6 Limits and restart (initial values, tuned after rehearsal)

1. Concurrency: at most 3 APB task runs at once per spec, 4 in total;
   `max_parallel` 2 inside a run.
2. Brain call deadline 90 s, 2 retries, then provider cooldown and the
   fallback model: 60 s after a rate limit, outage or timeout, 30 min after
   a refused key or an exhausted balance.
3. Task budget: 3 attempts (initial + 2 recoveries), then re-plan once, then
   the task is marked failed and the run continues with what passes.
4. Supervisor wait slice 60 s; a task run with no event for 10 min is
   interrupted and treated as an executor failure.
5. Per-spec cutoff: on the hidden run, delivery starts no later than 19:20
   CET with whatever passes.
6. Restart: the run state file (`runs/<id>/state.json`, git-ignored,
   written atomically with mode 0600) persists the task-to-APB-run mapping,
   revision, event cursors and the raw supervisor tokens (APB keeps only
   their fingerprints, so the token must be ours to keep); a restarted
   factory reconciles live detached runs instead of starting duplicates.

### 6.7 Trace, cost, interventions

1. Per run `runs/<run-id>/trace.jsonl` with correlated ids (factory run,
   spec, task, revision, agent loop, APB run, node, attempt), plus a
   generated report (HTML and Markdown).
2. Includes failed attempts and retries, actual models, elapsed times, and
   usage marked measured, estimated or unavailable. Unknown stays unknown.
3. `factory intervene --run <id> "<note>"` appends a timestamped human
   intervention; submission approvals (the push) are recorded as
   interventions too.

### 6.8 Hidden specs

Facts from the track page: one or two Markdown specs published 18:00 CET,
output pushed to `hidden/<spec name>/`, acceptance tests run on the last push
at 20:00. Test command and runtime are not stated: the generated package
defaults to `npm test` and `bun test` compatibility, and any convention the
released spec states wins. Several specs run concurrently as separate factory
runs. Playbook authoring stays off the hidden-run path unless the plan needs
it.

## 7. CLI

1. `factory run <spec.md> [--out <dir>]`: the pipeline with live terminal
   lanes (agents and task runs).
2. `factory doctor`: keys, the brain model's function calling, `apb` version
   and MCP handshake, agent CLI authentication, OSB MCP handshake, APB
   dashboard.
3. `factory replay <runs/<id>>`: replays a recorded trace (demo fallback).
4. `factory report <runs/<id>>`.
5. `factory intervene --run <id> "<note>"`.

## 8. Demo (live, at the venue)

1. Terminal: `factory run demo/spec.md` with lanes.
2. Browser: the APB dashboard with the runs executing.
3. The generated report.
4. A rehearsed demo spec that finishes in a few minutes, a recorded run for
   `factory replay`, and the playbook authoring example.

## 9. Milestones (CET, time-boxed)

1. M0, Fri 15:00: repo scaffold and tooling; smoke of the three adapters
   (GLM function calling, `apb mcp` supervised run, OSB MCP).
2. M1, Fri 22:00: one practice spec end to end (sequential allowed).
3. M2, Sat 10:00: parallel tasks, integration, recovery, trace.
4. M3, Sat 14:00: clean-install rehearsal, README with a fresh-machine
   walkthrough, demo spec, replay, the authoring example.
5. M4, Sat 17:00: freeze.
6. Hidden run: 18:00 start, 19:20 delivery cutoff, 19:30 owner-approved
   submission checkpoint (commit and push, then verify the remote commit
   contains every `hidden/<spec>/`).

Cut order if late: replay, HTML report (keep Markdown), OSB recall (keep
remember). The minimal authoring example (one create, trial, approve) is not
cut.

## 10. Repository and AI tooling

Location: `~/projects/tools/factory-layer`.

1. Stack from `jeex-player`: Bun, its strict tsconfig, `oxlint --type-aware
   --deny-warnings`, `oxfmt`, `bun test`, dependency-cruiser (layer rule,
   `KNOWN_VIOLATIONS` empty), knip, code-ranker, size check (400 warn, 700
   hard), a JSDoc header per module, Zod at boundaries, exact versions.
2. `scripts/check.sh fast|standard|full`: fast = typecheck, lint, format,
   size, arch, dead code, changed unit tests; standard = all unit tests with
   coverage floors, build; full = integration tests against real `apb mcp`
   and OSB, the brain smoke, code-ranker, `bun audit`.
3. Pre-push: the global `dev-quality-cycle` skill.
4. OpenSpec: `openspec/` with the `spec-driven` schema; `openspec-*` skills
   and `/opsx:*` commands from JEEX.
5. `AGENTS.md` is the single source; `CLAUDE.md` only imports it. Project
   skill `factory-layer-project` (adapted from `jeex-project`), tooling
   skills `bun`, `oxlint`, `oxfmt`, `lefthook`, `zod`, `unslop`.
6. `docs/private/` is git-ignored (internal notes).
7. README: pinned versions of APB and OSB, exact startup and config, trust
   bootstrap (`apb` approval of the starter playbooks), credentials, a
   fresh-machine walkthrough.

## 11. Decided by the owner

1. Track: Software Factory.
2. Mozaik brain, APB hands, OSB memory; APB is not changed.
3. No Mozaik coding agent.
4. The brain publishes playbooks itself, no human approval.
5. Mozaik stays inside its adapter behind the `Brain` port.
6. Name `factory-layer`, TypeScript, OpenSpec, JEEX-style checks.
7. Live, full demo at the venue.
8. Brain model GLM-5.3-Flash.
9. No everyday or business cases; EINSTEIN only if time remains.
10. The design is reviewed by Sol (Codex gpt-6.1-sol) to consensus.

## 12. Calls made by the designers (owner may override)

1. Not building on Baro.
2. Three LLM roles (Architect, Acceptance analyst, Critic); Recorder and
   Librarian duties are deterministic application code.
3. The application owns orchestration; the brain only decides.
4. Per-spec git repo under `work/` with per-task worktrees.
5. APB `cli` only, host fallback off; Claude Code primary, Codex fallback.
6. Limits in 6.6 and milestones in 9.
7. Report as generated Markdown and HTML.

## 13. Left to the builder

1. Exact playbook YAML and profile contents (`playbook_howto`).
2. The terminal lane rendering library.
3. OSB MCP command line and vault location.
4. Price table values.
