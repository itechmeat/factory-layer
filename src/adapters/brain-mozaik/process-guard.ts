/**
 * The process-level safety net for Mozaik loops. Mozaik 4.2.0 starts each
 * loop without awaiting or catching it, so anything a loop throws becomes an
 * unhandled rejection, which Bun prints and later turns into exit code 1.
 * The guarded runner already settles every failure it sees on its attempt;
 * this guard catches whatever still escapes, ignores what was attributed and
 * logs the rest, so the process keeps running.
 *
 * Invariant: at most one guard per target, however often it is installed.
 */

/** The part of `process` the guard needs; an `EventEmitter` in tests. */
export interface RejectionSource {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

/** What the guard does with a rejection. */
export interface RejectionGuardOptions {
  /** True for a reason that was already recorded on its attempt. */
  readonly isAttributed: (reason: unknown) => boolean;
  readonly log: (reason: unknown) => void;
}

const guarded = new WeakSet<RejectionSource>();

/** Installs the guard on `target` (normally `process`) unless one is installed already. */
export function guardUnattributedRejections(target: RejectionSource, options: RejectionGuardOptions): void {
  if (guarded.has(target)) return;
  guarded.add(target);
  target.on('unhandledRejection', (reason) => {
    if (!options.isAttributed(reason)) options.log(reason);
  });
}
