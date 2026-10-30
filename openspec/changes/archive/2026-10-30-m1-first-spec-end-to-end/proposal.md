# Proposal

## Why

The factory core (change `factory-core`) orchestrates against ports, and the
adapter smokes prove the links to the model, APB and OSB. Nothing yet turns a
real spec into a delivered package. Milestone M1 connects the core to real
adapters and proves one practice spec end to end, which is the factory's
main acceptance test from now on.

## What Changes

- A real `Brain` (Mozaik): three agents (Architect, Acceptance analyst,
  Critic) in one runtime on the guarded runner; every decision is a bounded
  attempt with a fresh model context whose typed answer arrives through a
  per-attempt submit tool validated with the domain's Zod schema; a step
  cap, a process-level rejection guard, provider fallback with a cooldown,
  and a refusal to start when a Mozaik cloud key is present.
- A real `Executor` and `PlaybookAuthoring` over `apb mcp`, matching the
  live APB 1.0.0-beta.1 answers: supervised starts with string params and a
  task file written into the tree, event waits by supervisor token with
  normalized triggers, per-attempt usage joined from the run events and the
  run report, accepted-not-applied supervisor commands, confirmed stops, run
  lookup by playbook, tree and time.
- A real `Memory` over `o2b mcp`: idempotent remember and recall of past run
  outcomes on the factory's dedicated vault.
- The CLI as composition root: `factory run`, `factory report`,
  `factory intervene`, `factory doctor`.
- The four starter playbooks approved after review; a practice spec; an
  end-to-end run command that runs the factory on it and verifies the
  delivered package independently.

Out of scope (later milestones): concurrent multi-spec runs, resuming a run
from the CLI, replay in the CLI, the HTML report, brain-authored playbooks
beyond the port, live terminal lanes (plain line output only).

## Capabilities

### New Capabilities

- `brain-decisions`: how the Mozaik brain turns each port call into one
  bounded, typed, attributable decision.
- `apb-executor`: the Executor and PlaybookAuthoring ports over `apb mcp`.
- `run-memory`: remembering and recalling run outcomes in OSB.
- `factory-cli`: the commands and the composition root.
- `end-to-end-run`: the practice spec and the end-to-end acceptance run.

### Modified Capabilities

- `apb-project-setup`: the fresh-machine bootstrap also approves the four
  starter playbooks.
- `mcp-stdio-client`: tool errors carry the server's error code.
- `brain-inference`: provider fallback with a cooldown and vendor request
  fields (thinking off).

## Impact

Layers: `adapters` (`brain-mozaik`, `hands-apb`, `memory-osb`, a small
addition to `mcp-stdio`) and `cli`. The adapters implement the ports of
`factory-core`; the CLI is the only place that wires them. The port gaps the
live answers revealed (cache tokens and reported cost in usage, model
provenance, a refused start, typed executor inputs, waits the factory cannot
serve, the executor scratch directory) were added to `factory-core` (its
design D2d) before it was coded; this change adds nothing to `domain`,
`ports` or `application` beyond that. This change starts after
`factory-core` is merged. New tracked files: the
practice spec under `examples/`. The end-to-end run costs model and agent
usage and runs only on request, not in the check tiers.
