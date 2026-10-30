# Architecture: layers, ports, adapters

Source of truth for the design: section 6 of
`docs/superpowers/specs/2026-10-30-factory-layer-design.md`. This file is the
working summary agents need while coding.

## Layers (enforced by dependency-cruiser)

Lowest first. A module may import its own layer or a lower one, never a
higher one. Type-only imports count.

| Layer | Directory | Holds | May import |
| --- | --- | --- | --- |
| domain | `src/domain/` | pure types and rules: Spec, AcceptanceCheck, Plan, Task, TaskState, Verdict, RecoveryChoice, PlaybookRef, Intervention, TraceEvent, Usage; their Zod schemas | nothing of ours |
| ports | `src/ports/` | interfaces: Brain, Executor, PlaybookAuthoring, Memory, TraceSink, Clock, CostTable, Workspace | domain |
| application | `src/application/` | the factory state machine and use cases (RunFactory, ReplayRun, Doctor, RecordIntervention) | ports, domain |
| adapters | `src/adapters/` | brain-mozaik, hands-apb, memory-osb, mcp-stdio, workspace-git, trace-fs, report-html | application, ports, domain |
| cli | `src/cli/` | the composition root and the `factory` commands | everything |

Every module under `src/` lives in exactly one layer directory. The rules are
generated from `LAYERS` in `.dependency-cruiser.cjs`; `KNOWN_VIOLATIONS` is
empty and stays empty. A lower layer that needs something from above gets it
injected through a port.

## Rules that follow from the layers

1. The domain has no IO and no SDK imports. Zod schemas for domain values
   live next to their types.
2. The application never imports an adapter or an SDK. It calls `Brain` for
   decisions and never knows how the brain reasons.
3. Only `brain-mozaik` imports `@mozaik-ai/core`; everything else depends on
   the `Brain` port, and the composition root wires the adapter.
4. Only the stdio MCP adapter imports `@modelcontextprotocol/sdk`; APB and OSB
   adapters use it through that shared client, with request timeouts.
5. The CLI is the only place that picks adapters.

## External systems

1. **Mozaik** `@mozaik-ai/core` 4.2.0, pinned exactly. Reference:
   `node_modules/@mozaik-ai/core/dist/index.d.ts` only. Its MCP client is
   HTTP-only, so the factory has its own stdio MCP client. Function tools
   carry `strict: false` explicitly (mandatory in 4.2.0).
2. **APB** through `apb mcp` (stdio), execution mode `cli` only, host
   fallback off. Never changed from here.
3. **OSB** through its MCP server (stdio), a dedicated vault for the factory.
4. **Brain model** configuration comes from the environment
   (`ZAI_API_KEY`, `ZAI_BASE_URL`, `ZAI_MODEL`; see `.env.example`).

## Runtime state

`work/` (per-spec git repositories and task worktrees), `runs/*/state.json`
and `out/` are git-ignored. State files are written atomically (temp file
plus rename, mode 0600).
