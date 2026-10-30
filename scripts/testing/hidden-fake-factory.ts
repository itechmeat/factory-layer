/**
 * The fake factory of the hidden-run tests: it takes the same argv as
 * `factory run` and delivers a tiny dependency-free package whose shape is
 * chosen by the first line of the spec file (`mode: <name>`). It exists so
 * the hidden-run wrapper and its steps can be exercised offline, without
 * keys and without a real factory run. `hang` prints one line and then
 * stays alive until it is killed, which is how the hard-deadline path is
 * rehearsed; `hang-ignoring-term` also ignores SIGTERM, so only the kill
 * after the grace ends it. Invariant: nothing here touches the network; every delivery
 * installs with `npm install --ignore-scripts` from the local cache alone.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/** The absolute path of this fake factory, for the `factoryCommand` of the tests. */
export const FAKE_FACTORY_PATH = join(import.meta.dir, 'hidden-fake-factory.ts');

/** Writes a one-line spec file that selects `mode`, and returns its path. */
export function writeFakeSpec(dir: string, mode: string): string {
  const path = join(dir, `${mode}.md`);
  writeFileSync(path, `mode: ${mode}\nThe rest of this fake spec carries no information.\n`);
  return path;
}

/** Runs this fake factory over `mode` into `outDir`, the way the real wrapper would. */
export function runFakeFactory(outDir: string, mode: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'hidden-fake-spec-'));
  try {
    const specPath = writeFakeSpec(scratch, mode);
    const spawned = Bun.spawnSync({
      cmd: [
        'bun',
        FAKE_FACTORY_PATH,
        'run',
        specPath,
        '--out',
        outDir,
        '--cutoff',
        '19:15',
        '--task-concurrency',
        '2',
        '--deliver-unverified',
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (spawned.exitCode !== 0) {
      throw new Error(`the fake factory failed for mode ${mode}: ${spawned.stderr.toString().trim()}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The `.gitignore` every delivery starts with, as the factory would write it. */
const DELIVERY_GITIGNORE = 'dist/\n';

/** The files of `mode: deliver-js`: a plain Node CLI as the package bin. */
function writeDeliverJs(outDir: string, name: string): void {
  writeFileSync(join(outDir, '.gitignore'), DELIVERY_GITIGNORE);
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', private: true, bin: 'cli.js' }, null, 2)}\n`);
  writeFileSync(join(outDir, 'cli.js'), "process.stdout.write('fake-cli: ready\\n');\n");
}

/** The files of `mode: deliver-build`: a build script that produces the bin. */
function writeDeliverBuild(outDir: string, name: string): void {
  writeFileSync(join(outDir, '.gitignore'), DELIVERY_GITIGNORE);
  writeFileSync(
    join(outDir, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', private: true, bin: 'dist/cli.js', scripts: { build: 'node build.js' } }, null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, 'build.js'),
    [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "mkdirSync('dist', { recursive: true });",
      "writeFileSync('dist/commands.js', \"module.exports.greeting = () => 'greeting from commands';\\n\");",
      "writeFileSync('dist/cli.js', \"const { greeting } = require('./commands.js');\\nprocess.stdout.write(greeting() + '\\\\n');\\n\");",
    ].join('\n') + '\n',
  );
}

/** The files of the HTTP deliveries: a server on the PORT the caller passes. */
function writeDeliverHttp(outDir: string, name: string, startCommand: string): void {
  writeFileSync(join(outDir, '.gitignore'), DELIVERY_GITIGNORE);
  writeFileSync(
    join(outDir, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', private: true, scripts: { start: startCommand } }, null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, 'server.js'),
    [
      "const http = require('node:http');",
      'const port = Number(process.env.PORT);',
      'if (!(port > 0)) process.exit(2);',
      'http.createServer((request, response) => { response.end("fake-http\\n"); })',
      '  .listen(port, () => { process.stdout.write("fake-http listening on " + String(port) + "\\n"); });',
    ].join('\n') + '\n',
  );
}

/** The server source: listens on the PORT the caller passes and ignores every argument. */
const SERVER_SOURCE =
  [
    "const http = require('node:http');",
    'const port = Number(process.env.PORT);',
    'if (!(port > 0)) process.exit(2);',
    'http.createServer((request, response) => { response.end("fake-http\\n"); })',
    '  .listen(port, () => { process.stdout.write("fake-http listening on " + String(port) + "\\n"); });',
  ].join('\n') + '\n';

/** The files of `mode: server-bin`: an HTTP package whose only bin is the file its start script launches (it ignores --help). */
function writeServerBin(outDir: string, name: string): void {
  writeFileSync(join(outDir, '.gitignore'), DELIVERY_GITIGNORE);
  writeFileSync(
    join(outDir, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', private: true, bin: { 'notes-api': 'dist/src/main.js' }, scripts: { start: 'node ./dist/src/main.js' } }, null, 2)}\n`,
  );
  mkdirSync(join(outDir, 'dist', 'src'), { recursive: true });
  writeFileSync(join(outDir, 'dist', 'src', 'main.js'), SERVER_SOURCE);
}

/** The files of `mode: server-main-bin`: as server-bin, but the start script is `node .` and `main` names the bin file. */
function writeServerMainBin(outDir: string, name: string): void {
  writeFileSync(join(outDir, '.gitignore'), DELIVERY_GITIGNORE);
  writeFileSync(
    join(outDir, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', private: true, main: 'dist/src/main.js', bin: { 'notes-api': 'dist/src/main.js' }, scripts: { start: 'node .' } }, null, 2)}\n`,
  );
  mkdirSync(join(outDir, 'dist', 'src'), { recursive: true });
  writeFileSync(join(outDir, 'dist', 'src', 'main.js'), SERVER_SOURCE);
}

/** The files of `mode: missing-import`: a bin whose import is not delivered. */
function writeMissingImport(outDir: string, name: string): void {
  writeFileSync(join(outDir, '.gitignore'), DELIVERY_GITIGNORE);
  writeFileSync(
    join(outDir, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', private: true, type: 'module', bin: 'cli.js' }, null, 2)}\n`,
  );
  writeFileSync(join(outDir, 'cli.js'), "import { gone } from './lib.js';\nprocess.stdout.write(gone);\n");
}

/** The files of `mode: throwing-bin` and `mode: usage-exit`: a CLI whose `--help` throws, or prints its usage and exits 1. */
function writeBinWithBody(outDir: string, name: string, body: string): void {
  writeFileSync(join(outDir, '.gitignore'), DELIVERY_GITIGNORE);
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', private: true, bin: 'cli.js' }, null, 2)}\n`);
  writeFileSync(join(outDir, 'cli.js'), body);
}

/** A CLI that waits forever when its stdin is a pipe, and exits 0 when stdin is closed (/dev/null). */
const STDIN_CLOSED_BODY =
  [
    "const { fstatSync } = require('node:fs');",
    'if (fstatSync(0).isCharacterDevice()) process.exit(0);',
    'process.stdin.resume();',
    'setInterval(() => {}, 60_000);',
  ].join('\n') + '\n';

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'run' || argv[1] === undefined) {
    throw new Error('usage: hidden-fake-factory run <spec.md> --out <dir> --cutoff <HH:MM> --task-concurrency <n> --deliver-unverified');
  }
  const specPath = argv[1];
  const outIndex = argv.indexOf('--out');
  const outDir = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (outDir === undefined) throw new Error('the fake factory needs --out <dir>');
  const mode = (readFileSync(specPath, 'utf8').split('\n')[0] ?? '').replace(/^mode:\s*/, '').trim();
  mkdirSync(outDir, { recursive: true });
  const name = basename(outDir);
  switch (mode) {
    case 'deliver-js':
      writeDeliverJs(outDir, name);
      break;
    case 'deliver-build':
      writeDeliverBuild(outDir, name);
      break;
    case 'deliver-http':
      writeDeliverHttp(outDir, name, 'node server.js');
      break;
    case 'deliver-bun-http':
      writeDeliverHttp(outDir, name, 'bun server.js');
      break;
    case 'server-bin':
      writeServerBin(outDir, name);
      break;
    case 'server-main-bin':
      writeServerMainBin(outDir, name);
      break;
    case 'stdin-closed-bin':
      writeBinWithBody(outDir, name, STDIN_CLOSED_BODY);
      break;
    case 'hanging-bin':
      writeBinWithBody(outDir, name, 'setInterval(() => {}, 60_000);\n');
      break;
    case 'missing-import':
      writeMissingImport(outDir, name);
      break;
    case 'throwing-bin':
      writeBinWithBody(outDir, name, "throw new Error('boom');\n");
      break;
    case 'usage-exit':
      writeBinWithBody(outDir, name, "process.stderr.write('usage: cli <file>\\n');\nprocess.exit(1);\n");
      break;
    case 'hang':
      process.stdout.write('the fake factory hangs now\n');
      setInterval(() => {}, 60_000);
      break;
    case 'hang-ignoring-term':
      process.on('SIGTERM', () => process.stdout.write('the fake factory ignores SIGTERM\n'));
      process.stdout.write('the fake factory hangs now\n');
      setInterval(() => {}, 60_000);
      break;
    default:
      throw new Error(`unknown fake factory mode: ${JSON.stringify(mode)}`);
  }
}

if (import.meta.main) main();
