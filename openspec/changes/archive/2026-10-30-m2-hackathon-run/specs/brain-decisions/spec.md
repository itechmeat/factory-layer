# Spec Delta

## ADDED Requirements

### Requirement: Playbook review decision

The Critic SHALL review a playbook draft given the draft, its validation
result and its trial result, and answer through its submit tool with
`approve` or `reject` and at least one reason; the answer is validated like
every other decision.

#### Scenario: Review without reasons

- **WHEN** the model submits a review without reasons
- **THEN** the submission is refused with the schema message and the model may submit again within the attempt
