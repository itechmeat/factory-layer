# mcp-stdio-client Specification

## Purpose
The factory reaches APB and OSB as local MCP servers over stdio. This
capability defines how such a server is started, called and stopped so that
no call waits forever and no child process outlives its client.

## Requirements

### Requirement: Bounded connection

The client SHALL start the server command with the given arguments, working
directory and environment, and SHALL complete the MCP handshake within a
connect deadline (default 15 s). When the deadline passes or the process
exits first, the connect attempt SHALL fail with a typed connection error
that names the command and carries the tail of the server's stderr, and the
child process SHALL be terminated.

#### Scenario: Server answers the handshake

- **WHEN** a client connects to a server that completes the handshake in time
- **THEN** the connect call resolves and the server's name and version are available

#### Scenario: Server never answers

- **WHEN** the server process starts but does not complete the handshake within the connect deadline
- **THEN** the connect call rejects with a connection error naming the command and the deadline, and no child process remains

#### Scenario: Failed handshake with an uncooperative server

- **WHEN** a server writes an invalid handshake answer and ignores SIGTERM, with a 500 ms grace period
- **THEN** the connect call rejects with a connection error and the server process is gone within about 1.5 s

#### Scenario: Command does not exist

- **WHEN** the server command cannot be spawned
- **THEN** the connect call rejects with a connection error naming the command

### Requirement: Bounded tool calls

Every tool call SHALL carry a request timeout (default 60 s, overridable per
call). A call that exceeds it SHALL reject with a typed timeout error naming
the tool and the timeout. A tool result flagged as an error by the server
SHALL reject with a typed tool error carrying the server's message.

#### Scenario: Tool answers in time

- **WHEN** a tool returns a successful result within its timeout
- **THEN** the call resolves with that result

#### Scenario: Tool is too slow

- **WHEN** a tool does not answer within its timeout
- **THEN** the call rejects with a timeout error naming the tool and the timeout

#### Scenario: Tool reports an error

- **WHEN** the server returns a result flagged as an error
- **THEN** the call rejects with a tool error carrying the server's message

### Requirement: Validated results

A caller SHALL be able to pass a Zod schema for the structured content of a
tool result (or for its JSON text content when no structured content is
present). A result that does not match SHALL reject with a typed validation
error naming the tool; it SHALL never be returned unvalidated.

#### Scenario: Result has the expected shape

- **WHEN** a tool result matches the caller's schema
- **THEN** the call resolves with the parsed, typed value

#### Scenario: Result has an unexpected shape

- **WHEN** a tool result does not match the caller's schema
- **THEN** the call rejects with a validation error naming the tool

### Requirement: Guaranteed teardown

Closing the client SHALL end the session and terminate the child process,
sending a forced kill when the process has not exited within a grace period
(default 5 s) counted from the start of the close, and SHALL finish within
the grace period plus an exit-confirmation budget (1 s); a process still
present then SHALL be reported as a typed teardown error. Closing SHALL be
idempotent. Calls made after close SHALL reject with a typed closed error.

#### Scenario: Close stops the server

- **WHEN** a connected client is closed
- **THEN** the server process has exited when the close call resolves

#### Scenario: Uncooperative server

- **WHEN** a server ignores stdin closing and SIGTERM and the grace period is 500 ms
- **THEN** the server is killed and the close call resolves within about 1.5 s

#### Scenario: Call after close

- **WHEN** a tool is called on a closed client
- **THEN** the call rejects with a closed error

### Requirement: Safe diagnostics

The client SHALL accept a set of secret values and SHALL replace each of them
with `[redacted]` in every error message, retained stderr text and exposed
error cause it reports.

#### Scenario: Server leaks a secret

- **WHEN** a server writes a configured secret to stderr and returns it in a tool error
- **THEN** neither the reported connection or tool error nor the retained stderr contains the secret

### Requirement: Tool error codes

A tool error SHALL carry the server's error code when the server sends one
(the JSON-RPC error's `data.code`), redacted like the message, so callers
can branch on refusals such as `exists` or `invalid_params`.

#### Scenario: Coded refusal

- **WHEN** a server answers a tool call with a JSON-RPC error whose data holds the code `exists`
- **THEN** the call rejects with a tool error whose code is `exists`
