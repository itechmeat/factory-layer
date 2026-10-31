#!/bin/sh
# Lays down the factory's default stack in the task's working tree before
# the scaffold agent completes it: strict TypeScript (NodeNext, built to
# dist/), oxlint, oxfmt, Bun tests, Zod, and the package scripts the gates
# run. Idempotent and conservative: an existing file is left alone and an
# existing script keeps its command, so a retry or a stack the agent chose
# survives. Dev tools are pinned to the versions the factory itself uses.
# Prints one JSON object: {"stack":"bun","wrote":[...]}.
set -eu

wrote=""
put() {
  if [ ! -e "$1" ]; then
    mkdir -p "$(dirname "$1")"
    cat >"$1"
    wrote="$wrote $1"
  else
    cat >/dev/null
  fi
}

put tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["src", "test"]
}
JSON

put .oxlintrc.json <<'JSON'
{
  "categories": { "correctness": "error", "suspicious": "error" },
  "ignorePatterns": ["dist/**"]
}
JSON

put .oxfmtrc.json <<'JSON'
{
  "ignorePatterns": ["dist/**"]
}
JSON

put bunfig.toml <<'TOML'
[test]
root = "test"
TOML

put .gitignore <<'TXT'
node_modules/
TXT

if [ ! -e package.json ]; then
  printf '{\n  "name": "package",\n  "version": "0.0.0",\n  "private": true,\n  "type": "module"\n}\n' >package.json
  wrote="$wrote package.json"
fi

# The gate scripts, added only where the manifest has none of that name.
bun -e '
  const path = "package.json";
  const pkg = await Bun.file(path).json();
  const defaults = {
    typecheck: "tsc --noEmit -p tsconfig.json",
    lint: "oxlint",
    format: "oxfmt",
    "format:check": "oxfmt --check",
    build: "tsc -p tsconfig.json",
    test: "bun test",
    check: "bun run typecheck && bun run lint && bun run format:check && bun run test",
  };
  pkg.type ??= "module";
  pkg.scripts = { ...defaults, ...(pkg.scripts ?? {}) };
  await Bun.write(path, JSON.stringify(pkg, null, 2) + "\n");
'

bun add --exact --dev typescript@7.0.2 @types/bun@1.4.4 oxlint@1.90.0 oxfmt@0.75.0 >/dev/null
bun add --exact zod@4.6.7 >/dev/null
# bun writes the manifest in its own key order; the formatter's order is the one the gates check.
./node_modules/.bin/oxfmt package.json >/dev/null

printf '{"stack":"bun","wrote":"%s"}\n' "$(echo $wrote)"
