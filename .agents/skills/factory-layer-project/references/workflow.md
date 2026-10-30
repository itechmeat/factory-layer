# Workflow: roles, delegation, the delivery cycle

## Roles

1. **Orchestrator** (main session): talks to the owner, writes OpenSpec
   artifacts and briefs, dispatches subagents, reviews their reports against
   the change, decides the next step. It does not edit `src/` on large work.
2. **Research subagent**: reads the code base, the published `.d.ts` files of
   dependencies or the web; returns findings with `file:line` references.
   Never edits the repository.
3. **Implementation subagent**: works inside an explicit file scope with TDD
   and reports with verbatim check output.
4. **Reviewer**: a fresh agent that reads the diff, not the author's
   conclusions; returns findings only.

## The delivery cycle

1. `/opsx:propose` (skill `openspec-propose`): proposal, specs, design,
   tasks. `openspec validate <change> --strict`.
1a. Sol review of the artifacts (read-only Codex `gpt-6.1-sol`), revised
   until "Ready to implement: yes". No code before that approval.
2. `/opsx:apply` (skill `openspec-apply-change`): task by task, test first.
   Run `bun run check:fast` after each task group.
3. Before delivery: `bun run check` (full tier). It includes code-ranker and
   `bun audit`. Fix every violation; read `code-ranker docs base <ID>` before
   fixing a code-ranker finding.
4. Review cycle: an independent review of the diff (correctness, security,
   tests) plus a duplication sweep with `zg` (zvec-grep): refresh the index
   (`zg index`, local embedding on the CPU), then for every new exported
   function, type or helper run `zg query "<what it does>"` and merge real
   duplicates; code-ranker runs in the full gate. Fix the findings, re-run
   the full gate once.
5. `/opsx:archive` (skill `openspec-archive-change`), then
   `openspec validate --all --strict`.
6. Hand-over: report "ready for the commit approval" with the proposed
   commit title and body. The owner approves the commit; nothing is pushed
   without a separate approval.

## Briefs

A brief for a subagent states: the goal, the OpenSpec change and task ids,
the file scope and the files it must NOT touch, the check tier to run, the
report format (what changed, verbatim last lines of each check, deviations,
risks, a "Skill delta" section with rules learned). It also repeats the
repository rules a subagent cannot infer: English only, no em-dashes, no
commits, the Tailwind ban, Mozaik 4.2.0 from `dist/index.d.ts` only, APB
through `apb mcp` only.

## Parallel work

1. Disjoint file scopes may run in parallel in one tree; overlapping scopes
   are serialized.
2. Every brief lists the files the agent must not edit.
3. Heavy checks run one at a time; the fast tier is free.

## Reports

Every subagent ends with: what changed (files), the verbatim summary lines of
every check it ran, deviations from the brief with the reason, open risks,
and the skill delta. A claim without check output is not accepted.
