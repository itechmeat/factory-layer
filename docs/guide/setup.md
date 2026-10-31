# Setup

What the factory needs on a machine, the macOS setup step by step, and the
dedicated memory vault. Back to the [README](../../README.md).

## Requirements

1. Bun 1.4.4 (`.bun-version`).
2. git 2.28 or newer, and Node.js with npm (a delivery's built output is
   checked under Node without Bun).
3. `apb` (Agentic Playbooks) 1.0.0-beta.1 or newer on `PATH`: the factory
   drives coding work through `apb mcp`.
4. `o2b` (Open Second Brain) 1.96.0 on `PATH`: the factory keeps its memory
   in a dedicated vault through `o2b mcp`.
5. The agent CLI the starter playbooks use, installed and logged in: Claude
   Code by default (see [Agent profiles](playbooks-and-profiles.md#agent-profiles)).
6. code-ranker on `PATH` for the full check tier.

## macOS setup

The factory runs on macOS (Apple Silicon or Intel) with the same commands
as on Linux. The check gate is meant for development on Linux; on a Mac
only the factory itself and the hidden-run script are needed.

1. Install Homebrew, then the base tools:

   ```bash
   brew install git node bash
   ```

   `node` brings npm, which the factory uses to check that a delivery's
   built output starts without Bun. `bash` replaces the bash 3.2 that macOS
   ships, so acceptance checks written for a current bash run unchanged;
   keep the Homebrew `bin` directory before `/bin` on `PATH` (the Homebrew
   installer sets it up). git must be 2.28 or newer (`git init -b`); the
   Homebrew one is.

2. Install Bun 1.4.4 with its official installer or with Homebrew
   (`brew install oven-sh/bun/bun`), and check `bun --version`. Bun and Node
   may share a directory: the factory never lets Bun stand in for Node.

3. Install `apb` and `o2b` (versions under [Requirements](#requirements))
   following their own installation guides, and check that `apb --version`
   and `o2b --version` answer from a new terminal.

4. Install Claude Code and log in once by running `claude` and following
   the prompt; `claude auth status` must report `"loggedIn": true`.

5. Clone this repository and install the dependencies:

   ```bash
   bun install
   ```

6. Copy `.env.example` to `.env` and fill it in (see
   [Configuration](configuration.md)): the brain provider (`ZAI_API_KEY`,
   and for the gateway `FACTORY_BRAIN_GATEWAY=1` with
   `JIGJOY_ANTHROPIC_BASE_URL` and `JIGJOY_ANTHROPIC_API_KEY`), and
   `FACTORY_OSB_VAULT` and `FACTORY_OSB_CONFIG` for a dedicated memory vault
   (see [A dedicated memory vault](#a-dedicated-memory-vault)). Use absolute
   paths.

7. Approve the starter playbooks and the agent profile in APB, then check
   the setup:

   ```bash
   bun run apb:bootstrap
   bun run factory doctor
   ```

   Every doctor line must pass; a failed line names what to fix.

Temporary files go under the system temporary directory (`$TMPDIR` on
macOS). The files Finder leaves (`.DS_Store`) are never committed by a task
and never delivered, so browsing the `work/` and output directories during
a run is safe.

## A dedicated memory vault

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
