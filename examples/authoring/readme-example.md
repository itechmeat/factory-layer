# Authoring example: readme

The operator's input for `factory author readme --example
examples/authoring/readme-example.md`. The factory asks its brain for a
reusable playbook that writes a README for one module of a TypeScript
package, trials it once on the instruction below and approves it only when
the trial and the review pass.

## Examples

- write a README for the module `src/parse.ts` of a small TypeScript CLI: what it does, what it exports, one usage example and how it reports errors
- write a README for the module `src/format.ts` of a small TypeScript library, from its source and its tests, without changing any code
- write a README for the module `src/store.ts` of a small TypeScript HTTP service: its purpose, its exported functions with their parameters, and one example

## Trial

Write a short README for the module `src/domain/clock-time.ts` into the new
file `docs/trial/clock-time-readme.md`: what the module does, what it
exports, one usage example and how it reports bad input. Read only that
module and its test `src/domain/clock-time.test.ts`. Create no other file
and change nothing else.
