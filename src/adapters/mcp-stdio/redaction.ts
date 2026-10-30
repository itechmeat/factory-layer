/**
 * Secret redaction for everything the stdio MCP client reports: error
 * messages, exposed causes and the retained stderr tail. Invariant: a
 * configured secret never leaves this module in clear text, also when the
 * stderr tail cuts through it or a chunk boundary splits it.
 */

/** What every secret is replaced with. */
export const REDACTED = '[redacted]';

/** How much of the server's stderr is kept, in characters (about 4 KiB). */
export const STDERR_TAIL_CHARS = 4096;

/** Replaces every occurrence of every non-empty secret with `[redacted]`. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  // Longest first, so a secret that contains another one is redacted whole.
  const ordered = secrets.filter((secret) => secret.length > 0).toSorted((a, b) => b.length - a.length);
  let out = text;
  for (const secret of ordered) out = out.replaceAll(secret, REDACTED);
  return out;
}

/** The last `limit` characters of a process's stderr, redacted on read. */
export class StderrTail {
  private raw = '';
  private truncated = false;
  private readonly secrets: string[] = [];
  private readonly limit: number;
  // Raw text is kept with room for one whole secret before the visible
  // window, so a secret crossing the window's edge is still seen whole.
  private margin = 0;

  constructor(secrets: readonly string[], limit: number = STDERR_TAIL_CHARS) {
    this.limit = limit;
    for (const secret of secrets) this.addSecret(secret);
  }

  /** Redacts `secret` from now on; add it before the server can print it. */
  addSecret(secret: string): void {
    this.secrets.push(secret);
    this.margin = Math.max(this.margin, secret.length);
  }

  append(chunk: string): void {
    this.raw += chunk;
    const keep = this.limit + this.margin;
    if (this.raw.length > keep) {
      this.raw = this.raw.slice(-keep);
      this.truncated = true;
    }
  }

  /** The redacted tail, at most `limit` characters. */
  text(): string {
    let shown = redactSecrets(this.raw, this.secrets);
    // After a cut, the first `margin` characters may hold the end of a secret
    // whose start was dropped; they are never shown.
    if (this.truncated) shown = shown.slice(this.margin);
    return shown.slice(-this.limit);
  }
}
