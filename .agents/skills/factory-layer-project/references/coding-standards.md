# Coding standards and quality gates

## TypeScript

1. The compiler flags in `tsconfig.json` are policy: `strict`,
   `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
   `noPropertyAccessFromIndexSignature`, `erasableSyntaxOnly` (no enums,
   namespaces or parameter properties), `verbatimModuleSyntax` (`import type`
   for types). Server-side only: no DOM types.
2. Every module opens with a JSDoc header (`/** ... */`) stating its
   responsibility and, where it has one, its main invariant.
   `scripts/header-check.ts` enforces it. Comments in English.
3. Small modules with one responsibility. 400 lines is the smell (printed by
   `scripts/size-check.ts`), 700 is the hard limit. Split before it hurts.
4. SOLID and DRY: depend on ports, not on implementations; one place for
   each rule; no copy-pasted logic.
5. Zod at every boundary: JSON from disk or the network, MCP results, model
   output, config and env. Inside the core, trust the parsed types. No
   hand-written `typeof` checks over parsed JSON where Zod fits.
6. No speculative robustness: no defensive code for situations the types
   and the boundary schemas already exclude, no options nobody asked for.
7. Tunables are exported `const` values in UPPER_SNAKE_CASE with units in the
   name or the comment (`BRAIN_CALL_DEADLINE_MS`).
8. Errors carry context; a failure is a value the caller records, not a
   swallowed exception.
9. Model prices in `config/prices.json` come from the provider's live
   pricing page or API, each entry with its date and source URL; a model
   that cannot be sourced is left out (it then prices as unavailable).
   Cached tables in skills lag: on 2026-10-30 one listed Sonnet 5.5 cache
   reads at twice the live price.

## Lint and format

1. `oxlint --type-aware --deny-warnings`, configured in `.oxlintrc.json`.
   Every disabled rule is disabled there with its reason; inline
   `oxlint-disable` comments are not used (`reportUnusedDisableDirectives`).
2. `oxfmt` formats `src` and `scripts`; Markdown and `openspec/` are not
   formatted.

## Tests

1. `bun:test`, colocated `<module>.test.ts`. Test names describe behaviour.
2. TDD: a failing test first.
3. Time, randomness and IO are injected (the `Clock` port, fakes of ports),
   so unit tests are deterministic and offline.
4. Integration tests (real `apb mcp`, OSB, the brain smoke) live in
   `tests/integration/` and run only in the full tier; the offline tests of
   their helpers in `tests/integration/support/` run with the unit tests.
4a. Test doubles (fakes of endpoints, tool callers, ports) live in a
   `testing/` folder next to the code they fake (`src/**/testing/`). They are
   excluded from coverage in `bunfig.toml`; code shared by tests
   and scripts that is not a double belongs under `src/`, not `tests/`.
5. End-to-end first (owner decision 2026-10-30). The main gate is
   end-to-end: the integration smokes now, a full practice-spec run (spec in,
   package with passing tests out) from M1 on. Unit tests are kept only for
   the failure paths an end-to-end run cannot reproduce on demand: deadlines
   and timeouts, stops and teardown, crash points and restart
   reconciliation, secret redaction, validation at boundaries. Unit tests of
   happy paths or internal mechanics that an end-to-end run already covers
   are removed. Coverage is reported, with no floor.
6. No test exports to Mozaik Cloud. The preload
   `tests/support/no-cloud-export.ts` empties the Mozaik key variables
   unless `FACTORY_TEST_MOZAIK_CLOUD=1`; every bunfig a test run uses
   (`bunfig.toml`, `scripts/fast-bunfig.toml`) lists it.

## Check tiers (`scripts/check.sh`)

| Tier | Steps |
| --- | --- |
| fast | typecheck, lint, format check, module headers, size, arch (dependency-cruiser), dead code (knip), unit tests selected by the change |
| standard | fast, but all unit tests (coverage reported, no floor), then the CLI build (`bun build` to `dist/`) |
| full (default) | standard, then integration tests (skipped with a message while `tests/integration/` is empty), code-ranker, `bun audit` |

The tiers are nested by construction: a step is unconditional, inside
`if [ "$TIER" != fast ]` or inside `if [ "$TIER" = full ]`.

Known tool notes:

1. dependency-cruiser 18.x refuses TypeScript 7 and prints a
   `missing-tsc-transpiler` warning; it parses with `@swc/core` instead
   (`parser: 'swc'`), which keeps `import type`. The warning is expected.
2. The fast tier selects tests by walking relative imports backwards from the
   changed files (`scripts/select-tests.ts`); a changed manifest or lockfile,
   or a repository with no commit yet, selects every test.
3. knip ignores the runtime dependencies that no module imports yet
   (`ignoreDependencies` in `knip.json`); remove each entry when the first
   module imports it.
4. An export that waits for a later change (a spec constant or type no
   module reads yet) carries a `@pending <which change reads it>` JSDoc
   tag; knip skips tagged exports (`"tags": ["-pending"]`). Drop the tag
   when the first reader lands. Testing barrels (`src/**/testing/index.ts`)
   are knip entries, and system binaries spawned by test helpers go in
   `ignoreBinaries`. Production entries carry `!`, so `bunx knip
   --production` reads the code without the tests; it is not a gate (it
   lists the port barrel types the fakes use, the smoke-only adapters and
   `replay.ts`), but run it when removing code.
5. A child process for generated code or git never inherits
   `process.env`: `runCommand` takes the whole environment, built by
   `src/adapters/child-env.ts` (`generatedCodeEnv` with a scratch HOME per
   batch, `gitEnv`). A test that spawns `bash` sets `HOME` too: bash on a
   socket stdin (Bun's pipes) sources `~/.bashrc` from the passwd home.
