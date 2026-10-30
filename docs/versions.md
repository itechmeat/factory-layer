# Pinned versions

Every dependency is pinned exactly in `package.json`. Versions were taken
from the npm registry (`npm view <pkg> version`) on the date shown.

## Runtime

| Tool | Version | Date | Note |
| --- | --- | --- | --- |
| Bun | 1.4.4 | 2026-10-30 | `.bun-version`, `packageManager` |

## Dependencies

| Package | Version | Date | Note |
| --- | --- | --- | --- |
| `@mozaik-ai/core` | 4.2.0 | 2026-10-30 | exact, never newer; code against its `dist/index.d.ts` |
| `@modelcontextprotocol/sdk` | 1.32.2 | 2026-10-30 | stdio MCP client |
| `zod` | 4.6.7 | 2026-10-30 | boundary validation |

## Dev dependencies

| Package | Version | Date | Note |
| --- | --- | --- | --- |
| `typescript` | 7.0.2 | 2026-10-30 | |
| `@types/bun` | 1.4.4 | 2026-10-30 | matches Bun |
| `oxlint` | 1.90.0 | 2026-10-30 | `--type-aware --deny-warnings` |
| `oxlint-tsgolint` | 7.0.2005 | 2026-10-30 | type-aware engine, versioned against TypeScript 7.0 |
| `oxfmt` | 0.75.0 | 2026-10-30 | |
| `dependency-cruiser` | 18.7.0 | 2026-10-30 | layer rule; does not support TypeScript 7, parses with swc |
| `@swc/core` | 1.16.20 | 2026-10-30 | parser for dependency-cruiser |
| `knip` | 6.44.0 | 2026-10-30 | dead code |
| `lefthook` | 2.2.2 | 2026-10-30 | Git hooks |

## Tools outside `package.json`

| Tool | Version | Date | Note |
| --- | --- | --- | --- |
| OpenSpec CLI | 1.14.3 | 2026-10-30 | `openspec init`, schema `spec-driven` |
| code-ranker | 5.0.4 | 2026-10-30 | full tier of `scripts/check.sh`, config `code-ranker.toml` |
| zvec-grep (`zg`) | 0.2.2 | 2026-10-30 | semantic code search for the duplication review |
| APB (`apb`) | 1.0.0-beta.1 | 2026-10-30 | the hands, driven through `apb mcp`; the integration smokes and the trust bootstrap ran against it (first built against 0.25.0) |
| Open Second Brain (`o2b`) | 1.96.0 | 2026-10-30 | the memory, `o2b mcp` on a dedicated vault; the memory smoke ran against it |

## GitHub Actions

Pinned to the release's commit in the workflow files.

| Action | Version | Date | Note |
| --- | --- | --- | --- |
| `actions/checkout` | v7.0.1 | 2026-10-30 | `.github/workflows/codeql.yml` |
| `github/codeql-action` | v4.39.1 | 2026-10-30 | init and analyze, `security-extended` |
