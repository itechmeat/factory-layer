/**
 * The HTTP examples of a spec as ground truth, beside its shell examples.
 * The examples are the first fenced block holding a request line
 * (`METHOD /path`). Each example is the request line, an optional one-line
 * request body, a status line `=> NNN` and an optional one-line JSON
 * response body; a blank line ends it. They run in order against one
 * freshly started server, so each expectation follows from the requests
 * before it. A malformed block is an error value naming the block line,
 * never a silently shorter list. As checks, a JSON request body is sent as
 * `application/json`, any other text as is (a malformed body is a valid
 * example), and an expected response body is compared as exact JSON; without
 * one only the status is judged. Pure text rules, no IO.
 */

import { DEFAULT_CHECK_TIMEOUT_MS, type HttpCheck } from './acceptance';

/** One example request with the response the spec expects. */
export interface HttpExample {
  readonly method: string;
  readonly path: string;
  readonly body: string | undefined;
  readonly expectedStatus: number;
  /** The expected JSON body; `undefined` when the example names none. */
  readonly expectedBody: { readonly value: unknown } | undefined;
  /** The example's lines as written in the spec. */
  readonly raw: string;
}

/** The parsed examples, or why the block could not be read. */
export type ParsedHttpExamples =
  | { readonly ok: true; readonly examples: readonly HttpExample[] }
  | { readonly ok: false; readonly error: string };

const FENCE = /^\s*(?:```|~~~)/;
const REQUEST_LINE = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/\S*)$/;
const STATUS_LINE = /^=> (.*)$/;

/** The content lines of the first closed fenced block that holds a request line, or null. */
function exampleBlock(markdown: string): readonly string[] | null {
  let current: string[] | null = null;
  for (const line of markdown.split('\n')) {
    if (!FENCE.test(line)) {
      current?.push(line.trim());
      continue;
    }
    if (current === null) {
      current = [];
      continue;
    }
    if (current.some((inner) => REQUEST_LINE.test(inner))) return current;
    current = null;
  }
  return null;
}

/** True when the spec has a fenced block of HTTP examples. */
export function hasHttpExamples(markdown: string): boolean {
  return exampleBlock(markdown) !== null;
}

interface Draft {
  method: string;
  path: string;
  body: string | undefined;
  status: number | undefined;
  expectedBody: { value: unknown } | undefined;
  raw: string[];
}

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/** Apply one non-request, non-blank line to the open example; an error text when it does not fit. */
function addLine(draft: Draft, line: string): string | undefined {
  draft.raw.push(line);
  const status = STATUS_LINE.exec(line);
  if (status !== null) {
    if (draft.status !== undefined) return 'a second status line';
    const code = status[1] ?? '';
    if (!/^[1-5]\d\d$/.test(code)) return `status "${code}" is not an HTTP status code`;
    draft.status = Number(code);
    return undefined;
  }
  if (draft.status === undefined) {
    if (draft.body !== undefined) return 'a second request body line';
    draft.body = line;
    return undefined;
  }
  if (draft.expectedBody !== undefined) return 'a second response body line';
  const parsed = parseJson(line);
  if (parsed === undefined) return 'the response body is not JSON';
  draft.expectedBody = parsed;
  return undefined;
}

/** Parse the HTTP example block of a spec. */
export function parseHttpExamples(markdown: string): ParsedHttpExamples {
  const block = exampleBlock(markdown);
  if (block === null) return { ok: false, error: 'no fenced block with an HTTP request line' };
  const examples: HttpExample[] = [];
  let draft: Draft | undefined;
  let draftLine = 0;
  const close = (): string | undefined => {
    if (draft === undefined) return undefined;
    const { method, path, body, status, expectedBody, raw } = draft;
    draft = undefined;
    if (status === undefined) return `block line ${draftLine}: ${method} ${path} has no \`=> <status>\` line`;
    examples.push({ method, path, body, expectedStatus: status, expectedBody, raw: raw.join('\n') });
    return undefined;
  };
  for (const [index, line] of block.entries()) {
    const request = REQUEST_LINE.exec(line);
    if (request !== null || line === '') {
      const unclosed = close();
      if (unclosed !== undefined) return { ok: false, error: unclosed };
      if (request !== null) {
        draft = {
          method: request[1] ?? '',
          path: request[2] ?? '',
          body: undefined,
          status: undefined,
          expectedBody: undefined,
          raw: [line],
        };
        draftLine = index + 1;
      }
      continue;
    }
    if (draft === undefined) return { ok: false, error: `block line ${index + 1}: text before any request line` };
    const problem = addLine(draft, line);
    if (problem !== undefined) return { ok: false, error: `block line ${index + 1}: ${problem}` };
  }
  const unclosed = close();
  return unclosed === undefined ? { ok: true, examples } : { ok: false, error: unclosed };
}

/** The examples as HTTP checks, in order, with ids `${idPrefix}${firstNumber}` onwards. */
export function httpExampleChecks(examples: readonly HttpExample[], idPrefix: string, firstNumber: number): HttpCheck[] {
  return examples.map((example, index) => {
    const check: HttpCheck = {
      kind: 'http',
      id: `${idPrefix}${String(firstNumber + index)}`,
      description: `Spec example: ${example.method} ${example.path}`,
      source: example.raw,
      timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
      method: example.method,
      path: example.path,
      expectedStatus: example.expectedStatus,
    };
    if (example.body !== undefined) {
      check.body = example.body;
      if (parseJson(example.body) !== undefined) check.headers = { 'content-type': 'application/json' };
    }
    if (example.expectedBody !== undefined) check.expectedBody = { kind: 'exactJson', value: example.expectedBody.value };
    return check;
  });
}
