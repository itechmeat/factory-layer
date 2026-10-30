/**
 * The factory's run memory over Open Second Brain, implementing the `Memory`
 * port. `remember` writes one note
 * per run with `brain_create_note` at a path keyed by the run id and
 * `if_exists: skip`, so a retry is a duplicate whatever its content, then
 * keeps its server until the note is searchable, best effort: in OSB 1.96.0
 * a created note claims an immediate index refresh, where a
 * `brain_write_batch` note waits for the periodic freshen (up to 60 s). Once
 * the note is created the run counts as remembered: a search error or an
 * abort while waiting ends the wait, not the call, and the wait ends
 * `indexWaitMs` after the call started, inside the caller's deadline.
 * `recall` searches the run notes by the spec's text and parses the outcome
 * block of each matching note, read whole; a note that cannot be read is
 * skipped, and so are the memory smoke's fake notes. It talks to `o2b mcp` through the
 * shared stdio MCP client, started only with the factory's own config and
 * vault (`FACTORY_OSB_CONFIG`, `FACTORY_OSB_VAULT`).
 *
 * Invariants: each call starts its own server process and closes it before it
 * settles (a connect still in flight at an abort is closed when it
 * completes); every wait is bounded by the connect and call timeouts, and an
 * aborted signal ends the wait with reason `cancelled`; a failure always
 * rejects with the port's `MemoryError`.
 */

import { z } from 'zod';

import { connectMcpStdio, type McpServerCommand, type McpStdioClient } from '../mcp-stdio/client';
import { McpTimeoutError, messageOf } from '../mcp-stdio/errors';
import type { Spec } from '../../domain/spec';
import { type Memory, MemoryError, type RecalledRun, type RunOutcomeRecord } from '../../ports/memory';
import { isLegacySmokeNote, parseRunNote, RUN_NOTES_PREFIX, RunOutcomeRecordSchema, runNoteBody, runNotePath } from './run-note';

/** Deadline for starting `o2b mcp` and its handshake, in milliseconds. */
export const OSB_CONNECT_TIMEOUT_MS = 15_000;

/** Timeout of one OSB tool call, in milliseconds. */
export const OSB_CALL_TIMEOUT_MS = 20_000;

/** Grace period between the start of a close and SIGKILL, in milliseconds. */
export const OSB_CLOSE_GRACE_MS = 3000;

/** The longest query `brain_search` accepts, in characters. */
export const OSB_QUERY_MAX_CHARS = 2000;

/** The most results one `brain_search` returns. */
const OSB_SEARCH_MAX_RESULTS = 50;

/** Search hits fetched per requested run: a note can surface as several chunks. */
const HITS_PER_RUN = 3;

/**
 * When `remember` stops waiting for OSB to index the new note, in
 * milliseconds after the call started: with the close it stays inside the
 * caller's MEMORY_DEADLINE_MS of 10 s.
 */
export const OSB_INDEX_WAIT_MS = 6000;

/** Pause between two index checks, in milliseconds. */
const INDEX_POLL_MS = 250;

/** How `remember` ended: a new note, or a note that already existed for this run. */
export type RememberResult = 'written' | 'duplicate';

/** The memory was asked to start without its dedicated vault. */
export class OsbMemoryConfigError extends Error {
  constructor(variable: string) {
    super(`run memory refuses to start: ${variable} is not set; add it to .env (see .env.example)`);
    this.name = 'OsbMemoryConfigError';
  }
}

/** Tunables and seams of one memory; every field has a default. */
export interface OsbMemoryOptions {
  /** Where the vault variables are read; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The server launcher; the memory appends `mcp --config <config> --vault <vault>`. Defaults to `o2b`. */
  readonly launcher?: { readonly command: string; readonly args?: readonly string[] };
  readonly connectTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly closeGraceMs?: number;
  readonly indexWaitMs?: number;
  /** The vault folder notes are written to and recalled from; the memory smoke uses `SMOKE_NOTES_PREFIX`. */
  readonly notesPrefix?: string;
  /** The wall clock stamped on a remembered run. */
  readonly now?: () => Date;
}

const CreateNoteSchema = z.looseObject({ outcome: z.enum(['created', 'skipped']) });
/** Search answers are read as cards: a hit's content is cut at 600 characters, a card points to the note. */
const SearchCardsSchema = z.looseObject({
  // OSB 1.96.0 leaves `cards` out of an empty answer.
  cards: z.array(z.looseObject({ path: z.string(), chunk_id: z.number().int().positive() })).default([]),
});
const ExpandSchema = z.looseObject({ note: z.looseObject({ path: z.string(), content: z.string() }) });

function toMemoryError(error: unknown): MemoryError {
  if (error instanceof MemoryError) return error;
  if (error instanceof McpTimeoutError) return new MemoryError({ reason: 'timeout', detail: error.message });
  return new MemoryError({ reason: 'failed', detail: messageOf(error) });
}

function cancelled(): MemoryError {
  return new MemoryError({ reason: 'cancelled', detail: 'run memory call was cancelled' });
}

/** Closes `client`; a process that would not end is a failed call. */
async function closeOrFail(client: McpStdioClient): Promise<void> {
  try {
    await client.close();
  } catch (error) {
    throw toMemoryError(error);
  }
}

/** The non-empty value of `name`, or a refusal naming it. */
function requireVariable(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = z.string().min(1).safeParse(env[name]);
  if (!value.success) throw new OsbMemoryConfigError(name);
  return value.data;
}

/** `work`, or a `cancelled` rejection as soon as `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** The run memory over the factory's own OSB vault. */
export class OsbMemory implements Memory {
  private readonly server: McpServerCommand;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly indexWaitMs: number;
  private readonly notesPrefix: string;
  private readonly now: () => Date;

  /** Refuses with `OsbMemoryConfigError` naming the first missing vault variable. */
  constructor(options: OsbMemoryOptions = {}) {
    const env = options.env ?? process.env;
    const config = requireVariable(env, 'FACTORY_OSB_CONFIG');
    const vault = requireVariable(env, 'FACTORY_OSB_VAULT');
    const launcher = options.launcher ?? { command: 'o2b' };
    this.server = {
      command: launcher.command,
      args: [...(launcher.args ?? []), 'mcp', '--config', config, '--vault', vault],
    };
    this.connectTimeoutMs = options.connectTimeoutMs ?? OSB_CONNECT_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? OSB_CALL_TIMEOUT_MS;
    this.closeGraceMs = options.closeGraceMs ?? OSB_CLOSE_GRACE_MS;
    this.indexWaitMs = options.indexWaitMs ?? OSB_INDEX_WAIT_MS;
    this.notesPrefix = options.notesPrefix ?? RUN_NOTES_PREFIX;
    this.now = options.now ?? ((): Date => new Date());
  }

  /** The port's remember: writes the run's note once; a repeat is not an error. */
  async remember(record: RunOutcomeRecord, signal: AbortSignal): Promise<void> {
    await this.writeOutcome(record, signal);
  }

  /** Writes the run's note once and says whether it was new or a `duplicate` of an earlier write. */
  async writeOutcome(record: RunOutcomeRecord, signal: AbortSignal): Promise<RememberResult> {
    const parsed = RunOutcomeRecordSchema.safeParse(record);
    if (!parsed.success) throw new MemoryError({ reason: 'failed', detail: `invalid run record: ${z.prettifyError(parsed.error)}` });
    const checked = parsed.data;
    const deadline = performance.now() + this.indexWaitMs;
    const note = {
      path: runNotePath(checked, this.notesPrefix),
      frontmatter: { run_id: checked.runId, spec_name: checked.specName, outcome: checked.outcome },
      content: runNoteBody(checked, this.now()),
    };
    // The call follows `signal` only until the note is created; after that an abort just ends the index wait.
    const writing = new AbortController();
    const forward = (): void => writing.abort();
    if (signal.aborted) writing.abort();
    signal.addEventListener('abort', forward, { once: true });
    try {
      return await this.withClient(writing.signal, async (client) => {
        const result = await this.write(client, note);
        signal.removeEventListener('abort', forward);
        await this.awaitIndexed(client, note.path, checked.runId, signal, deadline).catch(() => undefined);
        return result;
      });
    } finally {
      signal.removeEventListener('abort', forward);
    }
  }

  /** Creates the note unless one is already at its path; an existing note is a `duplicate`. */
  private async write(client: McpStdioClient, note: Record<string, unknown>): Promise<RememberResult> {
    const created = await client.callToolParsed('brain_create_note', { ...note, if_exists: 'skip' }, CreateNoteSchema);
    return created.outcome === 'created' ? 'written' : 'duplicate';
  }

  /**
   * Keeps the server alive until the note is searchable, so the refresh the
   * write claimed is not cut short by the close. Gives up quietly at
   * `deadline` or an abort; the note stays on disk and the periodic freshen
   * indexes it.
   */
  private async awaitIndexed(client: McpStdioClient, path: string, runId: string, signal: AbortSignal, deadline: number): Promise<void> {
    while (!signal.aborted && performance.now() < deadline) {
      const found = await client.callToolParsed(
        'brain_search',
        { query: runId, match_mode: 'any', path_prefix: path, keyword_only: true, disclosure: 'cards', limit: 1 },
        SearchCardsSchema,
        { timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) },
      );
      if (found.cards.length > 0) return;
      await Bun.sleep(INDEX_POLL_MS);
    }
  }

  /**
   * At most `limit` past runs whose notes match any term of the spec's text, one
   * per note, best match first: each new note among the search cards is read
   * whole with `brain_search_expand` and parsed; an unparsable note is skipped.
   */
  async recall(spec: Spec, limit: number, signal: AbortSignal): Promise<readonly RecalledRun[]> {
    const query = spec.markdown.slice(0, OSB_QUERY_MAX_CHARS);
    return this.withClient(signal, async (client) => {
      const found = await client.callToolParsed(
        'brain_search',
        {
          query,
          match_mode: 'any',
          path_prefix: this.notesPrefix,
          keyword_only: true,
          disclosure: 'cards',
          limit: Math.min(OSB_SEARCH_MAX_RESULTS, limit * HITS_PER_RUN),
        },
        SearchCardsSchema,
      );
      const seen = new Set<string>();
      const runs: RecalledRun[] = [];
      for (const card of found.cards) {
        if (runs.length >= limit || signal.aborted) break;
        if (seen.has(card.path) || isLegacySmokeNote(card.path)) continue;
        seen.add(card.path);
        const run = await this.readRun(client, card.chunk_id);
        if (run !== undefined) runs.push(run);
      }
      return runs;
    });
  }

  /**
   * The run of one note, or `undefined` when it cannot be read (gone after a
   * reindex, an unexpected shape) or parsed; a timeout still fails the recall.
   */
  private async readRun(client: McpStdioClient, chunkId: number): Promise<RecalledRun | undefined> {
    try {
      const expanded = await client.callToolParsed('brain_search_expand', { chunk_id: chunkId }, ExpandSchema);
      return parseRunNote(expanded.note.content);
    } catch (error) {
      if (error instanceof McpTimeoutError) throw error;
      return undefined;
    }
  }

  /** Runs `work` on a fresh connection that is closed before this settles. */
  private async withClient<T>(signal: AbortSignal, work: (client: McpStdioClient) => Promise<T>): Promise<T> {
    if (signal.aborted) throw cancelled();
    const connecting = connectMcpStdio(this.server, {
      connectTimeoutMs: this.connectTimeoutMs,
      callTimeoutMs: this.callTimeoutMs,
      closeGraceMs: this.closeGraceMs,
    });
    let client: McpStdioClient | undefined;
    const running = connecting.then((connected) => {
      client = connected;
      return work(connected);
    });
    // After an abort the work settles later, rejected by the close below.
    running.catch(() => undefined);
    try {
      return await untilAborted(running, signal);
    } catch (error) {
      throw toMemoryError(error);
    } finally {
      if (client === undefined) {
        // Aborted during the connect: the server is closed once the connect settles, within its deadline.
        connecting.then((connected) => connected.close()).catch(() => undefined);
      } else {
        await closeOrFail(client);
      }
    }
  }
}
