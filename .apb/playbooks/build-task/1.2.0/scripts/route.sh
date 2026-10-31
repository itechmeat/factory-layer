#!/bin/sh
# Routes the run by its mode param: prints one JSON object {"mode": ...}
# whose field the playbook's edges read. An unknown mode is a failure.
set -eu
. "$(dirname "$0")/lib.sh"
mode=$(param mode)
case "$mode" in
  scaffold | implement | repair) printf '{"mode":"%s"}\n' "$mode" ;;
  *) echo "build-task: unknown mode '$mode'" >&2; exit 2 ;;
esac
