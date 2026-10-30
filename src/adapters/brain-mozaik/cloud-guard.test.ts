import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertMozaikCloudAllowed, cloudRedaction, MozaikCloudKeyError, mozaikCloudState } from './cloud-guard';

const SECRET = 'mzk-secret-value-never-printed';
const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-guard-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function refusal(where: { env?: Record<string, string | undefined>; cwd?: string; home?: string }): MozaikCloudKeyError {
  try {
    assertMozaikCloudAllowed({ env: where.env ?? {}, cwd: where.cwd ?? freshDir(), home: where.home ?? freshDir() });
  } catch (error) {
    if (error instanceof MozaikCloudKeyError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('assertMozaikCloudAllowed', () => {
  for (const name of ['MOZAIK_API_KEY', 'MOZAIK_PROJECT_KEY', 'MOZAIK_PROJECT_ID']) {
    test(`${name} in the environment is refused, named, and its value never shown`, () => {
      const error = refusal({ env: { [name]: SECRET } });
      expect(error.message).toContain(name);
      expect(error.message).toContain('environment');
      expect(Bun.inspect(error)).not.toContain(SECRET);
    });
  }

  test('a key name in the .env of the process directory is refused without reading its value into the error', () => {
    const cwd = freshDir();
    writeFileSync(join(cwd, '.env'), `OTHER=1\nexport MOZAIK_PROJECT_KEY="${SECRET}"\n`);
    const error = refusal({ cwd });
    expect(error.message).toContain('MOZAIK_PROJECT_KEY');
    expect(error.message).toContain(join(cwd, '.env'));
    expect(Bun.inspect(error)).not.toContain(SECRET);
  });

  test('the Mozaik credentials file in the home directory is refused', () => {
    const home = freshDir();
    mkdirSync(join(home, '.mozaik'));
    writeFileSync(join(home, '.mozaik', 'credentials.json'), JSON.stringify({ x: { projectKey: SECRET } }));
    const error = refusal({ home });
    expect(error.message).toContain(join(home, '.mozaik', 'credentials.json'));
    expect(Bun.inspect(error)).not.toContain(SECRET);
  });

  test('a credentials file named by MOZAIK_CREDENTIALS_FILE is refused', () => {
    const file = join(freshDir(), 'creds.json');
    writeFileSync(file, '{}');
    expect(refusal({ env: { MOZAIK_CREDENTIALS_FILE: file } }).message).toContain(file);
  });

  test('blank values, other names and missing files pass', () => {
    const cwd = freshDir();
    writeFileSync(join(cwd, '.env'), 'ZAI_API_KEY=x\n# MOZAIK_API_KEY=commented\n');
    expect(() => assertMozaikCloudAllowed({ env: { MOZAIK_API_KEY: '' }, cwd, home: freshDir() })).not.toThrow();
  });
});

describe('mozaikCloudState', () => {
  test('no key: off, whatever the opt-in says', () => {
    for (const env of [{}, { FACTORY_MOZAIK_CLOUD: '1' }]) {
      expect(mozaikCloudState({ env, cwd: freshDir(), home: freshDir() })).toEqual({ state: 'off' });
    }
  });

  test('a key with FACTORY_MOZAIK_CLOUD=1: on, the guard allows it, and the value is never shown', () => {
    const scope = { env: { MOZAIK_API_KEY: SECRET, FACTORY_MOZAIK_CLOUD: '1' }, cwd: freshDir(), home: freshDir() };
    const state = mozaikCloudState(scope);
    expect(state).toEqual({ state: 'on', found: 'MOZAIK_API_KEY in the environment' });
    expect(JSON.stringify(state)).not.toContain(SECRET);
    expect(() => assertMozaikCloudAllowed(scope)).not.toThrow();
  });

  for (const optIn of [undefined, '0', 'true']) {
    test(`a key without the opt-in (${String(optIn)}): refused, and the guard throws`, () => {
      const env = { MOZAIK_API_KEY: SECRET, ...(optIn === undefined ? {} : { FACTORY_MOZAIK_CLOUD: optIn }) };
      const scope = { env, cwd: freshDir(), home: freshDir() };
      expect(mozaikCloudState(scope)).toEqual({ state: 'refused', found: 'MOZAIK_API_KEY in the environment' });
      expect(() => assertMozaikCloudAllowed(scope)).toThrow(MozaikCloudKeyError);
    });
  }
});

describe('cloudRedaction', () => {
  test('content redaction is the default, and an explicit valid mode is kept', () => {
    const unset: Record<string, string | undefined> = {};
    expect(cloudRedaction(unset)).toBe('content');
    expect(unset['MOZAIK_REDACTION']).toBe('content');
    const invalid: Record<string, string | undefined> = { MOZAIK_REDACTION: 'bogus' };
    expect(cloudRedaction(invalid)).toBe('content');
    expect(invalid['MOZAIK_REDACTION']).toBe('content');
    expect(cloudRedaction({ MOZAIK_REDACTION: 'none' })).toBe('none');
    expect(cloudRedaction({ MOZAIK_REDACTION: 'all' })).toBe('all');
  });
});
