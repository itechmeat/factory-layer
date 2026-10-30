/**
 * APB trust bootstrap for this project (`bun run apb:bootstrap [--agent <cli>]`).
 * From the repository root, honouring `APB_CONFIG_DIR` when it is set:
 *
 * 1. re-writes every project profile under `.apb/profiles/` from its own
 *    `profile.yaml` and `SOUL.md`, with the digest `apb profile show`
 *    reports, which approves its bundle; the write must report trusted, no
 *    failed trust write and no unapproved skills;
 * 2. with `--agent <cli>`, republishes the four starter playbooks through
 *    `playbook_update` with the project profile of that name as their
 *    default profile (a starter that already defaults to it is left alone);
 * 3. approves the smoke playbooks and the four starters through
 *    `playbook_approve`, each of which must come back trusted;
 * 4. prints the trust list entries of what it approved.
 *
 * Every subprocess and MCP call has a timeout; every failure is a
 * `BootstrapError` naming its step, and the process exits non-zero. Nothing
 * printed carries a secret: only names, digests and times.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { connectMcpStdio, type McpStdioClient } from '../src/adapters/mcp-stdio/client';
import { apbMcpCommand } from '../src/adapters/hands-apb/apb-command';

/** The repository root, where `.apb/` lives. */
const REPO_ROOT = join(import.meta.dir, '..');

/** Timeout of one `apb` CLI command, in milliseconds. */
export const APB_CLI_TIMEOUT_MS = 30_000;

/** Timeout of one `playbook_approve` or `playbook_update` call, in milliseconds. */
export const APB_APPROVE_TIMEOUT_MS = 30_000;

/** The coding playbooks the factory dispatches; `--agent` switches their default profile. */
export const STARTER_PLAYBOOKS = ['scaffold', 'implement-task', 'repair', 'integrate'] as const;

/**
 * Every playbook the factory runs unattended, approved by explicit
 * confirmation after review: APB cannot trial a script playbook before the
 * first commit, and a starter's trial would run in the factory's own tree.
 */
export const BOOTSTRAP_PLAYBOOKS = ['smoke', 'smoke-stall', 'smoke-fail', ...STARTER_PLAYBOOKS] as const;

/** A bootstrap step failed. */
export class BootstrapError extends Error {
  readonly step: string;

  constructor(step: string, message: string) {
    super(`${step}: ${message}`);
    this.name = 'BootstrapError';
    this.step = step;
  }
}

const ProfileYamlSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  executor: z.object({
    agent: z.string().min(1),
    model: z.string().min(1),
    fallbacks: z.array(z.object({ agent: z.string().min(1), model: z.string().min(1) })).default([]),
  }),
  soul: z.string().default('any'),
  skills: z.array(z.string()).default([]),
});

/** A project profile as `profile.yaml` declares it. */
export type ProfileYaml = z.infer<typeof ProfileYamlSchema>;

/** `apb profile show <name>`, reduced to the digest an update must match. */
export const ProfileShowSchema = z.looseObject({ profile_digest: z.string().min(1) });

const ProfileWriteSchema = z.looseObject({
  bundle_digest: z.string().min(1),
  trusted: z.boolean(),
  trust_write_failed: z.boolean(),
  skills_unapproved: z.array(z.string()).optional(),
});

const ApproveSchema = z.looseObject({ trusted: z.boolean() });

const UpdateSchema = z.looseObject({ id: z.string(), version: z.string().min(1) });

const TrustListSchema = z.array(z.looseObject({ kind: z.string(), id: z.string(), digest: z.string(), approved_at_ms: z.number() }));

function problemOf(error: z.ZodError): string {
  return z.prettifyError(error);
}

/** The profile declared by `source`, validated. */
export function parseProfileYaml(name: string, source: string): ProfileYaml {
  const parsed = ProfileYamlSchema.safeParse(Bun.YAML.parse(source));
  if (!parsed.success) throw new BootstrapError(`profile ${name}`, `profile.yaml is malformed: ${problemOf(parsed.error)}`);
  return parsed.data;
}

/** The `apb` arguments that re-write `profile` unchanged, guarded by `expectedDigest`. */
export function profileWriteArgs(profile: ProfileYaml, soulPath: string, expectedDigest: string): string[] {
  return [
    'profile',
    'write',
    profile.name,
    '--agent',
    profile.executor.agent,
    '--model',
    profile.executor.model,
    ...profile.executor.fallbacks.flatMap((fallback) => ['--fallback', `${fallback.agent}:${fallback.model}`]),
    ...profile.skills.flatMap((skill) => ['--skill', skill]),
    '--soul',
    soulPath,
    '--soul-requirement',
    profile.soul,
    '--description',
    profile.description,
    '--expected-digest',
    expectedDigest,
  ];
}

/** Validates `text` as JSON of `schema`; a failure names `step`. */
export function parseJsonOutput<T>(step: string, text: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BootstrapError(step, 'the output is not JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BootstrapError(step, `unexpected output: ${problemOf(parsed.error)}`);
  return parsed.data;
}

/** The bundle digest of a profile write that left the bundle approved. */
export function checkProfileWrite(name: string, answer: unknown): string {
  const step = `profile ${name}`;
  const parsed = ProfileWriteSchema.safeParse(answer);
  if (!parsed.success) throw new BootstrapError(step, `unexpected write answer: ${problemOf(parsed.error)}`);
  const write = parsed.data;
  if (write.trust_write_failed) throw new BootstrapError(step, 'the approval could not be written to the trust store');
  if ((write.skills_unapproved ?? []).length > 0) {
    throw new BootstrapError(step, `unapproved skills: ${(write.skills_unapproved ?? []).join(', ')}`);
  }
  if (!write.trusted) throw new BootstrapError(step, 'the bundle is not trusted after the write');
  return write.bundle_digest;
}

/** Fails unless `answer` reports the playbook trusted. */
export function checkApproval(id: string, answer: unknown): void {
  const parsed = ApproveSchema.safeParse(answer);
  if (!parsed.success) throw new BootstrapError(`playbook ${id}`, `unexpected approve answer: ${problemOf(parsed.error)}`);
  if (!parsed.data.trusted) throw new BootstrapError(`playbook ${id}`, 'playbook_approve did not report it trusted');
}

/** The trust list entries of the approved playbooks and written bundles, one line each. */
export function projectTrustLines(
  entries: z.infer<typeof TrustListSchema>,
  approved: { readonly playbookIds: readonly string[]; readonly bundleDigests: readonly string[] },
): string[] {
  const kept = entries.filter(
    (entry) =>
      (entry.kind === 'playbook' && approved.playbookIds.includes(entry.id)) ||
      (entry.kind === 'profile_bundle' && approved.bundleDigests.includes(entry.digest)),
  );
  for (const id of approved.playbookIds) {
    if (!kept.some((entry) => entry.kind === 'playbook' && entry.id === id)) {
      throw new BootstrapError('trust list', `playbook ${id} is missing`);
    }
  }
  for (const digest of approved.bundleDigests) {
    if (!kept.some((entry) => entry.digest === digest)) {
      throw new BootstrapError('trust list', `profile bundle ${digest} is missing`);
    }
  }
  const idWidth = Math.max(0, ...kept.map((entry) => entry.id.length)) + 2;
  return kept.map(
    (entry) => `${entry.kind.padEnd(16)}${entry.id.padEnd(idWidth)}${entry.digest}  ${new Date(entry.approved_at_ms).toISOString()}`,
  );
}

/** The command line options. */
export interface BootstrapOptions {
  /** The project profile the starters should default to; absent leaves them as they are. */
  readonly agent: string | undefined;
}

/** Parses the bootstrap's arguments (`--agent <cli>` or `--agent=<cli>`). */
export function parseBootstrapArgs(argv: readonly string[]): BootstrapOptions {
  let agent: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--agent' || arg.startsWith('--agent=')) {
      const value = arg === '--agent' ? argv[(index += 1)] : arg.slice('--agent='.length);
      if (value === undefined || value === '' || value.startsWith('-'))
        throw new BootstrapError('arguments', '--agent needs a profile name');
      agent = value;
    } else {
      throw new BootstrapError('arguments', `unknown argument ${arg}; usage: apb:bootstrap [--agent <cli>]`);
    }
  }
  return { agent };
}

/** Fails unless `agent` names one of the project profiles. */
export function checkAgent(agent: string, profiles: readonly string[]): void {
  if (!profiles.includes(agent)) {
    throw new BootstrapError('arguments', `no project profile named ${agent}; the project profiles are ${profiles.join(', ')}`);
  }
}

/** The `defaults.profile` block of a stored playbook, as APB writes it. */
const DEFAULT_PROFILE_BLOCK = /^defaults:\n {2}profile:\n {4}name: (\S+)\n/m;

const PlaybookDefaultsSchema = z.looseObject({
  id: z.string(),
  defaults: z.looseObject({ profile: z.looseObject({ name: z.string() }) }),
});

/** The default profile a stored playbook names. */
export function defaultProfileOf(id: string, yaml: string): string {
  const parsed = PlaybookDefaultsSchema.safeParse(Bun.YAML.parse(yaml));
  if (!parsed.success) throw new BootstrapError(`playbook ${id}`, `no default profile: ${problemOf(parsed.error)}`);
  return parsed.data.defaults.profile.name;
}

/** `yaml` with `profile` as its default profile; everything else stays byte for byte. */
export function withDefaultProfile(id: string, yaml: string, profile: string): string {
  if (!DEFAULT_PROFILE_BLOCK.test(yaml)) {
    throw new BootstrapError(`playbook ${id}`, 'the playbook has no defaults.profile.name block to switch');
  }
  const updated = yaml.replace(DEFAULT_PROFILE_BLOCK, `defaults:\n  profile:\n    name: ${profile}\n`);
  if (defaultProfileOf(id, updated) !== profile)
    throw new BootstrapError(`playbook ${id}`, 'the switched playbook does not name the profile');
  return updated;
}

/** The version a `playbook_update` answer reports. */
export function checkUpdate(id: string, answer: unknown): string {
  const parsed = UpdateSchema.safeParse(answer);
  if (!parsed.success) throw new BootstrapError(`playbook ${id}`, `unexpected update answer: ${problemOf(parsed.error)}`);
  return parsed.data.version;
}

/** How one `apb` CLI command ended. */
export interface ApbExit {
  readonly signal: string | number | null;
  readonly code: number | null;
  readonly elapsedMs: number;
  readonly stderr: string;
}

/**
 * The failure message of an ended `apb` command, or null when it succeeded.
 * The timeout kills with SIGKILL, but so do the OOM killer and `kill -9`:
 * a SIGKILL counts as the timeout only once the timeout has elapsed.
 */
export function apbExitFailure(exit: ApbExit): string | null {
  if (exit.signal === 'SIGKILL' && exit.elapsedMs >= APB_CLI_TIMEOUT_MS) return `apb did not finish within ${APB_CLI_TIMEOUT_MS} ms`;
  if (exit.signal !== null) return `apb was killed by ${exit.signal}`;
  if (exit.code !== 0) return `apb exited with ${exit.code}: ${exit.stderr.trim().slice(-500)}`;
  return null;
}

/** Runs `apb <args>` in the repository root; its stdout, or a typed failure. */
async function apb(step: string, args: readonly string[]): Promise<string> {
  const startedAt = performance.now();
  const child = Bun.spawn(['apb', ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: APB_CLI_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const failure = apbExitFailure({ signal: child.signalCode, code, elapsedMs: performance.now() - startedAt, stderr });
  if (failure !== null) throw new BootstrapError(step, failure);
  return stdout;
}

/** Re-writes one project profile; returns its approved bundle digest. */
async function rewriteProfile(name: string): Promise<string> {
  const dir = join(REPO_ROOT, '.apb', 'profiles', name);
  const profile = parseProfileYaml(name, readFileSync(join(dir, 'profile.yaml'), 'utf8'));
  const shown = parseJsonOutput(`profile ${name}`, await apb(`profile ${name}`, ['profile', 'show', name]), ProfileShowSchema);
  const written = await apb(`profile ${name}`, profileWriteArgs(profile, join(dir, 'SOUL.md'), shown.profile_digest));
  return checkProfileWrite(name, parseJsonOutput(`profile ${name}`, written, z.unknown()));
}

/** The YAML of the current version of a project playbook. */
function currentPlaybookYaml(id: string): string {
  const dir = join(REPO_ROOT, '.apb', 'playbooks', id);
  const version = readFileSync(join(dir, 'current'), 'utf8').trim();
  return readFileSync(join(dir, version, 'playbook.yaml'), 'utf8');
}

/** Republishes the starters that do not default to `agent` yet; returns what changed, one line each. */
async function switchStarters(client: McpStdioClient, agent: string): Promise<string[]> {
  const changed: string[] = [];
  for (const id of STARTER_PLAYBOOKS) {
    const yaml = currentPlaybookYaml(id);
    if (defaultProfileOf(id, yaml) === agent) continue;
    const answer = await client.callToolParsed('playbook_update', { id, yaml: withDefaultProfile(id, yaml, agent) }, z.unknown(), {
      timeoutMs: APB_APPROVE_TIMEOUT_MS,
    });
    changed.push(`playbook ${id}: version ${checkUpdate(id, answer)} defaults to profile ${agent}`);
  }
  return changed;
}

/** Switches the starters when asked, then approves every bootstrap playbook. */
async function publishAndApprove(agent: string | undefined): Promise<void> {
  const apbPath = Bun.which('apb');
  if (apbPath === null) throw new BootstrapError('apb mcp', 'apb is not on the PATH');
  const client = await connectMcpStdio(apbMcpCommand(apbPath, REPO_ROOT));
  try {
    if (agent !== undefined) for (const line of await switchStarters(client, agent)) console.log(line);
    for (const id of BOOTSTRAP_PLAYBOOKS) {
      const answer = await client.callToolParsed('playbook_approve', { id }, z.unknown(), {
        timeoutMs: APB_APPROVE_TIMEOUT_MS,
      });
      checkApproval(id, answer);
    }
  } finally {
    await client.close();
  }
}

/** Every project profile name under `.apb/profiles/`. */
function projectProfiles(): string[] {
  const root = join(REPO_ROOT, '.apb', 'profiles');
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .toSorted();
}

async function main(): Promise<void> {
  const { agent } = parseBootstrapArgs(Bun.argv.slice(2));
  const profiles = projectProfiles();
  if (agent !== undefined) checkAgent(agent, profiles);
  const location = process.env['APB_CONFIG_DIR'] ? 'the APB_CONFIG_DIR trust store' : 'the default APB trust store';
  console.log(`APB trust bootstrap into ${location}`);
  const bundleDigests: string[] = [];
  for (const name of profiles) {
    bundleDigests.push(await rewriteProfile(name));
    console.log(`profile ${name}: bundle approved`);
  }
  await publishAndApprove(agent);
  console.log(`playbooks approved: ${BOOTSTRAP_PLAYBOOKS.join(', ')}`);
  const list = parseJsonOutput('trust list', await apb('trust list', ['trust', 'list', '--json']), TrustListSchema);
  for (const line of projectTrustLines(list, { playbookIds: BOOTSTRAP_PLAYBOOKS, bundleDigests })) console.log(line);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`APB trust bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
