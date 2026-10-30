/**
 * Clock times given on a command line (`--cutoff 19:15`): an ISO 8601
 * instant with a zone, or `HH:MM` as local time today. Invariant: the
 * result is an epoch-ms instant strictly after `now`; anything else (an
 * unparsable value, a time already past) is a `RangeError` naming the
 * value, never a silent shift to another day.
 */

/** `HH:MM`, 24-hour clock, one or two hour digits. */
const LOCAL_TIME = /^(\d{1,2}):(\d{2})$/;

/** An ISO 8601 date and time with an explicit zone (`Z` or `+hh:mm`). */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The instant `value` names, or NaN when it is neither form. */
function instantOf(value: string, now: Date): number {
  const local = LOCAL_TIME.exec(value);
  if (local !== null) {
    const hours = Number(local[1]);
    const minutes = Number(local[2]);
    if (hours > 23 || minutes > 59) return Number.NaN;
    const at = new Date(now);
    at.setHours(hours, minutes, 0, 0);
    return at.getTime();
  }
  return ISO_WITH_ZONE.test(value) ? Date.parse(value) : Number.NaN;
}

/** Parses `value` (ISO 8601 with a zone, or `HH:MM` local today) into epoch ms after `now`; throws `RangeError` otherwise. */
export function parseClockTime(value: string, now: Date): number {
  const at = instantOf(value, now);
  if (Number.isNaN(at)) {
    throw new RangeError(`not a time: ${JSON.stringify(value)} (use HH:MM local time or an ISO 8601 instant with a zone)`);
  }
  if (at <= now.getTime()) {
    throw new RangeError(`the time ${JSON.stringify(value)} is not after now (${now.toISOString()})`);
  }
  return at;
}
