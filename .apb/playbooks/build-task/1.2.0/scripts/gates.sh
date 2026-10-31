#!/bin/sh
# Quality gates of a generated package, run in the task's working tree.
# The gates are the package's own scripts, so they follow whatever stack the
# scaffold set up: install, then each of typecheck, lint, format:check,
# build and test that package.json declares, in that order; typecheck,
# lint, format:check and test are required (build is optional). Every gate runs
# even after a failure, so one pass shows the whole picture; a failing gate
# prints the tail of its output. The last line is the verdict the playbook
# routes on: `GATES: green`, or `GATES: red: <failed gates>` with exit 1.
# POSIX sh only: macOS ships bash 3.2 as /bin/sh.

set -u

if [ ! -f package.json ]; then
  echo "no package.json in $(pwd)"
  echo "GATES: red: package.json"
  exit 1
fi

# Bun unless the package carries only an npm lock file.
pm=bun
if [ -f package-lock.json ] && [ ! -f bun.lock ] && [ ! -f bun.lockb ]; then pm=npm; fi
if ! command -v "$pm" >/dev/null 2>&1; then
  echo "$pm is not on PATH"
  echo "GATES: red: $pm"
  exit 1
fi

has_script() {
  node -e "const s=(JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts)||{}; process.exit(Object.prototype.hasOwnProperty.call(s, process.argv[1]) ? 0 : 1)" "$1" 2>/dev/null \
    || bun -e "const s=(await Bun.file('package.json').json()).scripts??{}; process.exit(Object.hasOwn(s, process.argv[2]) ? 0 : 1)" "$1" 2>/dev/null
}

log=$(mktemp)
failed=""
ran=""

run_gate() {
  name=$1
  shift
  if "$@" >"$log" 2>&1; then
    echo "ok    $name"
  else
    echo "FAIL  $name ($*)"
    tail -n 40 "$log" | sed 's/^/      /'
    failed="$failed $name"
  fi
  ran="$ran $name"
}

if [ "$pm" = bun ]; then
  run_gate install bun install
else
  run_gate install npm install --ignore-scripts
fi

if [ -z "$failed" ]; then
  for gate in typecheck lint format:check build test; do
    if has_script "$gate"; then run_gate "$gate" "$pm" run "$gate"; fi
  done
fi
rm -f "$log"

# The gates the stack requires; a package without one has bypassed it.
for gate in typecheck lint format:check test; do
  if ! has_script "$gate"; then failed="$failed $gate(missing)"; fi
done

if [ -z "$failed" ]; then
  echo "GATES: green:$ran"
  exit 0
fi
echo "GATES: red:$failed"
exit 1
