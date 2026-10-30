# Spec Delta

## ADDED Requirements

### Requirement: Provider fallback

When the primary provider fails with a retryable error (rate limit,
unavailable, timeout) and a fallback is configured, the next try of the
same decision SHALL use the fallback, and the primary SHALL be skipped for a
cooldown (default 60 s). Non-retryable errors SHALL NOT switch providers.
The usage record of each try SHALL name the provider and model actually
used. The OpenAI client inside the endpoint retries on its own and cannot be
configured; the attempt deadline bounds those retries.

#### Scenario: Rate limited primary

- **WHEN** the primary answers with a rate-limit error and a fallback is configured
- **THEN** the next try uses the fallback, and the primary is not used again before the cooldown ends

### Requirement: Vendor request fields

A provider SHALL be able to carry fixed vendor fields merged into every request (for the
Z.ai model: thinking disabled), declared in the provider configuration, not
in the decision.

#### Scenario: Thinking disabled

- **WHEN** the Z.ai provider sends a request
- **THEN** the request body carries the configured field that disables thinking
