/**
 * The file run store: the run state persisted atomically to
 * `runs/<run-id>/state.json` (temp file in the same directory, chmod 0600,
 * rename) in an owner-only run directory (0700), and human interventions
 * appended to the run's trace file (0600). The state holds supervisor
 * tokens, so its content is written unredacted and protected by the modes;
 * it never holds a provider key (the run options carry none). It is
 * validated against the schema on every read. An intervention note is redacted of the secrets set
 * with `setSecrets` and stamped with the injected clock.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { redactString } from '../../domain/redact';
import { RunStateSchema } from '../../domain/run-state';
import type { RunState } from '../../domain/run-state';
import type { Clock } from '../../ports';
import { StorageError } from '../../ports/run-store';
import type { RunStore } from '../../ports/run-store';
import { appendPrivate, ensurePrivateDir } from './private-files';
import { TRACE_FILE_NAME, assertSafeRunId, hasErrorCode, runDir } from './read';

/** The name of the persisted state file inside a run directory. */
const STATE_FILE_NAME = 'state.json';

/** Persists run state and interventions under a runs root directory. */
export class FileRunStore implements RunStore {
  private readonly runsDir: string;
  private readonly clock: Clock;
  private secrets: readonly string[] = [];

  constructor(runsDir: string, clock: Clock) {
    this.runsDir = runsDir;
    this.clock = clock;
  }

  /** Replaces the secrets redacted from every intervention note appended after the call. */
  setSecrets(secrets: readonly string[]): void {
    this.secrets = [...secrets];
  }

  async save(state: RunState): Promise<void> {
    const directory = runDir(this.runsDir, state.runId);
    const target = join(directory, STATE_FILE_NAME);
    const temp = join(directory, `${STATE_FILE_NAME}.${randomUUID()}.tmp`);
    try {
      ensurePrivateDir(directory);
      writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      // The write mode honours the umask; the chmod does not.
      chmodSync(temp, 0o600);
      renameSync(temp, target);
    } catch (cause) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // The directory is unwritable, so no temp file could exist there.
      }
      throw new StorageError({ detail: `cannot save the run state to ${target}`, cause });
    }
  }

  async load(runId: string): Promise<RunState | null> {
    assertSafeRunId(runId);
    const target = join(runDir(this.runsDir, runId), STATE_FILE_NAME);
    let text: string;
    try {
      text = readFileSync(target, 'utf8');
    } catch (cause) {
      if (hasErrorCode(cause, 'ENOENT')) return null;
      throw new StorageError({ detail: `cannot read the run state at ${target}`, cause });
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw new StorageError({ detail: `the run state at ${target} is not valid JSON`, cause });
    }
    const parsed = RunStateSchema.safeParse(value);
    if (!parsed.success) {
      throw new StorageError({ detail: `the run state at ${target} does not validate`, cause: parsed.error });
    }
    return parsed.data;
  }

  async appendIntervention(runId: string, note: string): Promise<{ readonly at: string; readonly note: string }> {
    assertSafeRunId(runId);
    const at = this.clock.now().toISOString();
    const redacted = redactString(note, this.secrets);
    const event = { at, runId, type: 'intervention_recorded' as const, note: redacted };
    const directory = runDir(this.runsDir, runId);
    const file = join(directory, TRACE_FILE_NAME);
    try {
      ensurePrivateDir(directory);
      appendPrivate(file, `${JSON.stringify(event)}\n`);
    } catch (cause) {
      throw new StorageError({ detail: `cannot append the intervention to ${file}`, cause });
    }
    return { at, note: redacted };
  }
}
