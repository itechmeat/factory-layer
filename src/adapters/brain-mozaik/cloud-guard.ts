/**
 * Decides whether the brain may run where Mozaik 4.2.0 would export loop
 * events to its cloud (Mozaik Cloud, app.jigjoy.ai). Every loop builds a
 * cloud client that looks for a key in the environment, in the `.env` of
 * the process directory and in the user's Mozaik credentials file, and with
 * a key sends every loop event, prompts and spec text included, to a third
 * party. The guard looks in the same places. Export is opt-in: a key is
 * allowed only with `FACTORY_MOZAIK_CLOUD=1`; without it the guard refuses
 * with the place it found. With export on, the cloud client's
 * `MOZAIK_REDACTION` defaults to `content` (message text, answers and tool
 * arguments sent as sizes only); `none` or `all` set by the operator is kept.
 *
 * Invariant: no value is read into an error. From `.env` only variable
 * names are read; the credentials file is refused by its existence.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The variables the Mozaik cloud client reads a key from. */
export const MOZAIK_KEY_VARIABLES = ['MOZAIK_API_KEY', 'MOZAIK_PROJECT_KEY', 'MOZAIK_PROJECT_ID'] as const;

/** Where to look: the environment, the process directory and the home directory. */
export interface CloudGuardScope {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly home: string;
}

/** The variable that opts in to Mozaik Cloud export; only the value `1` opts in. */
export const MOZAIK_CLOUD_OPT_IN = 'FACTORY_MOZAIK_CLOUD';

/** Whether loop events go to Mozaik Cloud: no key, a key with the opt-in, or a key without it. */
export type MozaikCloudState =
  | { readonly state: 'off' }
  | { readonly state: 'on'; readonly found: string }
  | { readonly state: 'refused'; readonly found: string };

/** A Mozaik cloud key is configured without the opt-in; the message names the variable or file, never a value. */
export class MozaikCloudKeyError extends Error {
  constructor(found: string) {
    super(
      `A Mozaik cloud key is configured (${found}); the brain refuses to start because Mozaik would send prompts and spec text to its cloud. Remove it, or set ${MOZAIK_CLOUD_OPT_IN}=1 to opt in, and retry.`,
    );
    this.name = 'MozaikCloudKeyError';
  }
}

/** Variable names assigned in a `.env` text, as the Mozaik cloud client parses it. */
function assignedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return names;
}

/** Where a Mozaik cloud key is configured, or `undefined` when nowhere. */
function findMozaikCloudKey(scope: CloudGuardScope): string | undefined {
  for (const name of MOZAIK_KEY_VARIABLES) {
    if (scope.env[name]) return `${name} in the environment`;
  }
  const envFile = join(scope.cwd, '.env');
  if (existsSync(envFile)) {
    const names = assignedNames(readFileSync(envFile, 'utf8'));
    const found = MOZAIK_KEY_VARIABLES.find((name) => names.has(name));
    if (found !== undefined) return `${found} in ${envFile}`;
  }
  const credentials = scope.env['MOZAIK_CREDENTIALS_FILE'] ?? join(scope.home, '.mozaik', 'credentials.json');
  if (existsSync(credentials)) return `the credentials file ${credentials}`;
  return undefined;
}

/** Whether Mozaik Cloud export is off, on (a key with the opt-in) or refused (a key without it). */
export function mozaikCloudState(scope: CloudGuardScope): MozaikCloudState {
  const found = findMozaikCloudKey(scope);
  if (found === undefined) return { state: 'off' };
  return scope.env[MOZAIK_CLOUD_OPT_IN] === '1' ? { state: 'on', found } : { state: 'refused', found };
}

/** Throws `MozaikCloudKeyError` when a Mozaik cloud key is configured without the opt-in; returns the state otherwise. */
export function assertMozaikCloudAllowed(scope: CloudGuardScope): MozaikCloudState {
  const cloud = mozaikCloudState(scope);
  if (cloud.state === 'refused') throw new MozaikCloudKeyError(cloud.found);
  return cloud;
}

/** The redaction modes the Mozaik cloud client understands. */
const REDACTION_MODES: ReadonlySet<string> = new Set(['none', 'content', 'all']);

/**
 * The cloud client's redaction mode in `env` (which it reads at every loop):
 * an explicit valid mode is kept, anything else is set to `content`.
 */
export function cloudRedaction(env: Record<string, string | undefined>): string {
  const mode = env['MOZAIK_REDACTION'];
  if (mode !== undefined && REDACTION_MODES.has(mode)) return mode;
  env['MOZAIK_REDACTION'] = 'content';
  return 'content';
}
