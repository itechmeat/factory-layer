# Rules log

Append-only. One line per learned rule: date, rule, what taught it.

1. 2026-10-30: `bunfig.toml` `coverageThreshold` takes the keys `lines` and
   `functions`; singular keys are silently ignored, so the floor is not
   enforced. Learned while scaffolding the gate (a floor set above the
   measured value still passed).
2. 2026-10-30: dependency-cruiser 18.7 does not support TypeScript 7; parse
   with `@swc/core` (`parser: 'swc'`) and accept the `missing-tsc-transpiler`
   warning. Learned while scaffolding the gate.
3. 2026-10-30: every change's OpenSpec artifacts are approved by Sol (Codex
   `gpt-6.1-sol`, read-only review) before implementation starts. Owner rule
   for all tasks, given at the first change (M0).
4. 2026-10-30: prefer few large commits, each through the full gate and the
   pre-push review cycle. Owner preference, given before the first commit.
5. 2026-10-30: the orchestrator consults Sol on technical choices and
   decides itself; Sol advises, it does not decide. Owner, when asked who
   implements M0.
6. 2026-10-30: every commit is authored by Sol Aitken
   `<solaiagent@gmail.com>` (GitHub `solaitken`). Owner rule given before
   the first commit.
7. 2026-10-30: the review cycle includes a `zg` duplication sweep and a
   clean code-ranker; CodeQL runs on GitHub. Owner request at the first
   delivery.
8. 2026-10-30: APB counts every script node as writing files (plus network
   and external effects), whatever the playbook declares, so a script
   playbook cannot be trialled before the repository's first commit; approve
   such playbooks with `playbook_approve` after reviewing their scripts.
   `apb profile write` on an existing profile needs `--expected-digest`
   (from `apb profile show`). Learned in the M0 APB setup.
9. 2026-10-30: while other agents edit the same tree, format only your own
   paths (`bunx oxfmt <paths>`), never `bun run format`, which rewrites
   every file under `src` and `tests`. Learned when the mcp-stdio agent
   reformatted the brain adapter mid-work.
10. 2026-10-30: add an adapter's `index.ts` re-exports only together with
    their first consumer; knip flags every unused re-export.
11. 2026-10-30: MCP SDK 1.32.2 sets `StdioClientTransport.pid` only after
    `start()` resolves and a failed `Client.connect` closes the transport
    and drops the process; capture the pid in a `start()` override.
12. 2026-10-30: lint idioms: compare `McpError.code` through a `number`
    constant (not the SDK enum, not `Number()`); narrow with `instanceof`
    instead of `expect.stringContaining` inside `toMatchObject`;
    `erasableSyntaxOnly` forbids constructor parameter properties.
13. 2026-10-30: Mozaik 4.2.0 does not export `FunctionTool`; use `Tool`.
    `z.toJSONSchema` adds a `$schema` key: drop it before using the result
    as tool parameters. The `openai` client inside Mozaik retries twice by
    default and cannot be configured: deadlines must allow for it.
14. 2026-10-30: in tests avoid `as` casts (`no-unsafe-type-assertion`): use
    real constructors, Zod `.parse` or `instanceof` helpers; test "no value"
    with an object spread (`undefined` triggers a parameter default); move a
    manual clock inside fakes instead of scripting a list of readings.
15. 2026-10-30: APB facts for the hands adapter: a supervised start answers
    with `supervisor_token` (redact before printing any raw answer); an
    untrusted start is a normal `policy_refusal` result, not an error;
    `run_stop` may answer `signaled_live_driver`, so wait for a terminal
    `run_status` with `driver_alive` not true; a deadline-capped request
    timeout can fire a millisecond early, classify it by the cap.
16. 2026-10-30: check for leftover processes by the test's own pid or a
    before/after diff, never a global `pgrep` (other sessions run `apb mcp`).
    A Zod `looseObject` union does not narrow with `in`: tag variants with
    `.transform`.
17. 2026-10-30: test doubles live in `src/**/testing/` and are excluded from
    the coverage floors; a test helper imported by a script counts toward the
    floors, so shared code belongs under `src/`. Learned when the full gate
    failed on a fake endpoint and a test helper used by the bootstrap script.
18. 2026-10-30: redact first, truncate second; map a raw Zod error from the
    MCP SDK to a validation error, not a connection error; sum every
    operation budget of a deadline-bound test, teardown included, and assert
    it fits.
19. 2026-10-30: end-to-end runs are the main gate; unit tests only for
    failure paths an end-to-end run cannot reproduce; happy-path unit tests
    are removed; no coverage floor. Owner decision after weighing
    "end-to-end only" against the failure-path argument.
20. 2026-10-30: APB `playbook_create` and `playbook_update` approve the
    version they save (`locally_approved`); after editing a starter
    playbook revoke that approval by digest (`apb trust revoke <digest>`)
    until its M1 trial. Learned publishing integrate 1.2.0 and 1.3.0.
21. 2026-10-30: coding agents run in trees under the factory repository, and
    Claude Code loads every CLAUDE.md up to the filesystem root plus the
    user's own; the `claude` profile sets `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` so
    neither the factory's nor the operator's instructions reach a generated
    project. Mozaik 4.2.0 also reads `.env` in the process directory for a
    cloud key and sends prompts to its cloud when one is found: the brain
    refuses to start with such a key.
22. 2026-10-30: Sol never blocks work: implementation starts after an
    independent Opus review, Sol reviews asynchronously when available.
    Owner correction after M1 was held for Sol's quota reset ("we are at a
    hackathon; delays lose").
23. 2026-10-30: reviews are done by fresh subagents without orchestrator
    context instead of Sol; Sol is optional. Owner instruction.
24. 2026-10-30: end-to-end children run in their own process group and are
    killed as a group at the deadline, or grandchildren survive it. Under
    Node 24 `node --test test/` fails (the directory is taken as a file):
    generated packages use plain `node --test`.
25. 2026-10-30: OSB 1.96.0 for run memory: write run notes with
    `brain_create_note` and `if_exists: skip` (idempotent, searchable in
    about 1 s), not `brain_write_batch` (indexed only by the 60 s refresh);
    `brain_search` content is cut at 600 characters, so recall uses
    `disclosure: "cards"` and reads each note with `brain_search_expand`; an
    empty answer has no `cards` key.
26. 2026-10-30: a Mozaik decision attempt is bound with `onFailure`, so the
    runner settles it and ends the loop with a final message instead of
    throwing (else the error becomes an unhandled rejection). Z.ai thinking
    off (`extraBody: { thinking: { type: "disabled" } }`) cut a short call
    from 7.5-10.7 s to 1.8-3.7 s. While agents work in parallel, run the
    `check:fast` steps one by one to see your own state.
27. 2026-10-30: APB profiles cannot set environment variables (`process_env`
    only selects what the agent inherits): variables for agents, such as
    `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, are set on the `apb mcp` process.
    APB cannot delete a single playbook version.
28. 2026-10-30: Tag exports waiting for a later change with `@pending` so
    knip skips them, and make testing barrels knip entries. Learned clearing
    the dead-code gate of the factory-core review.
29. 2026-10-30: Take model prices only from the provider's live pricing page
    or API, dated and with the source URL, never from a cached table. Learned
    filling `config/prices.json`: a skill's cached table disagreed with the
    live Anthropic page on Sonnet 5.5 cache reads.
30. 2026-10-30: acceptance `command` checks call the spec's command by name
    (`printf ... | wordfreq`), and a package's own `bin` is not on the PATH
    of its tree (agents cannot `npm link` outside it): the check runner puts
    a `node` shim per `bin` name first on the PATH. Learned in the first
    end-to-end attempt (every check exited 127).
31. 2026-10-30: plan defects seen end to end: a task used a module of a task
    it did not depend on; the scaffold stubbed modules (and owned whole
    `src`/`test`) that later tasks could then not change; the scaffold's
    toolchain mixed tsc NodeNext builds with Node type-stripped tests so no
    import specifier worked for both. Fixed by Architect rules 1, 7, 8, 9
    and one module convention in the starters (scaffold, implement-task,
    repair 1.2.0): ESM, `tsc` to `dist/`, `.js` import specifiers,
    `node:test` tests run by Node from `dist/` for `npm test` and by
    `bun test` from source with `bunfig.toml` `root = "test"`.
32. 2026-10-30: until the core's runtime re-plan (3.7) exists, recovery must
    not choose `replan`: the composition root gives the brain a re-plan
    allowance of 0, the recovery message says so, and a `replan` answer is
    downgraded to `repair` (failing checks named) or `retry` (failure as
    hint). Every failed task of the first four end-to-end attempts ended
    through the unavailable re-plan.
33. 2026-10-30: Test a crash point by freezing the run's process with
    `crashingPorts` (every port call of the crashed run waits forever) and
    resuming over the same fakes with `restartedPorts`; never let the first
    run keep calling the fake executor, whose `waitEvent` consumes events.
    The fake executor also serves a pushed event only at the end of the
    current wait slice (60 s), so time scripted events against slices.
    Learned writing the resume tests of task 3.12.
34. 2026-10-30: rule 32 is superseded: the core re-plans for real, so the
    composition root gives the brain the run's resolved re-plan budget
    (the recovery input does not carry it) and the core itself turns a
    `replan` chosen past that budget into a repair run with the failure as
    hint. Learned wiring the finished core: a re-plan the core started
    without asking the brain (spent attempts) was invisible to the brain's
    counter, and the core then re-planned past its budget.
35. 2026-10-30: every follow-up the core can dispatch must start on every
    starter playbook: a hint-only repair (an aborted run retried, a
    downgraded re-plan) has no failing checks, so the executor passes
    `failing_checks` as a line pointing at the task file instead of
    refusing the start for a missing param. Found by a review of the
    finished-run retry path.
36. 2026-10-30: acceptance checks must be self-contained and spec-true, and
    the Critic must not wave failing checks through: the Analyst creates
    any input file inside a `command` check under `mktemp -d`, loads an
    export by the `package.json` main path (never by the package name) and
    applies every spec definition before fixing a value; the Critic treats
    the spec's example messages as exact and accepts with failed checks only
    when each belongs to another task or contradicts the spec; the
    Architect quotes those messages in the task description. Learned when
    the first end-to-end run on the finished core ended `partial`: the
    Critic accepted the CLI task with five failed checks, three of them
    wrong checks.
37. 2026-10-30: give every generated-code and git process an allowlisted
    environment (`src/adapters/child-env.ts`), never `process.env`, and
    install with `--ignore-scripts`. Learned from the security audit: the
    provider keys reached every acceptance command.
38. 2026-10-30: keep the task trees inside the factory repository until APB
    accepts a worktree outside its project: `apb mcp` refuses a run worktree
    that is neither inside the project nor a git worktree of the project's
    own repository (`belongs_to_project`), so moving `work/` out needs an
    APB change first. Learned when the security audit asked for the move.
39. 2026-10-30: never let a model-derived acceptance check outvote the spec:
    the spec's own shell examples become checks deterministically
    (`spec-example-N`), every derived check quotes its spec passage in
    `source` (refused back to the model when not verbatim), a derived check
    that reruns an example with another expectation or draws the Critic's
    review objection is dropped and traced, and at delivery a failed
    derived check the Critic objects to is excused while every example
    passes. Learned when correct wordfreq deliveries ended `partial` on
    analyst checks that contradicted the spec (case, order, digits).
40. 2026-10-30: the task that implements a product's user-facing behaviour
    owns and wires its entry point (`bin` or server start file): Architect
    rule 10. Learned when a plan left `src/main.ts` to a later task, the
    Critic judged the CLI task by checks that run the unwired `bin`, and
    the task spent its attempts on work outside its owned paths.
41. 2026-10-30: never put a gateway key under an `ANTHROPIC_*` name in
    `.env` (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`): Claude Code and the
    Anthropic SDK read those names, so an agent session started in the
    repository would talk to the gateway with its key. The JigJoy gateway
    uses `JIGJOY_ANTHROPIC_BASE_URL`, `JIGJOY_ANTHROPIC_API_KEY` and
    `JIGJOY_ANTHROPIC_MODEL`. Learned when the brain moved to Claude via the
    JigJoy gateway.
42. 2026-10-30: no test exports Mozaik loop events to Mozaik Cloud: the
    preload `tests/support/no-cloud-export.ts` empties `MOZAIK_API_KEY` and
    `MOZAIK_PROJECT_KEY` (the cloud client takes an empty value as no key
    and stops looking in `.env` and the credentials file) unless
    `FACTORY_TEST_MOZAIK_CLOUD=1`. Every bunfig a test run uses carries the
    preload (`bunfig.toml` and `scripts/fast-bunfig.toml`). Learned when the
    full gate's integration smokes, run with `scripts/fast-bunfig.toml`,
    still printed Mozaik Cloud session links.
43. 2026-10-30: Mozaik 4.2.0's `AnthropicMessages` endpoint leaves
    `max_tokens` unset and the Anthropic messages API requires it: the
    factory wraps the endpoint mapper and sets it on every request
    (`ANTHROPIC_MAX_TOKENS` in `src/adapters/brain-mozaik/providers.ts`).
    Learned when the brain moved to Claude via the JigJoy gateway.
44. 2026-10-30: since OSB 1.96.0 a large tool result's text content is a
    preview envelope (`preview_truncated`, `artifact_id`) while
    `structuredContent` keeps the full payload, so the MCP client reads
    `structuredContent` first. A recall filter applies to the prefix it was
    written for: the legacy smoke-note filter skips `-smoke-<ms>.md` only
    under `factory/runs/`, never under the smoke prefix. Learned when the
    memory smoke stopped recalling its own note.
