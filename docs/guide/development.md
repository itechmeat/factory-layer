# Development

The layers of the code base, the check tiers and the integration smokes.
Back to the [README](../../README.md). The rules for contributors and
coding agents live in [AGENTS.md](../../AGENTS.md).

## Layers

Lowest first: `domain` <- `ports` <- `application` <- `adapters` <- `cli`
(`src/<layer>/`). A module imports its own layer or a lower one, never a
higher one; dependency-cruiser enforces it (`bun run check:arch`).

1. `domain`: pure types and rules with their Zod schemas.
2. `ports`: the interfaces the application depends on (the brain, the
   executor, memory, the trace and the rest).
3. `application`: the factory state machine, the single writer of task
   state.
4. `adapters`: the brain on Mozaik, the hands on APB, memory on Open Second
   Brain, git workspaces, the file trace and the report.
5. `cli`: the composition root, the only place that picks adapters.

## Checks

```bash
bun install
bun run check:fast              # static checks and the unit tests the change reaches
bash scripts/check.sh standard  # all unit tests, the build
bun run check                   # full gate (default)
```

## Integration smokes

The smokes in `tests/integration/` prove the links to the real systems:

1. **Brain:** a function call through the guarded inference runner, a
   provider error with a wrong key, and a timeout.
2. **Hands:** a supervised APB run of `smoke` followed to success, and a
   `smoke-stall` run stopped at a 20 s limit and observed finished with its
   driver gone.
3. **Memory:** an `o2b mcp` handshake on the factory vault and a non-empty
   tool list.

Each smoke checks its prerequisites first and fails with a message naming
what is missing. Run them with:

```bash
bun test --config=scripts/fast-bunfig.toml ./tests/integration
```

`bun run check` (the full tier) runs them too. They need network access, the
brain key, the factory vault and an approved APB trust store (see
[APB trust bootstrap](playbooks-and-profiles.md#apb-trust-bootstrap)).
