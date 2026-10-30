# apb-project-setup Specification

## Purpose
APB executes the factory's coding work. This capability defines the APB
project configuration the factory ships with: how runs execute, which agents
run the nodes, which playbooks exist from the start, and how they become
trusted.

## Requirements

### Requirement: No host execution

The project APB configuration SHALL disable the host fallback
(`execution.fallback_to_host: false`), and the factory SHALL start `apb mcp`
with `APB_EXECUTION=cli`, so that agent tasks run only through agent CLIs and
never fall back to a host agent; APB-managed script nodes run as usual. A run
the factory observes in a state that waits for host tasks (`pending_tasks`)
SHALL be treated as an executor failure immediately, never waited on.

#### Scenario: Configuration is in place

- **WHEN** the project APB configuration is read
- **THEN** host fallback is disabled

### Requirement: Agent profiles

The project SHALL define a coding profile whose primary executor is Claude
Code and whose fallback is Codex, plus any further profiles the starter
playbooks reference. In this change the profiles reference no skills. Profiles SHALL contain no machine paths, personal
settings or credentials.

#### Scenario: Profiles validate

- **WHEN** `apb validate` runs on the project
- **THEN** every profile and every profile reference in the playbooks is valid

### Requirement: Starter playbooks

The project SHALL ship the playbooks `scaffold` (a package skeleton whose
tests run under both `npm test` and `bun test`), `implement-task` (code and
unit tests for given owned paths), `repair` (fix given failing checks) and
`integrate` (resolve a merge conflict), a `smoke` playbook that completes
deterministically without calling any model, and a `smoke-stall` playbook
that runs one model-free script node far longer than any smoke limit. Every playbook SHALL validate.

#### Scenario: All playbooks validate

- **WHEN** `apb validate` runs on the project
- **THEN** it reports no error for any of the six playbooks

### Requirement: Smoke playbook trust

The `smoke` and `smoke-stall` playbooks SHALL run model-free scripts only and
SHALL each be approved once (by explicit confirmation after their scripts are
reviewed, since APB cannot trial a script playbook before the first commit), and every project profile
bundle SHALL be approved, so that a supervised run of `smoke` started through
`apb mcp` is accepted without a further human step. Trial and approval of the
four starter playbooks are not part of this requirement.

#### Scenario: Smoke playbook is trusted

- **WHEN** the `smoke` playbook is started through `apb mcp` with supervision
- **THEN** APB accepts the run without asking for an approval or an acknowledgement

### Requirement: Fresh-machine bootstrap

The README SHALL describe the trust bootstrap for a fresh machine (approve
the project profile bundles, checking that each write reports the bundle
trusted with no unapproved skills and no trust write failure, then approve
`smoke`, `smoke-stall` and the four starter playbooks after reviewing their
scripts and prompts), and the bootstrap SHALL be verified once against an
APB configuration directory that starts with an empty trust list, ending
with both supervised smokes run against it.

#### Scenario: Fresh machine

- **WHEN** the documented bootstrap runs against an empty trust store
- **THEN** afterwards `smoke`, `smoke-stall`, the four starter playbooks and every project profile bundle are approved, and both supervised smokes are accepted
