/**
 * The spec: the one-page Markdown input of a run, with its slug name and its
 * source file. Invariant: the name matches SPEC_NAME_PATTERN, so it is usable
 * as a directory name; it is derived from the file name when not given.
 */

import { z } from 'zod';

/** Slug usable as a directory name. */
export const SPEC_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export const SpecSchema = z.object({
  name: z.string().regex(SPEC_NAME_PATTERN),
  markdown: z.string().min(1),
  sourceFile: z.string().min(1),
});
export type Spec = z.infer<typeof SpecSchema>;

/** The part of a path after the last separator. */
function baseName(sourceFile: string): string {
  const slash = sourceFile.lastIndexOf('/');
  return slash < 0 ? sourceFile : sourceFile.slice(slash + 1);
}

/** `todo-cli.md` -> `todo-cli` (strips the extension, lowercases, slugs). */
export function specNameFromFileName(sourceFile: string): string {
  const file = baseName(sourceFile);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return stem.toLowerCase().replaceAll(/[^a-z0-9._-]/g, '-');
}

/** Builds a spec, deriving the name from the file name when absent. */
export function makeSpec(input: { markdown: string; sourceFile: string; name?: string }): Spec {
  const name = input.name ?? specNameFromFileName(input.sourceFile);
  return SpecSchema.parse({ name, markdown: input.markdown, sourceFile: input.sourceFile });
}
