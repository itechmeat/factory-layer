/**
 * Acceptance checks: the runnable proofs a delivery must pass before it is
 * accepted. Every check names its kind in `kind` and carries a positive
 * integer timeout, 30 s by default, and may cite the spec passage it
 * derives from in `source`; a result says passed, failed or errored with
 * reasons and the redacted captured output. A check objection is the
 * Critic's reason why a derived check contradicts the spec. A check's
 * invocation is the one-line text that tells a repair agent how to run it.
 */

import { z } from 'zod';

/** How long a check may run when no timeout is given. */
export const DEFAULT_CHECK_TIMEOUT_MS = 30_000;

/** Whether `pattern` compiles as a JavaScript regular expression, the dialect the checks run with. */
function compilesAsRegex(pattern: string): boolean {
  try {
    return new RegExp(pattern) instanceof RegExp;
  } catch {
    return false;
  }
}

/** What is expected of a text stream (stdout or stderr); a regex must compile in JavaScript. */
export const ExpectedTextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), value: z.string() }),
  z.object({ kind: z.literal('substring'), value: z.string() }),
  z.object({
    kind: z.literal('regex'),
    pattern: z
      .string()
      .refine(
        compilesAsRegex,
        'not a valid JavaScript regular expression (no inline flags such as `(?s)`; use `[\\s\\S]` to match any character)',
      ),
  }),
]);
export type ExpectedText = z.infer<typeof ExpectedTextSchema>;

/** What is expected of an HTTP response body. */
export const ExpectedBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exactJson'), value: z.unknown() }),
  z.object({ kind: z.literal('jsonSubset'), value: z.unknown() }),
  z.object({ kind: z.literal('substring'), value: z.string() }),
]);
export type ExpectedBody = z.infer<typeof ExpectedBodySchema>;

const checkBase = {
  id: z.string().min(1),
  description: z.string().min(1),
  timeoutMs: z.number().int().positive().default(DEFAULT_CHECK_TIMEOUT_MS),
  /** The spec sentence(s) or example the check derives from, quoted verbatim. */
  source: z.string().optional(),
};

/** Runs the project's CLI with arguments and judges exit code and streams. */
export const CliCheckSchema = z.object({
  ...checkBase,
  kind: z.literal('cli'),
  args: z.array(z.string()),
  stdin: z.string().optional(),
  expectedExitCode: z.number().int(),
  expectedStdout: ExpectedTextSchema.optional(),
  expectedStderr: ExpectedTextSchema.optional(),
});
export type CliCheck = z.infer<typeof CliCheckSchema>;

/** Sends one HTTP request to the started server and judges status and body. */
export const HttpCheckSchema = z.object({
  ...checkBase,
  kind: z.literal('http'),
  method: z.string().min(1),
  /** An origin-relative path: one leading slash, never two (`//host` would name another server). */
  path: z.string().regex(/^\/([^/][\s\S]*)?$/, 'an HTTP check path starts with one `/` and never with `//`'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  expectedStatus: z.number().int(),
  expectedBody: ExpectedBodySchema.optional(),
});
export type HttpCheck = z.infer<typeof HttpCheckSchema>;

/** Runs one shell command and judges its exit code and, when given, its streams. */
export const CommandCheckSchema = z.object({
  ...checkBase,
  kind: z.literal('command'),
  command: z.string().min(1),
  expectedExitCode: z.number().int(),
  expectedStdout: ExpectedTextSchema.optional(),
  expectedStderr: ExpectedTextSchema.optional(),
});
export type CommandCheck = z.infer<typeof CommandCheckSchema>;

export const AcceptanceCheckSchema = z.discriminatedUnion('kind', [CliCheckSchema, HttpCheckSchema, CommandCheckSchema]);
export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

/**
 * How a check is run and what exit code or status it expects, in one line:
 * a repair agent reproduces a failing check from this text, since the check
 * definitions never live in the task's tree.
 */
export function checkInvocation(check: AcceptanceCheck): string {
  switch (check.kind) {
    case 'command':
      return `run from the package root: ${check.command}; expected exit code ${check.expectedExitCode}`;
    case 'cli': {
      const command = ['node <the bin entry named in package.json>', ...check.args.map((arg) => JSON.stringify(arg))].join(' ');
      const stdin = check.stdin === undefined ? '' : ` with standard input ${JSON.stringify(check.stdin)}`;
      return `run from the package root: ${command}${stdin}; expected exit code ${check.expectedExitCode}`;
    }
    case 'http': {
      const body = check.body === undefined ? '' : ` with body ${check.body}`;
      return `request to the started server: ${check.method} ${check.path}${body}; expected status ${check.expectedStatus}`;
    }
  }
}

/** One acceptance check result; produced by the CheckRunner port. */
export const CheckResultSchema = z.object({
  checkId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'errored']),
  reasons: z.array(z.string()),
  detail: z.string(), // redacted, truncated captured output; '' when none
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/** Why a derived check contradicts the spec, its cited source or a spec example. */
export const CheckObjectionSchema = z.object({
  checkId: z.string().min(1),
  reason: z.string().min(1),
});
export type CheckObjection = z.infer<typeof CheckObjectionSchema>;
