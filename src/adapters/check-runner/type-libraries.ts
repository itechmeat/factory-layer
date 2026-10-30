/**
 * The type libraries a package's `tsconfig.json` names in
 * `compilerOptions.types` that its own `node_modules` does not hold. The
 * factory's task trees live inside the factory repository, whose own
 * `node_modules` the TypeScript compiler finds by walking up the
 * directories, so a package that never declared such a library still builds
 * there and fails anywhere else. Reading is lenient: comments and trailing
 * commas are allowed, and an absent or unreadable config names nothing.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const TsconfigSchema = z.object({
  compilerOptions: z.object({ types: z.array(z.string()).optional() }).optional(),
});

/** JSON with comments and trailing commas made plain JSON; strings are kept as they are. */
export function stripJsonComments(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text.charAt(end) !== '"') end += text.charAt(end) === '\\' ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text.charAt(index) !== '\n') index += 1;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out.replaceAll(/,(\s*[}\]])/g, '$1');
}

/** The names in `compilerOptions.types` of `dir`'s tsconfig.json, or none. */
async function declaredTypes(dir: string): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'tsconfig.json'), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = TsconfigSchema.safeParse(JSON.parse(stripJsonComments(raw)));
    return parsed.success ? (parsed.data.compilerOptions?.types ?? []) : [];
  } catch {
    return [];
  }
}

/** The type library names of `dir`'s tsconfig.json that neither `node_modules/@types/<name>` nor `node_modules/<name>` holds. */
export async function missingTypeLibraries(dir: string): Promise<readonly string[]> {
  const names = await declaredTypes(dir);
  return names.filter(
    (name) =>
      !name.startsWith('.') &&
      !name.startsWith('/') &&
      !existsSync(join(dir, 'node_modules', '@types', name)) &&
      !existsSync(join(dir, 'node_modules', name)),
  );
}
