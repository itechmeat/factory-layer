# Proposal

## Why

The factory depends on three external systems it does not control: the brain
model behind an OpenAI-compatible endpoint, APB reached through `apb mcp`, and
OSB reached through its MCP server. Before any orchestration is built, each
link must be proven to work, to fail in a known way, and to never hang. This
is milestone M0 of the design.

## What Changes

- A shared stdio MCP client: spawns an MCP server process, completes the
  handshake within a deadline, calls tools with a per-request timeout,
  validates results with Zod, and always reaps the child process.
- A guarded inference runner for the brain: calls an OpenAI-compatible model
  with function tools, binds every call to an attempt with one absolute
  deadline and a cancellation flag, classifies failures (timeout, provider
  error, cancelled, invalid arguments) as typed errors, validates function
  call arguments with Zod, and reports token usage as measured or
  unavailable.
- Brain configuration read from the environment (`ZAI_*`, optional
  `FALLBACK_*`) and validated with Zod.
- The APB project setup under `.apb/`: `config.yaml` with host fallback off,
  agent profiles (Claude Code primary, Codex fallback), the four starter
  playbooks (`scaffold`, `implement-task`, `repair`, `integrate`) and a
  deterministic `smoke` playbook and a never-finishing `smoke-stall`
  playbook for the stop path, all validated; the profiles and `smoke`
  approved, with a fresh-machine bootstrap verified once.
- An integration suite under `tests/integration/`, run by the full check
  tier: brain function calling, a provider error and a timeout; a supervised
  APB run of the `smoke` playbook followed to completion; an OSB MCP
  handshake on a dedicated vault.

Out of scope: the `Brain`, `Executor` and `Memory` ports and their full
adapters, Mozaik agents and loops, the factory state machine, the CLI
commands (`factory doctor` included), git workspaces, the trace, and the
trial and approval of the four starter playbooks (they need a committed
baseline and a practice spec, both in M1). They start
in M1 on top of these pieces.

## Capabilities

### New Capabilities

- `mcp-stdio-client`: talking to a local MCP server over stdio with bounded
  waits, validated results and a guaranteed process teardown.
- `brain-inference`: one bounded, classified model call with function tools
  against an OpenAI-compatible provider, configured from the environment.
- `apb-project-setup`: the factory's own APB project configuration (execution
  mode, profiles, starter playbooks) and its trust bootstrap.
- `integration-smokes`: the live checks that prove the brain, APB and OSB
  links before delivery.

### Modified Capabilities

None.

## Impact

Layers: `adapters` only (`mcp-stdio`, `brain-mozaik`, and the run-following
function of `hands-apb`), plus `tests/integration/`
and `.apb/`. The adapters import nothing above themselves; no other layer
changes, so the layer rule holds. Only `brain-mozaik` imports
`@mozaik-ai/core`. Dependencies already pinned (`@modelcontextprotocol/sdk`,
`@mozaik-ai/core`, `zod`) get their first imports, so their `knip`
exemptions are removed. The full tier gains a real integration step that
needs network access, a brain key, `apb` and `o2b` on the PATH.
