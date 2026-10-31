# factory-layer

A software factory: give it a one-page product spec and it plans the work,
derives acceptance checks, drives coding agents through a playbook runner,
judges the results and recovers from failures until it delivers a small
TypeScript project (a CLI or an HTTP API) whose tests pass. Every run leaves
a trace of tasks, attempts, models, timings and usage.

Status: the factory delivers one-page CLI and HTTP API specs end to end,
with a cutoff, a hidden-run script and playbook authoring.

## Requirements

1. Bun 1.4.4 (`.bun-version`).
2. git 2.28 or newer, and Node.js with npm (a delivery is checked without Bun).
3. `apb` (Agentic Playbooks) 1.0.0-beta.1 or newer on `PATH`: the factory drives coding
   work through `apb mcp`.
4. `o2b` (Open Second Brain) 1.96.0 on `PATH`: the factory keeps its memory
   in a dedicated vault through `o2b mcp`.
5. The agent CLI the starter playbooks use, installed and logged in: Claude
   Code by default (see "Agent profiles" below).
6. code-ranker on `PATH` for the full check tier.

## macOS setup

The factory runs on macOS (Apple Silicon or Intel) with the same commands
as on Linux. The check gate is meant for development on Linux; on a Mac
only the factory itself and the hidden-run script are needed.

1. Install Homebrew, then the base tools:

   ```bash
   brew install git node bash
   ```

   `node` brings npm, which the factory uses to check that a delivery works
   without Bun. `bash` replaces the bash 3.2 that macOS ships, so acceptance
   checks written for a current bash run unchanged; keep the Homebrew `bin`
   directory before `/bin` on `PATH` (the Homebrew installer sets it up).
   git must be 2.28 or newer (`git init -b`); the Homebrew one is.

2. Install Bun 1.4.4 with its official installer or with Homebrew
   (`brew install oven-sh/bun/bun`), and check `bun --version`. Bun and Node
   may share a directory: the factory never lets Bun stand in for Node.

3. Install `apb` and `o2b` (versions under "Requirements") following their
   own installation guides, and check that `apb --version` and
   `o2b --version` answer from a new terminal.

4. Install Claude Code and log in once by running `claude` and following
   the prompt; `claude auth status` must report `"loggedIn": true`.

5. Clone this repository and install the dependencies:

   ```bash
   bun install
   ```

6. Copy `.env.example` to `.env` and fill it in (see "Configuration"): the
   brain provider (`ZAI_API_KEY`, and for the gateway
   `FACTORY_BRAIN_GATEWAY=1` with `JIGJOY_ANTHROPIC_BASE_URL` and
   `JIGJOY_ANTHROPIC_API_KEY`), and `FACTORY_OSB_VAULT` and
   `FACTORY_OSB_CONFIG` for a dedicated memory vault (see "A dedicated
   memory vault"). Use absolute paths.

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

## Checks

```bash
bun install
bun run check:fast              # static checks and the unit tests the change reaches
bash scripts/check.sh standard  # all unit tests, the build
bun run check                   # full gate (default)
```

## Running the factory

```bash
bun run factory doctor                         # check the setup before a run
bun run factory run examples/specs/wordfreq.md # build a package from a spec
bun run factory report <runId>                 # print the report of a run
bun run factory intervene <runId> "<note>"     # record a human intervention
bun run factory author readme --example examples/authoring/readme-example.md
```

`factory doctor` checks, one line each, that the brain model answers
through its submit tool (naming the provider and model that answered),
whether Mozaik Cloud is off, on or refused (see below), that
`apb mcp` answers and the starter playbooks and the agent profile are
approved at their current versions, that the agent CLI is logged in, that
`o2b mcp` answers on the factory vault, and that git, Bun and npm are
installed. It names what to fix for every failed check.

`factory run <spec.md>` takes:

| Option | Effect |
| --- | --- |
| `--out <dir>` | Where the package is delivered (default `out/<spec name>`) |
| `--runtimes bun,npm` | The runtimes the delivered package must pass under |
| `--deliver-unverified` | Copy the integrated `main` to `--out` before any verification step, so a run cut off or killed during verification still leaves a package |
| `--cutoff <time>` | `HH:MM` local time today or an ISO 8601 instant with a zone; at that moment the live executor runs are stopped (each stop confirmed within 60 s), late results are discarded and delivery starts with what is integrated |
| `--task-concurrency <n>` | Task runs at once for this run (default 3; at most 4 executor runs at once across the process) |

It prints the run id, every task transition and decision, then the
outcome, the delivered directory and the path of the run's report. The
run's state, trace and report live under `runs/<runId>/`
(`trace.jsonl`, `report.md`); task trees live under `work/`.
`factory report <runId>` rebuilds the report from the trace alone. Exit
codes: 0 succeeded, 1 failed, 2 usage error, 3 partial. The first SIGINT or
SIGTERM takes the cutoff path; a second one exits at once with 130, since
the run state is saved on every change.

`factory author <kind> --example <file>` has the brain draft a playbook for
a kind of task from one worked example, APB create, validate and trial it,
and the brain's Critic approve or reject it. The example must be a local
file outside `runs/`, `work/`, `out/` and `hidden/`. It prints the outcome
and the playbook id and writes `runs/<runId>/authoring-report.md`. Exit
codes: 0 approved, 3 none found, 1 rejected or failed, 2 usage error.

### Trust model

The factory runs code it did not write. The acceptance commands are written
by the brain model, and the package under test is written by the coding
agents; both run on this machine as the operator's user. What limits them:

1. Every install, build, test, acceptance check and HTTP server sees an
   allowlisted environment only (`PATH`, `LANG`, `CI=1`, `PORT` where
   needed and a scratch `HOME` that lives for one batch), never the
   factory's own environment, so no provider key reaches it.
2. Installs run with `--ignore-scripts`; the build is its own step.
3. The run state and trace stay owner-only (`runs/<runId>/` is 0700, its
   files 0600), and the run state never holds a provider key.

This is not a sandbox: the code can read and write whatever the user can,
including this repository. The task trees live under `work/` inside it
because APB requires the trees it works in to be inside its project.
Run the factory on a machine or account you are fine exposing to that.

### The end-to-end run

```bash
bun run e2e examples/specs/wordfreq.md --deadline-min 30
```

The end-to-end run is the factory's main acceptance test. It runs
`factory run` on the practice spec under a unique spec name, then verifies
the delivered package on its own: the package tests under Bun and under
npm from clean copies, and every example of the spec under Node. It prints
the outcome, the wall time and the time and cost of every task, and passes
only when the outcome is `succeeded`, both runtimes pass and every example
holds. Every child process ends by the absolute deadline.

A recorded passing run of the `wordfreq` spec (three tasks after one
runtime re-plan, brain on GLM-5.3 Flash, coding agent Claude Code on
Sonnet 5.5):

| Task | Time | Cost |
| --- | --- | --- |
| `scaffold` | 25 s | $0.063 |
| `count-words` | 1 min 9 s | $0.065 |
| `cli-main` | 32 s | $0.096 |
| Whole run | 2 min 50 s | $0.227 |

The costs are the ones the agents reported plus the brain calls computed
from `config/prices.json`; the report of a run says which is which.

### The hidden run

```bash
bun run hidden todo-api.md csv-tool.md --cutoff 19:15 --hard-deadline 19:22 --report-by 19:26
```

One `factory run` per spec, all at once, each delivering into
`hidden/<spec name>/` with `--deliver-unverified`. Options (times are
`HH:MM` local or ISO 8601): `--cutoff` (default 19:15, passed to the
factory), `--hard-deadline` (default 19:22: a factory still running gets
SIGTERM, its process group SIGKILL 30 s later), `--report-by` (default
19:26: the steps after the runs end by then) and `--task-concurrency`
(default 2). Each delivery then gets a `.gitignore` of `node_modules/`, is
built in a copy with the built files put back, and its committable files
are started under Node alone. The script prints one row per spec and the
owner's steps; it never changes git state. The first Ctrl-C sends the
factories to their cutoff path, a second kills everything.

### The demo

For the demo, set `FACTORY_BRAIN_GATEWAY=1` (the brain on Claude through
the JigJoy gateway) and, to show the brain's loop live, the Mozaik Cloud
opt-in `FACTORY_MOZAIK_CLOUD=1`; both are described under "Configuration".

1. `bun run factory doctor`: every line passes, and the brain line names
   the provider and model that answered.
2. Start the APB dashboard in a second terminal (`apb dashboard`) and open
   it in a browser.
3. `bun run factory run examples/specs/demo-units.md --out <dir>`: two
   independent commands, so two executor runs overlap on the dashboard and
   in the trace; the run finishes in under 10 minutes.
4. `bun run factory report <runId>`: tasks, attempts, models, timings and
   cost.
5. The authoring result: `runs/<runId>/authoring-report.md` of a
   `factory author` run (above).
6. Offline fallback: `examples/replay/demo-units/` holds the plain log
   (`run.log`), the trace and the report of a recorded passing run of the
   same spec.

## Configuration

Copy `.env.example` to `.env` and fill it in. Bun loads `.env` for
`bun test`, so the integration smokes read it directly.

| Variable | What it is |
| --- | --- |
| `FACTORY_BRAIN_GATEWAY` | Set to `1` to use the JigJoy gateway as the brain's first provider (Claude credits are kept for the demo); otherwise Z.ai is primary and the `JIGJOY_*` keys are ignored |
| `JIGJOY_ANTHROPIC_API_KEY`, `JIGJOY_ANTHROPIC_BASE_URL` | Anthropic gateway (JigJoy), read only when `FACTORY_BRAIN_GATEWAY=1`, then both are required; Z.ai becomes the fallback, taken automatically for 60 s after a rate limit or outage and for 30 min after the gateway refuses the key or the balance. The `ANTHROPIC_*` names are never read, so Claude Code does not pick the gateway up |
| `FACTORY_MOZAIK_CLOUD`, `MOZAIK_API_KEY`, `MOZAIK_PROJECT_ID`, `MOZAIK_REDACTION` | Optional, opt-in: with `FACTORY_MOZAIK_CLOUD=1` and a Mozaik key, the brain's loop events (spec text, task descriptions, redacted executor reports) are sent to Mozaik Cloud and the live link is printed; `MOZAIK_REDACTION` defaults to `content` (texts sent as sizes only), `none` sends them in full; a key without the opt-in makes the brain refuse to start. Tests never export unless `FACTORY_TEST_MOZAIK_CLOUD=1` |
| `JIGJOY_ANTHROPIC_MODEL` | Model behind the gateway; optional, defaults to `claude-sonnet-4-6` |
| `ZAI_API_KEY` | API key of the brain model's OpenAI-compatible endpoint |
| `ZAI_BASE_URL` | Base URL of that endpoint; optional, defaults to `https://api.z.ai/api/coding/paas/v4` |
| `ZAI_MODEL` | Model id the brain uses; optional, defaults to `glm-5.3-flash` |
| `FALLBACK_API_KEY`, `FALLBACK_BASE_URL`, `FALLBACK_MODEL` | Optional second provider, used when the providers before it are rate-limited, down or refused; an OpenAI-compatible model with function calling and streaming, like the primary; set all three or none; `FALLBACK_MODEL` must differ from `ZAI_MODEL` (calls are routed by model name) |
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

## Agent profiles

The coding work runs through APB agent profiles under `.apb/profiles/`, one
per supported agent CLI and named after it:

| Profile | Agent CLI | Model |
| --- | --- | --- |
| `claude` | Claude Code | `claude-sonnet-5-5` |
| `codex` | Codex | `gpt-6-sol` |
| `opencode` | opencode | `opencode/glm-5.3-flash-free` |
| `zcode` | ZCode | `GLM-5.3-Flash` |
| `agy` | agy | `gemini-3.8-flash-high` |
| `grok` | Grok | `grok-4.3` |

Each has no fallback and the same short role prompt (`SOUL.md`). The four
starter playbooks (`scaffold`, `implement-task`, `repair`, `integrate`)
default to `claude`. To run them with another CLI, run the bootstrap with
`--agent` (below).

Claude Code loads every `CLAUDE.md` from its working directory up to the
filesystem root, and the task trees live inside this repository. The
factory therefore starts `apb mcp` with `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`
in its environment, which the agent processes inherit, so a coding agent
never sees this repository's own instructions. APB profiles choose which
variables an agent inherits but cannot set one, which is why the variable
comes from the factory and not from the profile.

## APB trust bootstrap

APB runs only playbooks and agent profiles that are approved in its trust
store, and the trust store belongs to the machine, not to the repository. On
a new machine, or after the profiles or the playbooks change, run:

```bash
bun run apb:bootstrap                 # starters keep their default profile
bun run apb:bootstrap --agent codex   # starters switched to the codex profile
```

From the repository root it:

1. re-writes every project profile under `.apb/profiles/` from its own
   `profile.yaml` and `SOUL.md`, which approves the profile's bundle, and
   checks that the write reports the bundle trusted, with no failed trust
   write and no unapproved skills;
2. with `--agent <cli>`, republishes the four starter playbooks through APB
   with that profile as their default (a new playbook version each; a
   starter that already defaults to it is left alone);
3. starts `apb mcp` and approves the `smoke`, `smoke-stall` and
   `smoke-fail` playbooks and the four starters;
4. prints the trust list entries it created.

The playbooks are approved by explicit confirmation rather than by an APB
trial: APB cannot trial a script playbook before the repository has its
first commit, and it would trial a coding playbook in a worktree of this
repository instead of a task tree. Review them before the first bootstrap.
The three smokes are single script nodes with no model and no file writes:
`smoke` prints one fixed line, `smoke-stall` sleeps for an hour so the stop
path can be exercised, and `smoke-fail` exits 1 so a node failure can be
observed. Each starter is one agent node that works in the task tree it is
given, owns only the paths it is told, runs `npm test` and `bun test`, and
reports a summary and its checks; only `integrate` commits (the merge it
resolves), and none pushes.

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
