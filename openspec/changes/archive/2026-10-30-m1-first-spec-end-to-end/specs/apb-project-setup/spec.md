# Spec Delta

## MODIFIED Requirements

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
