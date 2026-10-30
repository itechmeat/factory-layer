/**
 * The prompt text every role shares: how an answer is delivered, and the
 * shell a check command runs in (the Node-only tool directory, portable
 * between Linux and macOS). Prompts stay schema-agnostic: the submit tool's own description and parameter
 * schema state the fields, so a schema change never needs a prompt change.
 */

import { NODE_ONLY_TOOLS } from '../../node-only-env';
import { SUBMIT_TOOL_NAME } from '../decision';

/** The closing instruction of every role prompt. */
export const SUBMIT_INSTRUCTION = [
  `Deliver your answer only by calling the \`${SUBMIT_TOOL_NAME}\` tool, exactly once, with the fields as described by the tool.`,
  'Do not answer in plain text and do not ask questions: decide with the information given.',
  'If the tool reports an error, read it, fix your answer and call the tool again.',
].join('\n');

/** What a check's shell command may use: the tools on its PATH and portable shell only. */
export const CHECK_SHELL_RULES = [
  `A shell command of a check runs under \`bash -c\` with only these tools on the PATH: ${NODE_ONLY_TOOLS.map((tool) => `\`${tool}\``).join(', ')}, plus the package's own commands. Any other tool (such as \`curl\`, \`seq\`, \`jq\` or \`python\`) is missing; an HTTP request from a command is made with \`node -e\` and \`fetch\`.`,
  'The command must work on Linux and on macOS, where `bash` may be version 3.2 and the tools are BSD ones: no bash 4 features (associative arrays, `${x,,}`, `mapfile`, `&>>`), no GNU-only flags (`sed -i`, `date -d`, `grep -P`, `stat -c`, `readlink -f`), no `timeout`; BSD `wc -l` pads its count with spaces, so compare counts numerically.',
  'A command never starts a server or any other background process (`&`, `npm start`), never picks a port and never sleeps to wait for something: a running server is judged only by `http` checks, which start and stop it; a rule that needs a restart or a second server process is not checked.',
].join(' ');

/** Joins a role's paragraphs and the submit instruction into one system prompt. */
export function rolePrompt(paragraphs: readonly string[]): string {
  return [...paragraphs, SUBMIT_INSTRUCTION].join('\n\n');
}
