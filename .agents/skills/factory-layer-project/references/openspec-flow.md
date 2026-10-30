# Feature development with OpenSpec

The repository uses OpenSpec (CLI `openspec`) with the stock `spec-driven`
schema. `openspec/config.yaml` carries the project context (purpose, stack,
layer rule, conventions) and per-artifact rules.

## When

1. Every change of behaviour: a new capability, a changed contract, a new
   adapter or port.
2. Not for chores that change no behaviour (a dependency bump, a rename, a
   lint clean-up); those go straight to the check tiers.

## The flow

1. **Explore** (optional, `/opsx:explore`): think through the problem; no
   code.
2. **Propose** (`/opsx:propose <name>`): `proposal.md`, delta specs under
   `specs/`, `design.md` when the change has a design decision, `tasks.md`.
   Name the layers touched and check the layer rule. Then
   `openspec validate <name> --strict`.
3. **Apply** (`/opsx:apply <name>`): tasks in order, test first, ticked as
   they land; `bun run check:fast` after each group. When the work shows the
   artifacts are wrong, update them first (`/opsx:update`).
4. **Deliver**: the full gate (`bun run check`), code-ranker clean, the
   review cycle.
5. **Archive** (`/opsx:archive <name>`): only after every check is green;
   then `openspec validate --all --strict`. The commit carries the archived
   change under `openspec/changes/archive/` and the updated `openspec/specs/`.
6. **Sync** (`/opsx:sync`): merges delta specs into the main specs without
   archiving, when a change is long-lived.

## Content rules

1. OpenSpec documents are outsider-facing English: no machine paths, no
   personal settings, no references to `docs/private/`.
2. Specs describe behaviour (inputs, outputs, failure handling, deadlines),
   not implementation.
3. A requirement that names an external call names its timeout.
