/**
 * The one shape of captured output that leaves the check runner: secrets
 * redacted first, then capped to CHECK_OUTPUT_LIMIT_BYTES as its head and
 * its tail (where errors and summaries land) with the cut stated in
 * between. `CappedCollector` keeps a stream in bounded memory while it is
 * read: its first and its last CHECK_OUTPUT_LIMIT_BYTES. Invariant: no
 * secret survives the result, not even in a cut-off piece, because
 * redaction always runs before truncation, and a secret split by the
 * collector's drop lies outside the halves the cap keeps.
 */

import { CHECK_OUTPUT_LIMIT_BYTES } from '../../domain/limits';
import { redactString } from '../../domain/redact';

/** How a cut is marked between the head and the tail of capped output. */
export const TRUNCATION_MARK = '\n[truncated]\n';

/** Redacts every secret in `text`, then caps it to the byte limit as head and tail, stating the cut. */
export function redactAndCap(text: string, secrets: readonly string[]): string {
  const redacted = redactString(text, secrets);
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.length <= CHECK_OUTPUT_LIMIT_BYTES) return redacted;
  const half = Math.floor(CHECK_OUTPUT_LIMIT_BYTES / 2);
  const head = bytes.subarray(0, half).toString('utf8');
  const tail = bytes.subarray(bytes.length - half).toString('utf8');
  return `${head}${TRUNCATION_MARK}${tail}`;
}

/** A stream read in bounded memory: its first and last CHECK_OUTPUT_LIMIT_BYTES, and whether bytes between were dropped. */
export class CappedCollector {
  readonly #head: Buffer[] = [];
  #headBytes = 0;
  readonly #tail: Buffer[] = [];
  #tailBytes = 0;
  #dropped = false;

  push(chunk: Buffer): void {
    const room = CHECK_OUTPUT_LIMIT_BYTES - this.#headBytes;
    const toHead = chunk.subarray(0, Math.max(0, room));
    if (toHead.length > 0) {
      this.#head.push(toHead);
      this.#headBytes += toHead.length;
    }
    const rest = chunk.subarray(toHead.length);
    if (rest.length === 0) return;
    this.#tail.push(rest);
    this.#tailBytes += rest.length;
    for (
      let first = this.#tail[0];
      first !== undefined && this.#tailBytes - first.length >= CHECK_OUTPUT_LIMIT_BYTES;
      first = this.#tail[0]
    ) {
      this.#tail.shift();
      this.#tailBytes -= first.length;
      this.#dropped = true;
    }
  }

  /** The collected text, redacted of `secrets` and capped. */
  text(secrets: readonly string[]): string {
    const head = Buffer.concat(this.#head).toString('utf8');
    const tail = Buffer.concat(this.#tail).toString('utf8');
    return redactAndCap(this.#dropped ? `${head}${TRUNCATION_MARK}${tail}` : head + tail, secrets);
  }
}
