/**
 * A tiny stdio MCP server for the unit tests of the stdio MCP client. It
 * speaks newline-delimited JSON-RPC by hand so a test can make it misbehave
 * on purpose. Behaviour is chosen by flags:
 *
 * - `--mode ok` (default): answers the handshake and serves the tools below.
 * - `--mode silent`: never answers anything.
 * - `--mode invalid-handshake`: answers `initialize` with a malformed result.
 * - `--mode exit-early`: writes to stderr and exits before the handshake.
 * - `--stubborn`: ignores SIGTERM and the end of stdin (needs SIGKILL).
 * - `--paginate-forever`: every `tools/list` page carries a `nextCursor`.
 * - `--secret <value>`: writes the value to stderr at start and puts it into
 *   the `fail` tool's error text.
 * - `--osb-store <file>`: a JSON file holding the fake OSB vault across
 *   processes (the run memory starts one process per call).
 * - `--osb-refuse <code>`: `brain_create_note` answers a JSON-RPC error with
 *   that `data.code`.
 * - `--osb-hang`: `brain_search` never answers.
 * - `--osb-unindexed`: `brain_search` finds nothing.
 * - `--osb-search-error`: `brain_search` answers a JSON-RPC error.
 * - `--osb-expand-fail <text>`: `brain_search_expand` refuses every note whose
 *   path contains the text.
 *
 * Tools: `echo` (structured `{ text }`), `env` (structured `{ cwd, value }`:
 * the working directory and the variable named by the `name` argument),
 * `slow` (never answers), `fail` (an error result), `coded-fail` (a JSON-RPC
 * error whose `data.code` is the `code` argument and whose message carries the
 * secret), `crash` (the process exits
 * without answering), `bad-envelope` (a result whose text item is a number,
 * which breaks the MCP result schema).
 *
 * Fake OSB tools, as OSB 1.96.0 answers them: `brain_create_note` (with
 * `if_exists: skip`, a note already at the path is `skipped`) and
 * `brain_search` with cards (a query over 2000 characters is
 * `invalid_params`; every note under `path_prefix` comes back as two cards,
 * after a planted note whose JSON block is broken) and `brain_search_expand`
 * (the whole note of a card's chunk id).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { z } from 'zod';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const mode = flag('--mode') ?? 'ok';
const secret = flag('--secret');
const stubborn = process.argv.includes('--stubborn');
const paginateForever = process.argv.includes('--paginate-forever');
const osbStore = flag('--osb-store');
const osbRefuse = flag('--osb-refuse');
const osbHang = process.argv.includes('--osb-hang');
const osbUnindexed = process.argv.includes('--osb-unindexed');
const osbSearchError = process.argv.includes('--osb-search-error');
const osbExpandFail = flag('--osb-expand-fail');

const RequestSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string(),
  params: z.object({ name: z.string().optional(), arguments: z.record(z.string(), z.unknown()).optional() }).optional(),
});

type Request = z.infer<typeof RequestSchema>;

function exitWith(message: string, code: number): void {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: number | string, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function text(value: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: value }] };
}

const OsbVaultSchema = z.object({
  notes: z.record(z.string(), z.string()),
});
type OsbVault = z.infer<typeof OsbVaultSchema>;

const CreateNoteArgsSchema = z.object({ path: z.string(), content: z.string(), if_exists: z.literal('skip') });
const SearchArgsSchema = z.object({ query: z.string(), path_prefix: z.string(), limit: z.number() });

/** A planted run note whose JSON block does not parse. */
const BROKEN_NOTE = { path: 'factory/runs/broken.md', content: '# broken\n```json\n{"version": 1, \n```' };

function loadVault(): OsbVault {
  if (osbStore === undefined || !existsSync(osbStore)) return { notes: {} };
  return OsbVaultSchema.parse(JSON.parse(readFileSync(osbStore, 'utf8')));
}

function saveVault(vault: OsbVault): void {
  if (osbStore !== undefined) writeFileSync(osbStore, JSON.stringify(vault));
}

function refuse(id: number | string, message: string, code: string): void {
  send({ jsonrpc: '2.0', id, error: { code: -32_602, message, data: { code } } });
}

function createNote(id: number | string, args: Record<string, unknown>): void {
  if (osbRefuse !== undefined) {
    refuse(id, 'refused', osbRefuse);
    return;
  }
  const note = CreateNoteArgsSchema.parse(args);
  const vault = loadVault();
  if (vault.notes[note.path] !== undefined) {
    reply(id, { ...text('skipped'), structuredContent: { created: false, outcome: 'skipped', path: note.path } });
    return;
  }
  vault.notes[note.path] = note.content;
  saveVault(vault);
  reply(id, { ...text('created'), structuredContent: { created: true, outcome: 'created', path: note.path } });
}

/** The planted note and the stored notes under `prefix`; a note's chunk id is its position plus one. */
function notesUnder(prefix: string): { path: string; content: string }[] {
  const stored = Object.entries(loadVault().notes).map(([path, content]) => ({ path, content }));
  return [BROKEN_NOTE, ...stored].filter((note) => note.path.startsWith(prefix));
}

function search(id: number | string, args: Record<string, unknown>): void {
  if (osbHang) return;
  if (osbSearchError) {
    refuse(id, 'index is refreshing', 'unavailable');
    return;
  }
  const query = SearchArgsSchema.parse(args);
  if (query.query.length > 2000) {
    refuse(id, 'query: too long', 'invalid_params');
    return;
  }
  // Every note surfaces twice, as a frontmatter card and a body card.
  const all = notesUnder('').map((note) => note.path);
  const cards = notesUnder(query.path_prefix).flatMap((note) => {
    const card = { path: note.path, chunk_id: all.indexOf(note.path) + 1 };
    return [card, card];
  });
  const shown = osbUnindexed ? [] : cards.slice(0, query.limit);
  reply(id, { ...text('cards'), structuredContent: { results: [], cards: shown, total: shown.length } });
}

function expand(id: number | string, args: Record<string, unknown>): void {
  const chunk = z.object({ chunk_id: z.number() }).parse(args).chunk_id;
  const note = notesUnder('')[chunk - 1];
  if (note === undefined || (osbExpandFail !== undefined && note.path.includes(osbExpandFail))) {
    refuse(id, `no chunk ${chunk}`, 'not_found');
    return;
  }
  reply(id, { ...text('note'), structuredContent: { chunk_id: chunk, note, raw_content: [], next_cursor: null } });
}

function callTool(id: number | string, name: string, args: Record<string, unknown>): void {
  switch (name) {
    case 'echo': {
      reply(id, { ...text('echoed'), structuredContent: { text: args['text'] } });
      break;
    }
    case 'env': {
      const value = process.env[String(args['name'])] ?? null;
      reply(id, { ...text('env'), structuredContent: { cwd: process.cwd(), value } });
      break;
    }
    case 'slow': {
      break;
    }
    case 'crash': {
      exitWith('fake server crashed', 4);
      break;
    }
    case 'bad-envelope': {
      reply(id, { content: [{ type: 'text', text: 42 }] });
      break;
    }
    case 'fail': {
      reply(id, { ...text(`tool failed, token ${secret ?? 'none'}`), isError: true });
      break;
    }
    case 'coded-fail': {
      const data = { code: String(args['code']) };
      send({ jsonrpc: '2.0', id, error: { code: -32_602, message: `refused, token ${secret ?? 'none'}`, data } });
      break;
    }
    case 'brain_create_note': {
      createNote(id, args);
      break;
    }
    case 'brain_search': {
      search(id, args);
      break;
    }
    case 'brain_search_expand': {
      expand(id, args);
      break;
    }
    default: {
      send({ jsonrpc: '2.0', id, error: { code: -32_602, message: `unknown tool ${name}` } });
    }
  }
}

function handle(request: Request): void {
  if (request.id === undefined || mode === 'silent') return;
  switch (request.method) {
    case 'initialize': {
      if (mode === 'invalid-handshake') {
        reply(request.id, { bogus: true });
        return;
      }
      reply(request.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-server', version: '1.2.3' },
      });
      return;
    }
    case 'tools/list': {
      reply(request.id, {
        tools: [
          'echo',
          'env',
          'slow',
          'fail',
          'coded-fail',
          'crash',
          'bad-envelope',
          'brain_create_note',
          'brain_search',
          'brain_search_expand',
        ].map((tool) => ({
          name: tool,
          inputSchema: { type: 'object' },
        })),
        ...(paginateForever ? { nextCursor: `page-${String(request.id)}` } : {}),
      });
      return;
    }
    case 'tools/call': {
      callTool(request.id, request.params?.name ?? '', request.params?.arguments ?? {});
      return;
    }
    default: {
      reply(request.id, {});
    }
  }
}

if (secret !== undefined) process.stderr.write(`starting with token ${secret}\n`);
process.stderr.write(`fake server mode ${mode}\n`);

if (mode === 'exit-early') exitWith('fake server gives up', 3);

if (stubborn) {
  process.on('SIGTERM', () => {
    process.stderr.write('ignoring SIGTERM\n');
  });
  // Keeps the process alive after stdin ends.
  setInterval(() => {}, 60_000);
  // A fixture leaked by a failed or interrupted test still ends on its own.
  setTimeout(() => process.exit(5), 60_000).unref();
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  handle(RequestSchema.parse(JSON.parse(line)));
});
lines.on('close', () => {
  if (!stubborn) process.exit(0);
});
