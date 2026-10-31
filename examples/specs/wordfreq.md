# wordfreq: word frequency counter

## Purpose

`wordfreq` is a small command-line tool that reads text and prints how
often each word occurs, most frequent first. It is used in shell pipelines,
so its output must be stable and machine-readable.

## Package

1. A TypeScript package named `wordfreq` with a `bin` entry `wordfreq`.
2. The package's tests pass.
3. The package also exports a function `countWords(text: string): Array<{
   word: string; count: number }>` from its main entry, returning the same
   ranking the CLI prints (before `--top` is applied).

## Words

1. A word is a maximal run of Unicode letters, digits and apostrophes
   (`'`). Everything else separates words.
2. Words are compared case-insensitively and printed in lower case.
3. A leading or trailing apostrophe is not part of the word (`'tis'`
   counts as `tis`); an apostrophe inside a word is kept (`don't`).
4. Runs made only of apostrophes are not words.

## Usage

```
wordfreq [options] [file ...]
```

1. With one or more files, the text is the concatenation of the files in
   the given order. With no file, or with `-` as a file, the text is read
   from standard input.
2. Options:
   1. `--top N`: print only the first N entries (N is an integer of 1 or
      more).
   2. `--min N`: print only words that occur at least N times (N is an
      integer of 1 or more).
   3. `--json`: print a JSON array of `{"word": ..., "count": ...}` objects
      instead of lines.
   4. `--help`: print a usage summary to standard output and exit 0.
3. Options may appear before or after the files.

## Output

1. Entries are ordered by count, descending; ties are ordered by word in
   ascending code-point order.
2. Without `--json`, each entry is one line: the count, one tab, the word,
   then a newline. Nothing else is printed.
3. With `--json`, the output is one JSON array on a single line followed by
   a newline.
4. Text with no words prints nothing (or `[]` with `--json`) and exits 0.

## Errors

1. An unknown option, a missing or invalid number for `--top` or `--min`:
   print one line starting with `wordfreq: ` to standard error and exit 2.
2. A file that cannot be read: print one line starting with `wordfreq: `
   that names the file to standard error and exit 1; nothing is printed to
   standard output.

## Examples

```
$ printf 'the cat and the hat\n' | wordfreq
2	the
1	and
1	cat
1	hat

$ printf "Don't stop. DON'T!\n" | wordfreq --json
[{"word":"don't","count":2},{"word":"stop","count":1}]

$ printf 'a b a c b a\n' | wordfreq --top 2
3	a
2	b

$ printf 'a b a c b a\n' | wordfreq --min 2
3	a
2	b

$ wordfreq --top 0 notes.txt
wordfreq: --top needs an integer of 1 or more
(exit code 2)

$ wordfreq missing.txt
wordfreq: cannot read missing.txt
(exit code 1)
```
