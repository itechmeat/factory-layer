# units: temperature and length converter

## Purpose

`units` is a small command-line tool with two independent commands: one
converts temperatures between Celsius and Fahrenheit, the other converts
lengths between metric and imperial units. Its output is one line, so it
can be used in shell pipelines.

## Package

1. A TypeScript npm package named `units` with a `bin` entry `units` that
   runs under Node 20 or newer (compiled JavaScript or a Node shebang; it
   must not require Bun to run).
2. `npm test` and `bun test` both run the package's tests and pass.
3. Structure: the entry point only dispatches on the command name; each
   command lives in its own module (`src/temp.ts` and `src/length.ts`) and
   exports a pure function, `convertTemp(input: string): string` and
   `convertLength(value: string, from: string, to: string): string`, that
   returns the line to print without its newline and throws an `Error`
   whose message is the error text (without the `units: ` prefix) for bad
   input. The two commands share no code except the number formatting
   below, which lives in `src/format.ts`.

## Usage

```
units temp <value><C|F>
units length <value> <from> <to>
```

## Numbers

1. A value is a decimal number with an optional leading `-`, digits and at
   most one `.` with digits on both sides (`-40`, `3.5`; not `.5`, `1e3`
   or `+2`).
2. A result is rounded to 2 decimal places, then printed without trailing
   zeros after the point and without a trailing point (`3.10` prints
   `3.1`, `5280.00` prints `5280`); a result that rounds to zero prints
   `0`, never `-0`.

## Command `temp`

1. The argument is a value immediately followed by the unit `C` or `F`
   (upper case only): `100C`, `-40F`, `98.6F`.
2. `C` converts to Fahrenheit (`F = C * 9 / 5 + 32`), `F` converts to
   Celsius (`C = (F - 32) * 5 / 9`).
3. The output is the converted value immediately followed by the other
   unit, then a newline: `212F`.

## Command `length`

1. Units, with their length in metres: `m` (1), `km` (1000), `ft`
   (0.3048), `mi` (1609.344). Unit names are lower case only.
2. The output is the converted value, one space, the target unit, then a
   newline: `3.11 mi`.

## Errors

Every error prints one line starting with `units: ` to standard error,
prints nothing to standard output and exits 2:

1. no command or an unknown command: `units: usage: units temp|length ...`;
2. a wrong number of arguments for a command: `units: usage: units temp <value><C|F>` or `units: usage: units length <value> <from> <to>`;
3. a `temp` argument that is not a value followed by `C` or `F`: `units: invalid temperature <argument>`;
4. a `length` value that is not a value: `units: invalid number <value>`;
5. a `length` unit that is not one of the four: `units: unknown unit <unit>`.

## Examples

```
$ units temp 100C
212F

$ units temp 98.6F
37C

$ units temp -40C
-40F

$ units length 5 km mi
3.11 mi

$ units length 1 mi ft
5280 ft

$ units length 30 cm m
units: unknown unit cm
(exit code 2)

$ units temp hot
units: invalid temperature hot
(exit code 2)

$ units convert 1
units: usage: units temp|length ...
(exit code 2)
```
