import { describe, expect, test } from 'bun:test';

import { SpecSchema, makeSpec, specNameFromFileName } from './spec';

describe('specNameFromFileName', () => {
  test('strips the extension and lowercases', () => {
    expect(specNameFromFileName('todo-cli.md')).toBe('todo-cli');
  });

  test('slugs characters a directory name may not hold', () => {
    expect(specNameFromFileName('Todo CLI.md')).toBe('todo-cli');
  });

  test('strips only the last extension', () => {
    expect(specNameFromFileName('a.spec.md')).toBe('a.spec');
  });

  test('uses the base name of a path', () => {
    expect(specNameFromFileName('specs/todo-cli.md')).toBe('todo-cli');
  });

  test('keeps a file without an extension', () => {
    expect(specNameFromFileName('readme')).toBe('readme');
  });
});

describe('makeSpec', () => {
  test('derives the name from the file name when absent', () => {
    expect(makeSpec({ markdown: '# Todo', sourceFile: 'todo-cli.md' })).toEqual({
      name: 'todo-cli',
      markdown: '# Todo',
      sourceFile: 'todo-cli.md',
    });
  });

  test('keeps an explicit name', () => {
    expect(makeSpec({ name: 'todo', markdown: '# Todo', sourceFile: 'todo-cli.md' }).name).toBe('todo');
  });

  test('rejects an explicit name that is not a slug, naming the path', () => {
    const parsed = SpecSchema.safeParse({ name: 'Todo CLI', markdown: '# Todo', sourceFile: 'todo-cli.md' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(['name']);
  });

  test('rejects an empty markdown, naming the path', () => {
    const parsed = SpecSchema.safeParse({ name: 'todo', markdown: '', sourceFile: 'todo.md' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(['markdown']);
  });
});
