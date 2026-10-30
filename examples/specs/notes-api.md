# notes-api: in-memory notes over HTTP

## Purpose

`notes-api` is a small HTTP service that keeps short text notes in memory.
Clients create, list, read and delete notes with JSON requests. Nothing is
stored on disk: a restart starts with no notes.

## Package

1. A TypeScript npm package named `notes-api` whose `start` script runs the
   server under Node 20 or newer (compiled JavaScript; it must not require
   Bun to run). When the package has a `build` script, `npm start` runs the
   built output.
2. `npm start` listens on the port given in the `PORT` environment
   variable (default `3000`) on all interfaces, and keeps running until it
   is stopped.
3. `npm test` and `bun test` both run the package's tests and pass.
4. The package also exports a function `createServer()` from its main
   entry that returns a Node `http.Server` with its own empty note store,
   not yet listening, so tests can start it on any port.

## Notes

1. A note is a JSON object `{"id": <integer>, "text": <string>}`.
2. Ids are assigned by the server: the first note gets `1`, every new note
   gets the next integer. An id is never reused, even after a delete.
3. `text` is a string of 1 to 500 characters after trimming leading and
   trailing white space; the trimmed text is stored.

## Routes

1. `POST /notes` with a JSON body `{"text": <string>}` creates a note and
   answers `201` with the created note.
2. `GET /notes` answers `200` with a JSON array of every note, ordered by
   id, ascending (`[]` when there are none).
3. `GET /notes/<id>` answers `200` with the note.
4. `DELETE /notes/<id>` deletes the note and answers `204` with an empty
   body.

## Responses

1. Every non-empty response body is JSON with the header
   `Content-Type: application/json`.
2. An error answers with a body `{"error": <message>}` and the status
   below; the messages are exactly these:
   1. A `POST /notes` body that is not valid JSON: `400`, `invalid JSON`.
   2. A `POST /notes` body that is not an object with a `text` string of
      1 to 500 characters after trimming: `400`, `text must be a string of 1 to 500 characters`.
   3. `GET` or `DELETE` of `/notes/<id>` where `<id>` is not a positive
      integer or names no note: `404`, `note not found`.
   4. Any other path: `404`, `not found`.
   5. A known path with another method: `405`, `method not allowed`.
3. Extra fields in a `POST /notes` body are ignored.

## Examples

Each example is a request line (method and path), an optional request
body on the next line, then `=>` and the expected status, and an optional
expected response body on the next line. The examples run in this order
against one freshly started server.

```
GET /notes
=> 200
[]

POST /notes
{"text":"buy milk"}
=> 201
{"id":1,"text":"buy milk"}

POST /notes
{"text":"  call mom  "}
=> 201
{"id":2,"text":"call mom"}

GET /notes
=> 200
[{"id":1,"text":"buy milk"},{"id":2,"text":"call mom"}]

GET /notes/2
=> 200
{"id":2,"text":"call mom"}

POST /notes
{"text":"   "}
=> 400
{"error":"text must be a string of 1 to 500 characters"}

POST /notes
not json
=> 400
{"error":"invalid JSON"}

DELETE /notes/1
=> 204

GET /notes/1
=> 404
{"error":"note not found"}

DELETE /notes/abc
=> 404
{"error":"note not found"}

POST /notes
{"text":"water plants"}
=> 201
{"id":3,"text":"water plants"}

PUT /notes
=> 405
{"error":"method not allowed"}

GET /unknown
=> 404
{"error":"not found"}
```
