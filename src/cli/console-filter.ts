/**
 * Silences the one warning Mozaik 4.2.0 prints per loop when no cloud key is
 * configured (its cloud client's "no API key, telemetry disabled" line),
 * matched by its exact prefix; every other warning passes through. The
 * factory runs without a cloud key unless `FACTORY_MOZAIK_CLOUD=1` opts in,
 * so the line is noise in the run output. With the opt-in, the live link
 * line Mozaik prints (on `console.log`) is never touched.
 */

/** The start of the Mozaik cloud client's per-loop warning. */
export const MOZAIK_NO_KEY_WARNING = 'mozaik cloud: no API key';

/** The part of `console` the filter replaces. */
export interface WarnSink {
  warn: (...args: unknown[]) => void;
}

/** Wraps `target.warn` so the Mozaik no-key warning is dropped. */
export function filterMozaikWarning(target: WarnSink): void {
  const original = target.warn.bind(target);
  target.warn = (...args: unknown[]): void => {
    const [first] = args;
    if (typeof first === 'string' && first.startsWith(MOZAIK_NO_KEY_WARNING)) return;
    original(...args);
  };
}
