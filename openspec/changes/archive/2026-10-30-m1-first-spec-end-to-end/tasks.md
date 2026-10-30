# Tasks

Test policy: the end-to-end run (group 6) is the main gate. Unit tests are
written test first and only for failure paths an end-to-end run cannot
reproduce on demand (deadlines, step caps, unattributed errors, fallback and
cooldown, refusals, lost connections, changed answer shapes, redaction).
Each group ends with `bun run check:fast` green.

Order tonight: group 0, then 2 and 1 in parallel, then 4.1 and 4.2, then
the first end-to-end attempt (6.2 and 6.3); 3, 4.3, 4.4 and 5.3 follow.

## 0. Preconditions

- [x] 0.1 `factory-core` (with its D2d amendment) is merged into `main` and this branch is rebased onto it; `bun run check:fast` green (the branch is rebased onto the finished core; its squash into `main` waits for the owner's commit approval)
- [x] 0.2 Practice spec under `examples/specs/` (small CLI, one page, names the command and requires a `bin` that runs under Node)
- [x] 0.3 Profiles: remove the role-named profile from `.apb/profiles/`; add one profile per supported CLI (`claude` with Sonnet 5.5 and no fallback, `codex`, `opencode`, `zcode`, `agy`, `grok`), the `claude` profile with `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` in `process_env`; republish the four starters with `claude` as default profile and drop their older versions that name the removed profile (through APB, if it allows; else note why); README, bootstrap and tests no longer name it; `apb validate` clean. Probe: one agent run in a task tree under `work/` with a temporary marker instruction in a parent `CLAUDE.md` (removed afterwards) shows the agent did not see it; record the result in design D5
- [x] 0.4 Review the four starter playbooks (prompts, effects, params) and approve them with `playbook_approve` (the implementer approves after the review; no owner wait); `apb trust list` shows them

## 1. Brain (`src/adapters/brain-mozaik/`)

- [x] 1.1 Cloud-key guard (environment, `.env` names, credentials file); failure-path tests
- [x] 1.2 Runner attribution: every failed call records an unavailable usage record and settles its attempt through a failure callback, and returns a synthetic final message instead of throwing; tests that a provider error settles the attempt at once with no unhandled rejection
- [x] 1.3 Decision attempt: fresh bound context, narrowed submit schema, interception handler (stop after submit, step cap, no submission), cancellation by `AbortSignal`; tests for invalid-then-valid submission, invented playbook, step limit, no submission, deadline, abort
- [x] 1.4 Fallback and cooldown, vendor fields with thinking disabled; tests for rate limit to fallback, cooldown expiry, non-retryable stays
- [x] 1.5 `MozaikBrain` implementing the `Brain` port with role prompts; role in usage records; process guard as safety net
- [x] 1.6 Brain smoke extended: one real `plan` and one `deriveAcceptance` on the practice spec, concurrently (at the decision level with the role prompts and a local schema; the port-level calls follow with 1.5)

## 2. Executor and authoring (`src/adapters/hands-apb/`)

- [x] 2.0 Live capture into `tests/fixtures/apb/` (tokens redacted): a model-free `smoke-fail` playbook (approved with the smokes) giving a `node_failed` wake, the parked status, an applied node retry and a stop; two overlapping waits on one session; one approve answer
- [x] 2.1 Zod schemas for every tool answer used; contract tests from the captures, including a dropped field failing with the tool's name
- [x] 2.2 `startRun`: task file, typed inputs to params per playbook, missing-param refusal, token map and secret registration, policy refusal, indeterminate start; tests
- [x] 2.3 `waitEvent` mapping (triggers, parked runs as `quiet`, reviews and questions, host tasks, terminal incl. aborted-after-stop as stopped, null cursor); tests from captures
- [x] 2.4 Commands (accepted with posted sequence), `stop`, `attach` (parked run reported as its node failure), `findRuns`, dead connection replaced once with re-attach; tests
- [x] 2.5 `report`: per-attempt usage with cache tokens and reported cost from the events, model with provenance from the attempt models; tests from captures
- [x] 2.6 `ApbAuthoring` as a pass-through over the playbook tools with MCP timeouts

## 3. Memory (`src/adapters/memory-osb/`, `src/adapters/mcp-stdio/`)

- [x] 3.1 `McpToolError` carries the JSON-RPC `data.code`; test with the fake server
- [x] 3.2 `OsbMemory.remember` (idempotent, repeated key treated as remembered) and `recall` (query cut to 2000 characters, any-term, de-duplicated, unparsable skipped), refusal without the vault variables; failure-path tests
- [x] 3.3 Memory smoke extended: remember then recall a reworded spec (allow for the indexing delay)

## 4. CLI (`src/cli/`)

- [x] 4.1 Composition root wiring every adapter and the core, cost table from `config/prices.json` (dated, sourced prices); argument parsing
- [x] 4.2 `run`: event lines, outcome, exit codes, first signal takes the cutoff path, second signal saves and exits, Mozaik warning filtered; tests for exit-code mapping and the second signal
- [x] 4.3 `report` and `intervene`
- [x] 4.4 `doctor` (brain config and one call, cloud key, apb and handshake, trust, Claude Code logged in, OSB vault, git, bun, npm) with per-check deadlines and fix hints; a test where one check fails

## 5. Bootstrap and docs

- [x] 5.1 `scripts/apb-bootstrap.ts` approves every profile, the starters and `smoke-fail` too, and takes `--agent <cli>` to republish the starters with that profile; verified against an empty `APB_CONFIG_DIR`
- [x] 5.2 Product design section 6.2 updated: answers arrive through the per-attempt submit tool, not `sendEvent`
- [x] 5.3 README: `factory` commands, `doctor`, the end-to-end run, its time and cost

## 6. End-to-end

- [x] 6.1 `scripts/e2e.ts` and `bun run e2e`: absolute deadline, unique spec name, independent verification from a clean copy under both runtimes, spec examples under Node, report with per-task time and cost, pass only on `succeeded`
- [x] 6.2 First end-to-end attempt; failures fixed in the adapters or prompts, then repeated
- [x] 6.3 The end-to-end run passes once; its report and trace kept as the M1 rehearsal record (git-ignored `runs/`)
- [x] 6.4 Full gate `bun run check` green, code-ranker clean

## Workflow follow-up

- Review cycle on the diff (Sol when available, OCR, security and test audit), findings fixed, full gate again.
- Archive the change, `openspec validate --all --strict`, commit with the owner's approval.
