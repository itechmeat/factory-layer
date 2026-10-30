# Spec Delta

## ADDED Requirements

### Requirement: Tool error codes

A tool error SHALL carry the server's error code when the server sends one
(the JSON-RPC error's `data.code`), redacted like the message, so callers
can branch on refusals such as `exists` or `invalid_params`.

#### Scenario: Coded refusal

- **WHEN** a server answers a tool call with a JSON-RPC error whose data holds the code `exists`
- **THEN** the call rejects with a tool error whose code is `exists`
