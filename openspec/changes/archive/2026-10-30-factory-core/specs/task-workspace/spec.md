# Spec Delta

## Purpose

The git layout of a run: one repository per spec, one tree per task attempt,
integration on a main branch, and a clean delivery copy.

## ADDED Requirements

### Requirement: Spec repository

The workspace SHALL create, for a spec, a git repository at
`work/<spec>/` with a branch `main` and one initial commit, or reuse an
existing one. Every git command SHALL have a timeout (default 60 s) and a
failure SHALL be a typed error carrying the command, the exit code and the
redacted stderr tail.

#### Scenario: Fresh repository

- **WHEN** the workspace is prepared for a spec with no repository
- **THEN** `work/<spec>/` is a git repository on `main` with one commit

### Requirement: Executor scratch excluded

Preparing a spec repository SHALL add `.factory/` to its `info/exclude`, so
files the executor writes there are never committed by any task tree.

#### Scenario: Task file not committed

- **WHEN** a file is written under `.factory/` in a task tree and the tree is committed
- **THEN** the commit does not contain it

### Requirement: Task trees

The workspace SHALL create a git worktree for a task and revision at
`work/<spec>/.trees/<task>-r<revision>` on a branch named after them,
branched from the current `main`. Creating the tree for the same task and
revision twice SHALL return the existing tree.

#### Scenario: Idempotent tree

- **WHEN** the tree for task `api` revision 1 is requested twice
- **THEN** both calls return the same directory and only one worktree exists

### Requirement: Integration tree

The workspace SHALL commit all changes in a task tree, then prepare an
integration tree: a worktree on a temporary branch from the current `main`
into which the task's branch is merged. A clean merge SHALL return the
integration tree and its commit; a conflict SHALL be reported with the
conflicting paths and leave `main` and the task branch unchanged.

#### Scenario: Conflict reported

- **WHEN** two task branches change the same line and the second is prepared for integration
- **THEN** a conflict naming the file is reported and `main` is unchanged

#### Scenario: Advance only on request

- **WHEN** an integration tree is prepared cleanly and not advanced
- **THEN** `main` still points at its previous commit

### Requirement: Advancing main

`main`
SHALL change only through an explicit advance to a given integration commit,
as a fast-forward that fails when `main` moved in between. The workspace
SHALL report which commit `main` points at.

#### Scenario: Main moved

- **WHEN** an advance is requested to an integration commit whose base is no longer `main`
- **THEN** the advance fails and `main` is unchanged

### Requirement: Conflict hand-over

For a conflict, the workspace SHALL merge `main` into the task branch inside
the task's own tree and leave the conflict in that tree (conflict markers,
merge in progress) for an executor run to resolve and commit; it SHALL
report whether the tree still has unresolved paths.

#### Scenario: Conflict in the task tree

- **WHEN** the conflict is handed over
- **THEN** the task tree has the conflicting file with markers and reports it unresolved

### Requirement: Delivery copy

The workspace SHALL produce a clean copy of `main` (a fresh checkout without
untracked files) for verification, and SHALL copy a verified tree to an
output directory without `.git` and `node_modules`, replacing earlier
contents of that directory.

#### Scenario: Clean copy

- **WHEN** `main` is delivered to `out/todo-cli/`
- **THEN** the directory holds the tracked files of `main` and no `.git` or `node_modules`
