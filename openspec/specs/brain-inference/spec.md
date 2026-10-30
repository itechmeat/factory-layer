# brain-inference Specification

## Purpose
The brain reasons through a hosted model: Anthropic through the JigJoy
gateway when switched on, else an OpenAI-compatible endpoint. This capability defines one model call: how it is configured, how
long it may take, how it fails and how its usage is reported.

## Requirements

### Requirement: Configuration from the environment

The brain configuration SHALL be read from the environment and validated:
`ZAI_API_KEY` (required, non-empty), `ZAI_BASE_URL` (URL, default
`https://api.z.ai/api/coding/paas/v4`), `ZAI_MODEL` (default
`glm-5.3-flash`). A fallback provider is configured only when all three of
`FALLBACK_API_KEY`, `FALLBACK_BASE_URL` and `FALLBACK_MODEL` are non-empty;
a partially set fallback SHALL be a configuration error. Errors SHALL name
the variable and SHALL never print a key value.

#### Scenario: Primary only

- **WHEN** only the `ZAI_*` variables are set
- **THEN** the configuration has the primary provider and no fallback

#### Scenario: Missing key

- **WHEN** `ZAI_API_KEY` is empty or missing
- **THEN** reading the configuration fails with an error naming `ZAI_API_KEY`

#### Scenario: Partial fallback

- **WHEN** `FALLBACK_API_KEY` is set but `FALLBACK_MODEL` is empty
- **THEN** reading the configuration fails with an error naming the missing fallback variable

### Requirement: Gateway provider from the environment

Only when `FACTORY_BRAIN_GATEWAY=1`, Anthropic messages through
`JIGJOY_ANTHROPIC_BASE_URL` and `JIGJOY_ANTHROPIC_API_KEY` SHALL be the first
provider (model `JIGJOY_ANTHROPIC_MODEL`, default `claude-sonnet-4-6`), Z.ai
the next and the fallback the last; a missing one of the two SHALL be an
error naming it. Otherwise the `JIGJOY_*` variables SHALL be ignored. The
`ANTHROPIC_*` names SHALL never be read.

#### Scenario: Gateway first

- **WHEN** `FACTORY_BRAIN_GATEWAY=1` and the `JIGJOY_ANTHROPIC_*` and `ZAI_*` variables are set
- **THEN** the providers are the gateway with `claude-sonnet-4-6`, then Z.ai

#### Scenario: Flag off

- **WHEN** the flag is not `1` and the `JIGJOY_ANTHROPIC_*` variables are set, even half
- **THEN** Z.ai is the first provider and no error is raised

#### Scenario: Flag on, key missing

- **WHEN** `FACTORY_BRAIN_GATEWAY=1` and `JIGJOY_ANTHROPIC_BASE_URL` is not set
- **THEN** reading the configuration fails with an error naming `JIGJOY_ANTHROPIC_BASE_URL`

### Requirement: Distinct models and contained keys

Every configured model SHALL be unique across the providers, and no
provider key SHALL reach `apb mcp`, generated code or git.

#### Scenario: Same model twice

- **WHEN** `JIGJOY_ANTHROPIC_MODEL` equals `ZAI_MODEL`
- **THEN** reading the configuration fails with an error naming `JIGJOY_ANTHROPIC_MODEL`

### Requirement: Function calling

A model call SHALL accept a system instruction, a user message and a set of
function tools, each with a name, a description and a schema for its
arguments. A function call returned by the model SHALL be turned into the
tool name and arguments validated against that tool's schema; malformed JSON,
an unknown tool or arguments that do not match SHALL yield a typed
invalid-arguments error, never unvalidated arguments.

#### Scenario: Model calls the offered tool

- **WHEN** the model is asked a question that only the offered tool can answer
- **THEN** the call yields a function call to that tool whose arguments pass the tool's schema

#### Scenario: Arguments do not match

- **WHEN** a function call carries arguments that are not valid JSON or do not match the tool's schema
- **THEN** it yields an invalid-arguments error naming the tool

### Requirement: Attempt deadline

Every model call SHALL belong to an attempt with one absolute deadline
(default 90 s) that bounds all of its calls, streamed calls included. A call
that exceeds it SHALL reject with a typed timeout error naming the provider,
the model and the deadline, and SHALL cancel its attempt.

#### Scenario: Provider is too slow

- **WHEN** the provider does not answer within the deadline
- **THEN** the call rejects with a timeout error naming the provider, the model and the deadline

#### Scenario: Stream outlives the deadline

- **WHEN** a streamed call keeps producing output past the attempt deadline
- **THEN** the call rejects with a timeout error at the deadline

### Requirement: Attempt cancellation

A call on a cancelled attempt SHALL reject with a typed cancelled error
without contacting the provider. Cancelling one attempt SHALL NOT affect any
other attempt. A call that belongs to no attempt SHALL be rejected.

#### Scenario: Attempt already cancelled

- **WHEN** a call is made for an attempt that was cancelled
- **THEN** the call rejects with a cancelled error and no request is sent

#### Scenario: Concurrent attempts

- **WHEN** one of two concurrent attempts is cancelled
- **THEN** the other attempt's calls still reach the provider

### Requirement: Request checks

A model the configuration does not know, or a request the model's declared
capabilities do not support (a reasoning effort outside its allowlist,
tools without function calling, streaming, structured output, or a context
item type it does not accept), SHALL be rejected with a typed request error
before any request is sent.

#### Scenario: Unknown model

- **WHEN** a call names a model that is not configured
- **THEN** it rejects with a request error and no request is sent

#### Scenario: Unsupported reasoning effort

- **WHEN** a call asks for a reasoning effort outside the model's allowlist
- **THEN** it rejects with a request error and no request is sent

### Requirement: Response validation

A successful provider response SHALL be validated before it is returned: a
response without a message, or with nothing the runtime can use, SHALL
reject with a typed malformed-response error marked retryable. Token counts
that are missing, negative or not integers SHALL make the usage unavailable
with the reason stated, without failing the call.

#### Scenario: Empty response

- **WHEN** the provider answers successfully with no choices
- **THEN** the call rejects with a malformed-response error

#### Scenario: Invalid token counts

- **WHEN** the provider answers with a valid message and a negative token count
- **THEN** the call succeeds and its usage is unavailable with the reason invalid usage

### Requirement: Classified provider failures

A failure reported by the provider (authentication, rate limit, server error,
malformed response) SHALL reject with a typed provider error carrying the
provider name, the model, the HTTP status when known, and whether the failure
is retryable (rate limit and server errors are; authentication and request
errors are not). The error text SHALL never contain the API key.

#### Scenario: Wrong key

- **WHEN** the provider rejects the credential
- **THEN** the call rejects with a provider error marked not retryable, with status 401 or 403, and the key does not appear in the error

### Requirement: Usage reporting

Each successful call SHALL report input and output tokens, and for Anthropic
the cache read and cache write tokens apart, as measured when
the provider returns them, and as unavailable otherwise; usage SHALL never be
estimated from text length without being marked estimated. The elapsed wall
time of the call SHALL always be reported.

#### Scenario: Provider returns usage

- **WHEN** the provider response includes token counts
- **THEN** the call reports them marked measured, together with the elapsed time

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
