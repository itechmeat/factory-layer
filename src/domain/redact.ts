/**
 * The one secret redaction of the domain: every given secret is replaced with
 * `[redacted]` in a string or in every string of a JSON value. Invariant: no
 * given secret survives in the output, also when one secret contains another.
 */

/** What every secret is replaced with. */
export const REDACTED = '[redacted]';

/** Replaces every occurrence of every secret in `text` with REDACTED. */
export function redactString(text: string, secrets: readonly string[]): string {
  // Longest first, so a secret that contains another one is redacted whole.
  // The empty string matches everywhere and is never a secret.
  const ordered = [...secrets].filter((secret) => secret.length > 0).toSorted((a, b) => b.length - a.length);
  let out = text;
  for (const secret of ordered) out = out.replaceAll(secret, REDACTED);
  return out;
}

/** True for the plain objects a JSON value holds (no arrays, no instances). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => walk(entry, secrets));
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry, secrets)]));
  }
  return value;
}

/** Deep-walks a JSON value and redacts every string it finds. Preserves structure and non-string values exactly. */
export function redactJson<T>(value: T, secrets: readonly string[]): T;
export function redactJson(value: unknown, secrets: readonly string[]): unknown {
  return walk(value, secrets);
}
