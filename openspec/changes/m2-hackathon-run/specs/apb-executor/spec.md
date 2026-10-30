# Spec Delta

## ADDED Requirements

### Requirement: Trial run stop

Playbook authoring over `apb mcp` SHALL find the runs of a playbook
started at or after a given instant and stop each with a bounded
confirmation (60 s), reporting every run as stopped or unconfirmed.

#### Scenario: Trial left running

- **WHEN** a trial call timed out and its run is still live in APB
- **THEN** the run is found by its playbook and start time, stopped and confirmed, and the result names its run id
