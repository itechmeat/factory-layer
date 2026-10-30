#!/usr/bin/env bash
# Quality gate for factory-layer. THREE TIERS, one content:
#
#   fast      the TDD loop: every cheap static step plus the unit tests
#             SELECTED BY THE CHANGE (`scripts/select-tests.ts` walks the
#             import graph backwards from every changed file). No coverage,
#             no build.
#   standard  before a commit: everything `fast` runs, unrestricted: every
#             unit test (coverage reported, no floor), and the
#             CLI build.
#   full      before delivery: everything `standard` runs, plus the
#             integration tests (real `apb mcp`, OSB, the brain smoke; the
#             step skips with a message until `tests/integration/` holds a
#             test), `code-ranker` and `bun audit`. It is the DEFAULT: a bare
#             `check.sh` is the full gate.
#
# The tiers are nested BY CONSTRUCTION: every step is unconditional (all
# tiers), inside `if [ "$TIER" != fast ]` (standard and full) or inside
# `if [ "$TIER" = full ]` (full only). Cheap static steps run first, so a
# static failure surfaces in seconds.
#
# Usage: bash scripts/check.sh [fast|standard|full] [repo-or-worktree-dir]
set -euo pipefail
TIER=""
DIR=""
for arg in "$@"; do
  case "$arg" in
    fast | standard | full)
      if [ -n "$TIER" ]; then
        echo "error: two tiers given ($TIER and $arg); name exactly one" >&2
        exit 2
      fi
      TIER="$arg"
      ;;
    *)
      if [ -n "$DIR" ]; then
        echo "error: two directories given ($DIR and $arg); name exactly one" >&2
        exit 2
      fi
      DIR="$arg"
      ;;
  esac
done
TIER="${TIER:-full}"
DIR="$(cd "${DIR:-$(pwd)}" && pwd)"
cd "$DIR"

echo "# check.sh: $DIR (tier=$TIER)"

if [ "$TIER" = fast ]; then
  # ONE base for the whole tier, asked for once (`--print-base`), so nothing
  # downstream can measure a different change.
  FAST_ROOTS="src scripts tests/integration/support"
  if ! FAST_BASE="$(bun run scripts/select-tests.ts --print-base)"; then
    echo "error: could not resolve the base of this change; nothing was run" >&2
    exit 1
  fi
  export FACTORY_FAST_BASE="$FAST_BASE"
  echo "# fast tier: base $FACTORY_FAST_BASE, roots $FAST_ROOTS"
fi

echo "== typecheck"
bun run typecheck
echo "== lint"
bun run lint
echo "== format"
bun run format:check
echo "== module headers"
bun run check:headers
echo "== size"
bun run check:size
echo "== arch (layer rule)"
bun run check:arch
echo "== dead code"
bun run check:dead
echo "== unit tests (tier=$TIER)"
if [ "$TIER" = fast ]; then
  # Read into an ARRAY and expanded quoted, so a path with a space stays one
  # filter. A selector failure is the gate's failure and says so.
  # shellcheck disable=SC2086 # FAST_ROOTS is a word list on purpose.
  if ! SELECTED_OUTPUT="$(bun run scripts/select-tests.ts $FAST_ROOTS)"; then
    echo "error: scripts/select-tests.ts could not name the tests this change reaches; nothing was run" >&2
    exit 1
  fi
  SELECTED=()
  while IFS= read -r selected_line; do
    [ -n "$selected_line" ] && SELECTED+=("./$selected_line")
  done <<<"$SELECTED_OUTPUT"
  if [ ${#SELECTED[@]} -eq 0 ]; then
    echo "   no unit test is reached by this change"
  else
    echo "   ${#SELECTED[@]} selected test file(s)"
    bun test --config=scripts/fast-bunfig.toml "${SELECTED[@]}"
  fi
else
  bun run test
fi

if [ "$TIER" != fast ]; then
echo "== build"
rm -rf dist
bun run build
fi

if [ "$TIER" = full ]; then
echo "== integration tests"
if [ -d tests/integration ] && [ -n "$(find tests/integration -name '*.test.ts' -print -quit)" ]; then
  bun test --config=scripts/fast-bunfig.toml ./tests/integration
else
  echo "   no integration tests yet (tests/integration/*.test.ts); skipped"
fi
echo "== code-ranker"
if command -v code-ranker >/dev/null 2>&1; then
  code-ranker check .
else
  echo "error: code-ranker is not installed; the full tier needs it" >&2
  exit 1
fi
echo "== bun audit"
bun audit
fi

echo "== check.sh: OK ($TIER)"
