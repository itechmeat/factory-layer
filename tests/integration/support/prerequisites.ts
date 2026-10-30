/**
 * Prerequisite checks for the integration smokes. A smoke calls these first,
 * so a missing variable or binary fails the smoke with a message naming the
 * prerequisite and how to provide it, never a silent pass.
 */

/** A prerequisite of an integration smoke is missing. */
export class PrerequisiteError extends Error {
  constructor(message: string) {
    super(`missing prerequisite: ${message}`);
    this.name = 'PrerequisiteError';
  }
}

/** The non-empty value of `name`; Bun loads `.env` for `bun test`. */
export function requireEnv(name: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new PrerequisiteError(`environment variable ${name} is not set; add it to .env (see .env.example)`);
  }
  return value;
}

/** The resolved path of `name` on the PATH. */
export function requireBinary(name: string): string {
  const path = Bun.which(name);
  if (path === null) throw new PrerequisiteError(`"${name}" is not on the PATH; install it and retry`);
  return path;
}
