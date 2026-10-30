/**
 * The prompt text every role shares: how an answer is delivered. Prompts
 * stay schema-agnostic: the submit tool's own description and parameter
 * schema state the fields, so a schema change never needs a prompt change.
 */

import { SUBMIT_TOOL_NAME } from '../decision';

/** The closing instruction of every role prompt. */
export const SUBMIT_INSTRUCTION = [
  `Deliver your answer only by calling the \`${SUBMIT_TOOL_NAME}\` tool, exactly once, with the fields as described by the tool.`,
  'Do not answer in plain text and do not ask questions: decide with the information given.',
  'If the tool reports an error, read it, fix your answer and call the tool again.',
].join('\n');

/** Joins a role's paragraphs and the submit instruction into one system prompt. */
export function rolePrompt(paragraphs: readonly string[]): string {
  return [...paragraphs, SUBMIT_INSTRUCTION].join('\n\n');
}
