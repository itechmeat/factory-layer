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
 *
 * Tools: `echo` (structured `{ text }`), `env` (structured `{ cwd, value }`:
 * the working directory and the variable named by the `name` argument),
 * `slow` (never answers), `fail` (an error result), `crash` (the process exits
 * without answering), `bad-envelope` (a result whose text item is a number,
 * which breaks the MCP result schema).
 */

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
        tools: ['echo', 'env', 'slow', 'fail', 'crash', 'bad-envelope'].map((tool) => ({
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
