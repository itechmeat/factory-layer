/**
 * Function tools declared with Zod. A declaration yields the Mozaik
 * function `Tool` offered to the model (its JSON Schema generated from the
 * input side of the Zod schema, which is what the model sends) and validates
 * every function call the model returns.
 *
 * Invariant: arguments reach a handler or a caller only after they pass the
 * tool's schema; anything else is a typed invalid-arguments error.
 */

import type { FunctionCallItem, Tool } from '@mozaik-ai/core';
import { z } from 'zod';

import { BrainError } from './errors';

/** A tool offered to the model: its name, what it does, and the schema of its arguments. */
export interface ToolDeclaration<TArgs> {
  readonly name: string;
  readonly description: string;
  readonly args: z.ZodType<TArgs>;
}

/** A function call whose arguments passed the tool's schema. */
export interface ParsedFunctionCall<TArgs> {
  readonly name: string;
  readonly args: TArgs;
}

function invalidArguments(tool: string, problem: string): BrainError {
  return new BrainError('invalid_arguments', `Function call to "${tool}" has invalid arguments: ${problem}`, { retryable: true, tool });
}

function validate<TArgs>(tool: ToolDeclaration<TArgs>, value: unknown): TArgs {
  const parsed = tool.args.safeParse(value);
  if (parsed.success) return parsed.data;
  const problem = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  throw invalidArguments(tool.name, problem);
}

/** The Mozaik function tool for a declaration; `invoke` validates its arguments before `handler` runs. */
export function toFunctionTool<TArgs>(tool: ToolDeclaration<TArgs>, handler: (args: TArgs) => Promise<unknown>): Tool {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(tool.args, { io: 'input' });
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters,
    strict: false, // mandatory in Mozaik 4.2.0; provider strict mode rejects many valid schemas
    invoke: async (args: unknown) => handler(validate(tool, args)),
  };
}

/** Validates a model's function call against the offered tools; throws an invalid-arguments `BrainError`. */
export function parseFunctionCall<TArgs>(call: FunctionCallItem, tools: readonly ToolDeclaration<TArgs>[]): ParsedFunctionCall<TArgs> {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined) throw invalidArguments(call.name, 'no such tool was offered');
  let json: unknown;
  try {
    json = JSON.parse(call.args);
  } catch {
    throw invalidArguments(call.name, 'the arguments are not valid JSON');
  }
  return { name: tool.name, args: validate(tool, json) };
}
