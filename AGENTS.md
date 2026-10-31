# AGENTS.md

The single source of instructions for coding agents in this repository.
`CLAUDE.md` only imports this file.

## What this is

Factory Layer (`factory-layer`) is a software factory: it takes a one-page
product spec and autonomously produces a small TypeScript project (a CLI or an
HTTP API) whose tests pass. A brain of concurrent Mozaik agents decides, APB (driven through
`apb mcp`) does the coding work, OSB keeps the memory of past runs. Design:
`docs/superpowers/specs/2026-10-30-factory-layer-design.md`.

## Layers and ports

Lowest first: `domain` <- `ports` <- `application` <- `adapters` <- `cli`
(`src/<layer>/`). A module imports its own layer or a lower one, never a
higher one; type imports count. Enforced by dependency-cruiser
(`.dependency-cruiser.cjs`, `KNOWN_VIOLATIONS` stays empty).

1. `domain`: pure types and rules with their Zod schemas. No IO, no SDKs.
2. `ports`: `Brain` (typed decisions only), `Executor`, `PlaybookAuthoring`,
   `Memory`, `TraceSink`, `Clock`, `CostTable`, `Workspace`.
3. `application`: the factory state machine, the single writer of task state.
4. `adapters`: `brain-mozaik`, `hands-apb`, `memory-osb`, `mcp-stdio`,
   `workspace-git`, `trace-fs`, `report-html`.
5. `cli`: the composition root, the only place that picks adapters.

## Commands

| Command | What it runs |
| --- | --- |
| `bun run check:fast` | typecheck, lint, format check, module headers, size, arch, dead code, unit tests reached by the change |
| `bash scripts/check.sh standard` | fast plus all unit tests (coverage reported, no floor) and the CLI build |
| `bun run check` | full (default): standard plus integration tests, code-ranker, `bun audit` |
| `bun run test` | all unit tests with coverage |
| `bun run typecheck`, `lint`, `format`, `format:check`, `check:arch`, `check:dead` | single steps |

## Workflow

1. Propose the change with OpenSpec (`/opsx:propose`).
2. Apply it with TDD (`/opsx:apply`): a failing test first, then the code.
3. Run `bun run check:fast` while working.
4. Run `bun run check` (full) before delivery.
5. code-ranker must be clean (part of the full tier; read
   `code-ranker docs base <ID>` before fixing a finding).
6. Review cycle: an independent review of the diff, findings fixed, the full
   gate once more.
7. Archive the change (`/opsx:archive`) and run
   `openspec validate --all --strict`.

## Coding standards

1. SOLID and DRY; small modules (400 lines is the smell, 700 the hard limit).
2. Every module opens with a JSDoc header stating its responsibility.
3. Zod at every boundary (disk, network, MCP results, model output, env).
4. No speculative robustness: no code for cases the types already exclude.
5. Fix what you see in the same change, with a test.
6. No inline lint disables; a rule decision lives in `.oxlintrc.json` with
   its reason.
7. Every wait has a deadline; usage and cost are measured, estimated or
   unavailable, never invented.

## External systems

1. **Mozaik**: code only against the published npm `@mozaik-ai/core` 4.2.0,
   `node_modules/@mozaik-ai/core/dist/index.d.ts`. Never use the GitHub main
   branch as a reference. Never upgrade past 4.2.0.
2. **APB**: used only through `apb mcp`. Never change APB from this
   repository; a gap is written down for a separate APB change.

## Repository rules

1. English only in the repository.
2. No em-dashes and no exclamation marks in docs and user-facing strings.
3. Commits only after the owner approves them.
4. No AI co-author trailers or AI attribution in commits, PRs or docs.
5. Nothing is pushed or published without the owner's explicit approval for
   that action.
6. `docs/private/` is git-ignored and is never referenced from public files.
7. Secrets only in `.env`; `.env.example` lists the names.
8. Dependencies are pinned to exact versions taken from the registry and
   logged in `docs/versions.md`.

## Tailwind CSS is banned

No `tailwindcss`, `@tailwindcss/*`, `tw-animate-css`, `tailwind-merge`,
`@theme`/`@apply`, and no utility-class strings, in any file, dependency or
skill. If a task seems to need it, say so and stop.

## Skills

Real directories in `.agents/skills/`, linked as `.claude/skills/`.

1. `factory-layer-project`: the project rules (roles, TDD, check tiers,
   layers, coding standards, OpenSpec flow, self-improvement). Read first.
2. `openspec-propose`: create a change with all artifacts.
3. `openspec-apply-change`: implement the tasks of a change.
4. `openspec-archive-change`: archive a finished change.
5. `openspec-explore`: think a problem through before proposing.
6. `openspec-sync-specs`: merge delta specs into the main specs.
7. `openspec-update-change`: revise the artifacts of a change.
8. `bun`: Bun runtime, test runner, bundler and package manager reference.
9. `oxlint`: oxlint configuration and type-aware linting.
10. `oxfmt`: oxfmt configuration and usage.
11. `lefthook`: Git hooks configuration.
12. `zod`: Zod 4 schemas and boundary validation.
13. `unslop`: remove AI writing tells from prose.

Slash commands: `/opsx:propose`, `/opsx:apply`, `/opsx:archive`,
`/opsx:explore`, `/opsx:sync`, `/opsx:update` (`.claude/commands/opsx/`).
