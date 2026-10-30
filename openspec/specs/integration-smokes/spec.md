# integration-smokes Specification

## Purpose
The full check tier proves, against the real systems, that the brain, APB and
OSB links work and fail in a known way. These checks guard delivery and are
the base of the future `factory doctor`.

## Requirements

### Requirement: Prerequisites are explicit

Each integration check SHALL verify its prerequisites first (a brain key in
the environment, `apb` or `o2b` on the PATH) and SHALL fail with a message
that names the missing prerequisite and how to provide it. A check SHALL
never pass silently when its prerequisite is missing.

#### Scenario: Missing brain key

- **WHEN** the brain checks run without `ZAI_API_KEY`
- **THEN** they fail with a message naming `ZAI_API_KEY` and `.env.example`

### Requirement: Brain link

The suite SHALL prove that the configured brain model performs a function
call through the guarded inference runner, that a wrong key yields a
non-retryable provider error, and that a deadline shorter than any real
answer yields a timeout error, each within 120 s.

#### Scenario: Brain checks pass

- **WHEN** the brain checks run with a valid key
- **THEN** the function call, the provider error and the timeout are each observed as specified

### Requirement: Hands link

The suite SHALL start `apb mcp` in the factory project with `APB_EXECUTION=cli`,
start a supervised run of the `smoke` playbook, follow it with supervisor
waits in bounded slices until it finishes, and assert that it succeeded
within a run limit of 300 s. The APB server SHALL be stopped whatever the
outcome.

#### Scenario: Smoke run succeeds

- **WHEN** the hands check runs
- **THEN** the supervised `smoke` run is observed to finish successfully within the limit and no `apb mcp` process remains

### Requirement: Absolute call deadlines

Every call the hands check makes SHALL be bounded by an absolute deadline:
the run deadline while following the run, the cleanup deadline while
stopping it; no supervisor wait or cleanup call may outlast its deadline.

#### Scenario: Wait in flight at the run deadline

- **WHEN** a supervisor wait is in flight when the run deadline arrives
- **THEN** the wait ends by the deadline and the stop path starts

### Requirement: Run cleanup

On a host-task wait, an error or the run limit, the hands check SHALL stop
the run through `apb mcp` and wait, within a separate cleanup budget of
60 s, until the run is terminal and its driver is gone, before it stops the
APB server. The stop path SHALL be exercised against a playbook that never
finishes within a short run limit.

#### Scenario: Smoke run does not finish

- **WHEN** the stalling playbook runs with a 20 s run limit
- **THEN** the run is stopped, observed terminal with its driver gone, and no `apb mcp` process remains

### Requirement: Memory link

The suite SHALL start the OSB MCP server on a dedicated factory vault (never
a personal vault; the vault and its configuration come from the environment,
`FACTORY_OSB_VAULT` and `FACTORY_OSB_CONFIG`), complete the handshake, list
its tools, and stop it, within 60 s.

#### Scenario: Memory handshake

- **WHEN** the memory check runs with the factory vault configured
- **THEN** the handshake completes, the tool list is not empty, and no server process remains
