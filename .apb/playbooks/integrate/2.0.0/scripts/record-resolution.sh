#!/bin/sh
# Commits the resolved merge in the task's working tree once the gates are
# green. Idempotent: when no merge is in progress and HEAD is already a merge
# commit, an earlier attempt committed it and there is nothing to do. A
# conflict marker left in a tracked file refuses the commit.
# POSIX sh only: macOS ships bash 3.2 as /bin/sh.

set -u

if ! git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  if git rev-parse -q --verify HEAD^2 >/dev/null; then
    echo "MERGE: already committed"
    exit 0
  fi
  echo "MERGE: no merge in progress and HEAD is not a merge commit"
  exit 1
fi

git add -A || exit 1
# git grep reads the staged content, so any path (spaces included) is covered.
if git grep --cached -l -E '^(<<<<<<<|>>>>>>>) '; then
  echo "MERGE: conflict markers left in the files above"
  exit 1
fi
git commit --no-edit -q || exit 1
echo "MERGE: committed $(git rev-parse --short HEAD)"
