# Tasks

## 1. Stdio MCP client (`src/adapters/mcp-stdio/`)

- [x] 1.1 Test first with a tiny fake stdio MCP server fixture: connect succeeds and exposes the server name; verify with `bun test src/adapters/mcp-stdio`
- [x] 1.2 Pid recorded before the handshake; connect deadline, missing command, early exit and an invalid handshake from an uncooperative server (500 ms grace) yield connection errors with the stderr tail and no surviving child; unit tests green
- [x] 1.3 Tool calls with per-call timeout, tool error and closed errors; unit tests green
- [x] 1.4 Zod validation of structured or JSON text results, validation error on mismatch; unit tests green
- [x] 1.5 Teardown: grace timer started before close, concurrent pid poll, SIGKILL at the end of the grace period, 1 s exit-confirmation budget, typed teardown error, idempotent; unit tests with a cooperative and an uncooperative fake server (500 ms grace, close within about 1.5 s, pid gone)
- [x] 1.6 Redaction: a fake server that echoes a configured secret to stderr and into a tool error; unit test asserts the secret is absent from every reported error and the stderr tail

## 2. Guarded brain inference (`src/adapters/brain-mozaik/`)

- [x] 2.1 `parseBrainConfig`: primary defaults, missing key, partial fallback, no key value in messages; unit tests green
- [x] 2.2 Request checks with Mozaik's five rules (reasoning effort allowlist, tool calling, streaming, structured output, context item types) plus unknown model, all rejected before any call; unit tests with a fake `Endpoint` that records calls
- [x] 2.2a Response validation: no choices or no message or empty items to a retryable malformed-response error; missing or invalid token counts to unavailable usage with the reason, call succeeds; valid output returned unchanged; unit tests green
- [x] 2.3 Attempt binding by `ModelContext`: unbound context rejected, cancelled attempt rejected without a call, cancelling one of two attempts leaves the other usable; unit tests green
- [x] 2.4 Absolute attempt deadline for `run` and `stream`: slow `infer`, a stalled stream and a stream that keeps emitting past the deadline all reject with a timeout and cancel the attempt; unit tests green
- [x] 2.5 Error classification by status (401/403, 400/404, 408/429/5xx, none) and key redaction in messages and causes; unit tests green
- [x] 2.6 Function-call helper: Zod-declared tools to JSON Schema, a `FunctionCallItem` to validated `{ name, args }`, typed invalid-arguments error for bad JSON, unknown tool or schema mismatch; unit tests green
- [x] 2.7 Usage mapping (measured or unavailable) and elapsed time from an injected `Clock`; unit tests green

## 3. APB project setup (`.apb/`)

- [x] 3.1 `apb init`; `config.yaml` with `execution.fallback_to_host: false`; verify by reading the file and `apb doctor`
- [x] 3.2 Profiles authored via `profile_howto` and `apb profile write`, without skill references: coding profile with Claude Code primary and Codex fallback; each write reports `trusted`, no `skills_unapproved`, no `trust_write_failed`; `apb validate` clean
- [x] 3.3 Playbooks `smoke` (one script node, no file-system write, no model), `smoke-stall` (one script node that sleeps for an hour, no file-system write, no model), `scaffold`, `implement-task`, `repair`, `integrate` authored via `playbook_howto` and `playbook_create`, the four starter playbooks with `defaults.max_parallel: 2` (APB takes in-run parallelism only from the playbook); `apb validate` clean
- [x] 3.4 Approve `smoke` and `smoke-stall` by explicit confirmation after reviewing their scripts (APB cannot trial a script playbook before the first commit); `apb trust list` shows both
- [x] 3.5 Bootstrap verified with `APB_CONFIG_DIR` set to a fresh temporary directory for every APB subprocess: the trust list starts empty; re-write the profiles, approve `smoke` and `smoke-stall` after reviewing their scripts; the trust list shows the profile bundles and both playbooks; both supervised smokes run against that directory

## 4. Integration smokes (`tests/integration/`)

- [x] 4.1 `tests/` added to the typecheck, lint and format targets; the prerequisite helper fails with a message naming the missing variable or binary; `bun run check:fast` green
- [x] 4.2 Brain smoke with explicit test timeouts: validated function call, wrong-key provider error (not retryable, key absent), 1 ms attempt deadline timeout; green with the real key
- [x] 4.3 Memory smoke: `o2b mcp` on the factory vault, handshake and non-empty tool list, no leftover process; green
- [x] 4.4 `src/adapters/hands-apb/follow-run.ts` test first with a fake tool caller: success, `pending_tasks` stops at once, stall, error and run limit each call `run_stop` and poll to terminal with the driver gone within the cleanup budget, cleanup timeout is a typed outcome; a supervisor wait in flight cannot overrun the run deadline and a slow cleanup call cannot exceed the cleanup budget (fake with delays); unit tests green
- [x] 4.4a Hands smoke: `smoke` followed to success (run limit 300 s), `smoke-stall` with a 20 s run limit stopped and observed terminal with the driver gone; test timeouts = run limit + cleanup budget + 30 s; no leftover `apb mcp`; green
- [x] 4.5 `.env.example` lists `FACTORY_OSB_VAULT` and `FACTORY_OSB_CONFIG`; `knip.json` exemptions for the now imported dependencies removed; `bun run check:dead` green

## 5. Docs and delivery

- [x] 5.1 README: prerequisites, `.env`, the OSB factory vault, the APB trust bootstrap, how to run the smokes
- [x] 5.2 `docs/versions.md` notes the pinned `apb` and `o2b` versions the smokes were run with
- [x] 5.3 Full gate `bun run check` green, code-ranker clean
- [x] 5.4 Independent review of the diff, findings fixed, full gate green once more

## Workflow follow-up

- Archive the change (`/opsx:archive`), then `openspec validate --all --strict`.
- Ask the owner to approve the commit.
