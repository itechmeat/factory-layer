---
name: lefthook
description: Lefthook 2.x (fast Git hooks manager) reference for this repository. Use when editing `lefthook.yml`, adding or debugging a pre-commit or pre-push hook, filtering by staged files or globs, skipping hooks, or installing hooks.
user-invocable: false
---

# Lefthook

Lefthook runs Git hooks declared in `lefthook.yml`. This repository pins
lefthook 2.2.2 as a devDependency (`docs/versions.md`). Upstream docs:
https://lefthook.dev (source: the `docs/` folder of `evilmartians/lefthook`).

## Repository policy

1. Hooks stay CHEAP. `pre-commit` only checks formatting of the staged files.
   Type checks, lint, tests, architecture and dead-code checks belong to
   `scripts/check.sh` (`bun run check:fast` while working, `bun run check`
   before delivery), never to a hook.
2. Install or refresh the hooks with `bun run hooks:install`
   (`lefthook install`). Bun blocks package lifecycle scripts by default, so
   `bun install` alone does not install them.
3. A hook never rewrites files silently: no `stage_fixed: true` on formatters.
   The hook fails, the author runs `bun run format` and stages the result.
4. Local, personal overrides go into `lefthook-local.yml` (git-ignored by
   convention, never committed).

## Config shape

```yaml
pre-commit:
  parallel: true            # run the jobs of this hook concurrently
  commands:
    format:
      glob: "*.{ts,js,json}"  # filter the file list; a list of globs is allowed
      exclude:
        - "openspec/**"
      run: bunx oxfmt --check {staged_files}
```

Hook-level keys: `parallel`, `piped` (stop at the first failure, run in
order), `follow` (stream output), `files` (a command that lists files),
`skip`, `only`, `exclude_tags`, `exclude`, `fail_on_changes`, `jobs`.

Command (job) keys: `run`, `glob`, `exclude`, `files`, `file_types`, `root`
(run inside a subdirectory), `tags`, `env`, `skip`, `only`, `fail_text`,
`stage_fixed`, `interactive`, `use_stdin`, `priority`.

`jobs:` is the newer list form of `commands:` (named or unnamed jobs, with
`group:` for nested parallel or piped groups). Either form works; keep one
form per file.

## Templates in `run`

| Template | Expands to |
| --- | --- |
| `{staged_files}` | staged files after `glob`/`exclude` filtering (pre-commit) |
| `{push_files}` | files in the commits being pushed (pre-push) |
| `{all_files}` | every tracked file after filtering |
| `{files}` | output of the `files:` command |
| `{0}`, `{1}` | Git hook arguments (for example the commit message file) |

When the filtered list is empty the job is skipped (`no files for inspection`).

## Skipping

1. `skip: [merge, rebase]` or `skip: [{ ref: main }]` in the config.
2. `LEFTHOOK=0 git commit ...` disables all hooks for one command (use only
   with the owner's consent; the hook protects the repository).
3. `LEFTHOOK_EXCLUDE=format git commit ...` skips named jobs or tags.

## CLI

| Command | Purpose |
| --- | --- |
| `lefthook install` | write `.git/hooks/*` for every hook in the config |
| `lefthook uninstall` | remove them |
| `lefthook run pre-commit` | run a hook by hand (`--all-files`, `--file <path>`, `--jobs <name>`) |
| `lefthook validate` | validate the config against the schema |
| `lefthook dump` | print the merged config (main, local and remotes) |
| `lefthook check-install` | exit 0 when the hooks are installed and current |

Environment: `LEFTHOOK_VERBOSE=1` for debug output, `LEFTHOOK_CONFIG=<file>`
to point at another config, `LEFTHOOK_OUTPUT=` to choose output sections,
`NO_COLOR=1` to drop colors.

## Testing a hook without touching the real index

Stage into a throwaway index so the working repository's index stays as it
was:

```bash
export GIT_INDEX_FILE="$PWD/node_modules/.hook-test-index"
git add src && bunx lefthook run pre-commit
rm "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
```
