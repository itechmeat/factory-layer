---
name: factory-layer-project
description: "Working rules for the factory-layer repository (a software factory: Mozaik brain, APB hands, OSB memory; TypeScript on Bun). Use at the start of ANY task in this repository: orchestration, coding, OpenSpec changes, docs, review. Covers roles, TDD, the three check tiers, the layer rule and ports, coding standards, the OpenSpec flow and the self-improvement protocol: when a rule or a gotcha is learned, this skill is updated in the same change."
metadata:
  version: "0.4.1"
  created: "2026-10-30"
---

# factory-layer project rules

This skill is the single source of working rules for this repository. Every
agent (orchestrator or subagent) reads it before acting. When it conflicts
with a generic or vendored skill, this skill wins; when it conflicts with a
direct instruction of the owner, the owner wins and the new instruction is
recorded here (see Self-improvement).

The product design lives in
`docs/superpowers/specs/2026-10-30-factory-layer-design.md`.

## Quick navigation

| Topic | Reference |
| --- | --- |
| Roles, delegation, the delivery cycle, reports | `references/workflow.md` |
| Layers, ports, adapters, the layer rule and what may import what | `references/architecture.md` |
| Coding standards, tests, the check tiers and their steps | `references/coding-standards.md` |
| Feature development with OpenSpec | `references/openspec-flow.md` |
| Dated log of learned rules and gotchas | `references/rules-log.md` |

## Core rules (read every time)

1. **Roles.** The orchestrator writes specs and OpenSpec artifacts, briefs
   subagents and reviews their results; implementation subagents write code
   with TDD inside an explicit file scope. Details: `references/workflow.md`.
2. **OpenSpec first.** Every behaviour change goes through an OpenSpec change
   (propose, apply, archive). Chores that change no behaviour (dependency
   bumps, renames) may skip it. Details: `references/openspec-flow.md`.
3. **End-to-end first, TDD for failure paths.** The main gate is an
   end-to-end run (smokes, then a full practice-spec run). Unit tests,
   written test first and colocated as `src/<layer>/<module>.test.ts` on
   `bun:test`, cover only the failure paths an end-to-end run cannot
   reproduce (deadlines, stops, crash points, redaction, boundary
   validation); happy-path unit tests are removed. No coverage floor.
4. **Check tiers.** `bun run check:fast` in the loop; `bash scripts/check.sh
   standard` before a commit; `bun run check` (full) before delivery. A red
   gate is answered by re-running the failed file, then the tier, never by
   looping the full gate.
5. **Layer rule.** domain <- ports <- application <- adapters <- cli. A
   module imports its own layer or a lower one, never a higher one; type
   imports count. `KNOWN_VIOLATIONS` in `.dependency-cruiser.cjs` stays empty.
6. **The brain only decides.** The application owns orchestration and is the
   single writer of task state; the `Brain` port returns typed decisions.
   Nothing outside `src/adapters/brain-mozaik*` imports `@mozaik-ai/core`.
7. **Mozaik 4.2.0 exactly.** Code only against the published
   `node_modules/@mozaik-ai/core/dist/index.d.ts`. Never read the GitHub
   main branch as a reference: it has diverged.
8. **APB through `apb mcp` only.** The factory drives APB over its stdio MCP
   surface. A gap in APB is written down for a separate APB change; APB is
   never changed from this repository.
9. **Every wait has a deadline**, every external call a timeout, every
   failure a recorded outcome. Usage and cost are measured, estimated or
   marked unavailable, never invented.
10. **Fix what you see.** Crooked code, duplication or a broken rule met
    while working is fixed in the same change, with a test.
11. **Repository hygiene.** English only; no em-dashes and no exclamation
    marks in docs and user-facing strings; secrets only in `.env`
    (`.env.example` lists the names); `docs/private/` is git-ignored and is
    never referenced from tracked files; no machine paths, host names or
    personal settings in the repository.
12. **Owner gates.** Commits only after the owner approves the commit and its
    message; nothing is pushed or published without the owner's explicit
    approval for that action; no AI co-author trailers or AI attribution in
    commits, PRs or docs.
13. **Tailwind CSS is banned.** No `tailwindcss`, `@tailwindcss/*`,
    `tw-animate-css`, `tailwind-merge`, `@theme`/`@apply` or utility-class
    strings, in any file, dependency or skill.
14. **Exact versions from the registry.** A new dependency is added with the
    version `npm view <pkg> version` reports at the time, pinned exactly, and
    logged in `docs/versions.md` with the date.
15. **Sol approves the specs before any code.** Every change's artifacts
    (proposal, specs, design, tasks) go to a read-only review by Sol (Codex
    CLI, model `gpt-6.1-sol`) and are revised until Sol answers "Ready to
    implement: yes"; implementation starts only after that approval.
    Reviews are saved under `docs/private/reviews/`. Beyond spec approval
    Sol is an adviser: the orchestrator consults Sol on technical choices
    and makes the decisions itself.
16. **Large commits, each through the full cycle.** Prefer few large
    commits; each passes the full gate and the pre-push review cycle before
    it is offered to the owner for approval.
17. **Every commit is authored by Sol Aitken** `<solaiagent@gmail.com>`
    (GitHub `solaitken`). Check `git log -1 --format="%an <%ae>"` before
    offering a commit; GitHub CLI work for this repository runs as
    `solaitken`.
18. **zg and code-ranker in every cycle.** Before writing a new helper,
    search for an existing one with `zg query`; the review sweeps new code
    for duplicates with `zg`; `code-ranker check .` is clean (full gate).
    GitHub runs CodeQL (`.github/workflows/codeql.yml`) on every push and
    pull request to `main`.

## Self-improvement protocol

This skill grows with the project. Apply it, without being asked, whenever:

1. the owner states or corrects a rule;
2. a task reveals a repository fact or a gotcha that changes how work is
   done (a tool quirk, a failing pattern, a check that needs a workaround).

Procedure, in the same change as the work that taught it:

1. Phrase the rule in one imperative sentence with its reason.
2. Put it where it belongs: a core rule above if it applies to every task,
   otherwise the fitting reference.
3. Append a dated line to `references/rules-log.md`: date, rule, the event
   that taught it.
4. Bump `metadata.version` (patch for a rule, minor for a new reference).
5. Mention the change in one line of the final report.

Ask before recording a rule inferred from a single ambiguous event.

## Session start checklist

1. Read this file and `references/workflow.md`.
2. `git status` and `git log --oneline -5`: know the baseline.
3. `openspec list` to see the changes in flight; read the active one.
4. Load `references/architecture.md` before editing `src/`.
