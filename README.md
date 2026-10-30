# factory-layer

A software factory: give it a one-page product spec and it plans the work,
derives acceptance checks, drives coding agents through a playbook runner,
judges the results and recovers from failures until it delivers a small
TypeScript project (a CLI or an HTTP API) whose tests pass. Every run leaves
a trace of tasks, attempts, models, timings and usage.

Status: under construction.

## Requirements

1. Bun 1.4.4 (`.bun-version`).
2. git.
3. `apb` (Agentic Playbooks) 1.0.0-beta.1 or newer on `PATH`: the factory drives coding
   work through `apb mcp`.
4. `o2b` (Open Second Brain) 1.96.0 on `PATH`: the factory keeps its memory
   in a dedicated vault through `o2b mcp`.
5. The Claude Code and Codex CLIs, installed and logged in: the `coder`
   profile runs Claude Code first and falls back to Codex.
6. code-ranker on `PATH` for the full check tier.

## Checks

```bash
bun install
bun run check:fast              # static checks and the unit tests the change reaches
bash scripts/check.sh standard  # all unit tests, the build
bun run check                   # full gate (default)
```

## Configuration

Copy `.env.example` to `.env` and fill it in. Bun loads `.env` for
`bun test`, so the integration smokes read it directly.

| Variable | What it is |
| --- | --- |
| `ZAI_API_KEY` | API key of the brain model's OpenAI-compatible endpoint |
| `ZAI_BASE_URL` | Base URL of that endpoint; optional, defaults to `https://api.z.ai/api/coding/paas/v4` |
| `ZAI_MODEL` | Model id the brain uses; optional, defaults to `glm-5.3-flash` |
| `FALLBACK_API_KEY`, `FALLBACK_BASE_URL`, `FALLBACK_MODEL` | Optional second provider, used when the primary one is rate-limited or down; an OpenAI-compatible model with function calling and streaming, like the primary; set all three or none; `FALLBACK_MODEL` must differ from `ZAI_MODEL` (calls are routed by model name) |
| `FACTORY_OSB_VAULT` | Absolute path of the factory's own Open Second Brain vault |
| `FACTORY_OSB_CONFIG` | Absolute path of the Open Second Brain config file for that vault |

Keys stay in `.env`, which git ignores; never commit them.

### A dedicated memory vault

The factory never writes to a personal Open Second Brain vault. Create a
separate one without touching your own Open Second Brain configuration:

1. Pick an empty directory for the vault.
2. Write a small YAML config file for it, outside the repository, with three
   keys: `vault` (the vault directory), `agent_name` (for example
   `factory`) and `timezone` (an IANA name such as `Europe/Berlin`).
3. Run `o2b brain init --config <config file> --vault <vault directory>`.
   The `--config` flag matters: a fresh machine has no default global
   Open Second Brain config.
4. Put the two absolute paths into `.env` as `FACTORY_OSB_VAULT` and
   `FACTORY_OSB_CONFIG`.

Do not run `o2b init` for this: it rewrites your global Open Second Brain
configuration.

## APB trust bootstrap

APB runs only playbooks and agent profiles that are approved in its trust
store, and the trust store belongs to the machine, not to the repository. On
a new machine, or after the profiles or the smoke playbooks change, run:

```bash
bun run apb:bootstrap
```

From the repository root it:

1. re-writes every project profile under `.apb/profiles/` from its own
   `profile.yaml` and `SOUL.md`, which approves the profile's bundle, and
   checks that the write reports the bundle trusted, with no failed trust
   write and no unapproved skills;
2. starts `apb mcp` and approves the `smoke` and `smoke-stall` playbooks;
3. prints the trust list entries it created.

The two smoke playbooks are approved by explicit confirmation rather than by
an APB trial, because APB cannot trial a script playbook before the
repository has its first commit. Both are single script nodes with no model
and no file writes: `smoke` prints one fixed line, `smoke-stall` sleeps for
an hour so the stop path can be exercised. The starter coding playbooks are
trialled and approved in a later milestone.

APB finds its trust store through `APB_CONFIG_DIR`, then
`XDG_CONFIG_HOME`, then `HOME`. Set `APB_CONFIG_DIR` to bootstrap and test
against an isolated trust store; the bootstrap and the smokes both honour
it.

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
brain key, the factory vault and an approved APB trust store (see above).
