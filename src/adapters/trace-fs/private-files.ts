/**
 * Owner-only files of a run directory: the directory is created mode 0700
 * and every file appended to mode 0600, whatever the umask, because the
 * run directory holds supervisor tokens and model output about the
 * operator's work.
 */

import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';

/** Creates `directory` (and its parents) and makes it owner-only (0700). */
export function ensurePrivateDir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The create mode honours the umask and leaves an existing directory alone; the chmod does neither.
  chmodSync(directory, 0o700);
}

/** Appends `text` to `file`, creating it owner-only (0600). */
export function appendPrivate(file: string, text: string): void {
  appendFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
}
