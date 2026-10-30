# Design

## Context

See proposal.md for the motivation. The repository holds a skeleton: one
`Clock` port and its adapter, the check tiers, the layer rule. The runtime
dependencies are pinned but not yet imported: `@modelcontextprotocol/sdk`
1.32.2, `@mozaik-ai/core` 4.2.0, `zod` 4.6.7. The design document
(`docs/superpowers/specs/2026-10-30-factory-layer-design.md`, sections 5,
6.2, 6.3 and 6.5) fixes the external contracts this change exercises.

Facts read from the published `@mozaik-ai/core` 4.2.0 (`dist/index.d.ts` and
the shipped `dist/index.js`):

1. `InferenceRunner` has `run(input)` and `stream(input)`; a custom runner
   passed as `inferenceRunnerConfig.runner` replaces the default one in
   `initializeRuntime`, and every agent loop uses it for both inference
   states.
2. `DefaultInferenceRunner` is exported, but its constructor needs an
   `InferenceInputValidator`, which is not exported. The only public way to
   obtain one is `getInferenceRunner()` on a runtime already initialized
   with `supportedModels`, which is too late to install a wrapper as that
   runtime's runner.
3. `OpenAIChatCompletions(endpointMapper?, { baseURL, apiKey, extraBody })`
   implements `Endpoint` with `infer(input)` and `stream(input)`; its calls
   take no abort signal.
4. `InferenceOutput` carries `items` and `tokenUsage` (possibly undefined);
   a `FunctionCallItem` keeps its arguments as a JSON string.
5. A loop keeps one `ModelContext` object for its whole life: the inference
   input is spread (`{ ...previousRequest }`) between steps, so `context`
   stays the same reference. `InferenceInput` has no attempt or cancellation
   field.

Facts read from the MCP SDK 1.32.2 and APB 0.25.0:

6. `StdioClientTransport.close()` drops its process reference at once, then
   escalates on its own (stdin end, about 2 s, SIGTERM, about 2 s, SIGKILL).
7. `playbook_trial` of a playbook with a file-system write effect needs a
   git `HEAD` (it adds a detached worktree). APB counts every script node as
   writing files, using the network and touching external systems, whatever
   the playbook declares, so no script playbook can be trialled before the
   repository's first commit. `playbook_approve` without a trial is APB's
   documented explicit-confirmation route.
8. `playbook_approve` approves the playbook digest only; run starts through
   MCP also require every referenced profile bundle to be approved.
   `apb profile write` (or `profile_write`) approves the bundle it writes
   unless the profile references skills that are not approved; its result
   reports `trusted`, `skills_unapproved` and `trust_write_failed`.
10. APB resolves its configuration directory (and with it the trust store)
    from `APB_CONFIG_DIR`, then `XDG_CONFIG_HOME`, then `HOME`.
11. Mozaik's default validator applies five rules per model: reasoning
    effort supported and in the model's allowlist, tool calling supported
    when tools are given, streaming supported when requested, structured
    output supported when requested, and every context item type supported.
    The OpenAI-compatible mapper turns a response without a message into
    empty items and copies token counts unchecked.
9. A supervised run's driver is detached: it survives the end of the MCP
   session that started it.

## Goals / Non-Goals

**Goals:**

1. One stdio MCP client reused by every MCP-speaking adapter later.
2. A brain runner that already satisfies the loop lifecycle contract of the
   design (deadline, cancellation, classified errors) so M1 plugs it into
   Mozaik agents unchanged.
3. An APB project whose deterministic `smoke` playbook runs trusted, and
   whose starter playbooks and profiles exist and validate.

**Non-Goals:**

1. Provider fallback and cooldown policy (configuration is parsed now; the
   switching policy lands with the `Brain` adapter in M1).
2. Trial and approval of the four starter playbooks: they write files, so
   their trial needs a committed baseline (fact 7), and a meaningful trial
   needs a practice spec with acceptance checks. Both arrive in M1.
3. Ports for `Executor` and `Memory`; the smokes talk to the MCP client
   directly.

## Decisions

### D1. The stdio MCP client wraps the official SDK

`adapters/mcp-stdio` builds on the SDK `Client` and `StdioClientTransport`.
The connect deadline races the handshake against a timer; per-call timeouts
use the SDK request option `timeout`. The transport is created with
`stderr: "pipe"`; the client keeps the last 4 KiB of stderr.

Teardown: the client records the child pid right after the transport has
started the process, before the handshake (the SDK closes the transport
itself on a failed handshake and drops its process reference, fact 6), and
starts the grace timer before calling `close()`. The same pid-based teardown
runs after a failed connect. The SDK close and a pid poll (signal 0, every
50 ms) run concurrently; when the grace period ends with the pid alive, the
client sends SIGKILL itself, whatever the SDK is still waiting for. After
the kill, an exit-confirmation budget (1 s) bounds the poll; if the pid is
still present then, close rejects with a typed `teardown` error naming the
pid. Close therefore finishes within grace plus 1 s.

Safe diagnostics: the client takes a list of secret values (the caller
passes the values of credential variables). Every error message, retained
stderr tail and exposed cause is passed through one redaction function that
replaces each secret with `[redacted]`. Errors are classes with a `kind`
discriminator (`connection`, `timeout`, `tool`, `validation`, `closed`).

Alternative considered: a hand-written JSON-RPC client. Rejected: the SDK is
already a pinned dependency and handles framing and capability negotiation.

### D2. The guarded runner owns the endpoint table

`adapters/brain-mozaik` implements Mozaik's `InferenceRunner` over a table of
providers (`{ name, model, endpoint, capabilities }`, endpoint =
`OpenAIChatCompletions`; `capabilities` mirrors Mozaik's model
specification: reasoning effort support and allowlist, function calling,
streaming, structured output, supported context item types). It replaces
the default runner instead of wrapping it (fact 2) and keeps all five rules
of the default validator (fact 11) as one pure function with the same
semantics, plus the unknown-model check; a violation is a typed request
error raised before any network call.

Response validation (fact 11): the runner validates the provider's raw
response (`rowResponse`) with Zod before returning: a response without a
first choice and message, or whose mapped items are empty, is a typed
`malformed_response` failure (retryable). Usage policy: a response without
usage yields `unavailable`; a usage block with missing, negative or
non-integer counts also yields `unavailable` with the reason
`invalid_usage`, and the call still succeeds, because the answer itself is
valid. Valid output is returned to Mozaik unchanged.

Attempt binding (fact 5): the adapter creates one `ModelContext` per brain
attempt and registers it with the runner (`bind(context, attempt)`, kept in a
`WeakMap`). Each `run` or `stream` looks up the attempt by `input.context`.
An unbound context is rejected with a typed error, so no inference escapes
the guard. Cancelling an attempt marks it; its next inference rejects with
a cancelled error without contacting the provider. A timeout cancels the
attempt it belongs to, so the orphaned loop stops at its next step; other
attempts are unaffected.

Deadline: each attempt has one absolute deadline set at bind time (default
90 s from the first call). `run` races `endpoint.infer` against the time left;
`stream` checks the time left before each step and races each step against
it, so a stream that keeps emitting chunks still ends at the deadline. The
in-flight provider request is not aborted (fact 3); the caller stops waiting
and later inference of that attempt is refused.

Errors: classification reads the `status` of errors thrown by the endpoint:
401 and 403 are `auth` (not retryable), 400 and 404 `request` (not
retryable), 408, 429 and 5xx retryable, no status `network` (retryable).
Messages and causes are redacted of the provider key.

Function calls: a tool offered to the model is declared with a Zod schema
for its arguments; its JSON Schema for the provider is generated from it
(`z.toJSONSchema`). The runner returns Mozaik's `InferenceOutput` untouched
(string arguments, as loops expect). A separate pure helper turns a
`FunctionCallItem` into a validated `{ name, args }` or a typed
`invalid_arguments` error (malformed JSON or schema mismatch); the smoke and,
in M1, the tool `invoke` wrappers use it.

Usage: `tokenUsage` maps to `{ kind: "measured", input, output }`, or
`{ kind: "unavailable" }` when undefined, plus elapsed milliseconds from an
injected `Clock`.

### D3. Configuration parsing is a pure function

`parseBrainConfig(env: Record<string, string | undefined>)` returns a
validated config or throws an error naming the variable; tests and later the
CLI pass `process.env`. The Zod schema lives in the adapter that consumes it.

### D4. APB setup is authored through APB itself

`.apb/` is created by `apb init` and filled through APB's own authoring
surface (`playbook_howto`, `profile_howto`, `profile_write`,
`playbook_create`, `playbook_validate`), not from YAML guessed from memory.
The `smoke` and `smoke-stall` playbooks have one script node each that runs
a fixed command with no model. Because no script playbook can be trialled
before the first commit (fact 7), they are approved by explicit confirmation
after their scripts are reviewed; once a commit exists, a trial is possible
and recommended after any change to them. The
starter playbooks are authored and validated now and trialled in M1
(Non-Goal 2).

Profiles in M0 reference no skills, so writing them approves their bundles
(fact 8). Fresh-machine bootstrap, documented in the README: re-write each
project profile with `apb profile write` and check the result reports
`trusted` with no `skills_unapproved` and no `trust_write_failed`, then
approve `smoke` and `smoke-stall` after reviewing their scripts. It is
verified once with every APB subprocess started with `APB_CONFIG_DIR` set to
a fresh temporary directory (fact 10), after checking that the trust list
starts empty; the verification ends by running both supervised smokes
against that isolated configuration.

Execution: `apb mcp` is started with `APB_EXECUTION=cli` and the project sets
`execution.fallback_to_host: false`; agent tasks never fall back to a host,
while APB-managed script nodes run as usual. A `pending_tasks` state seen by
the factory is an executor failure at once.

### D5. Integration tests talk to real processes

`tests/integration/*.test.ts` run under the full tier only, with explicit
per-test timeouts (Bun's default is 5 s). `tests/` is added to the
typecheck, lint and format targets. Bun loads `.env` for `bun test`.

Following a supervised run is a small adapter function
(`src/adapters/hands-apb/follow-run.ts`) over a tool-calling interface, so
its failure paths are unit tested with a fake: it starts the run with
`supervise: "self"`, keeps the run id, and computes an absolute run deadline
and, on stop, an absolute cleanup deadline. Every call is bounded by the
deadline in force: a supervisor wait asks APB for a slice of
`min(60 s, time left - 5 s)` and carries an MCP request timeout of that
slice plus 5 s, never past the deadline; every cleanup call carries an MCP
timeout that ends at the cleanup deadline. It waits until a terminal event
or the run deadline; on a host-task wait (`pending_tasks`), a stall, an
error or the limit it calls `run_stop`, then polls the run status within a
separate cleanup budget (default 60 s) until the run is terminal and its
driver is reported gone, and returns a typed outcome. Tool argument and
result shapes come from the schemas `apb mcp` publishes and are validated
with Zod. The integration smoke uses it twice: the `smoke` playbook to
success (run limit 300 s), and a `smoke-stall` playbook (one script node that
sleeps far longer than the limit, no file-system write) with a 20 s run
limit, asserting the stop path ends terminal with the driver gone. The test
timeouts are the run limit plus the cleanup budget plus 30 s. The
memory smoke runs `o2b mcp --config $FACTORY_OSB_CONFIG --vault
$FACTORY_OSB_VAULT`.

## Risks / Trade-offs

- [Z.ai daytime limits make the brain smoke flaky] -> one short call per
  scenario; a rate-limit error is reported as such, not as a pass.
- [The timeout scenario needs a call slower than its deadline] -> the smoke
  binds an attempt with a 1 ms deadline and asserts the timeout error kind.
- [APB trust is per machine] -> documented bootstrap, verified once on an
  empty trust store; the hands smoke fails with a message pointing to it.
- [Leaked child processes or detached runs] -> every test closes its client
  in `afterEach`; the hands smoke stops unfinished runs; teardown and
  redaction are unit tested with a fake server.
