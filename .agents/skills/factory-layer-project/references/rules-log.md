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
