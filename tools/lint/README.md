# Linter

ESLint with bug-finding rules only. There are no style rules. It lives here, apart from the packages, so it never ships in them.

## Run it

Needs Node 22.13 or newer. The type-aware checks read this repo's dependencies, so install those too. The run can take a few minutes and needs up to about 6 GB of memory.

```bash
npm ci --ignore-scripts
npm ci --prefix tools/lint --ignore-scripts
npm run lint --prefix tools/lint
```

## Existing issues

`eslint-suppressions.json` lists the issues that were already in the code when the linter was added, as a count per file and rule. They don't fail the run. A new issue fails it, unless a listed issue of the same rule in the same file was removed in the same change, because the list holds counts rather than exact lines.

After fixing listed issues, shrink the list, or the run fails:

```bash
npm run lint:prune --prefix tools/lint
```

Don't add entries to it to get a pass. Fix the new issue, or use an `eslint-disable-next-line` comment that says why it's safe.

## Layer check

`layers.mjs` checks that imports in `src/` follow the layer order in `layers.json`. `layers-baseline.txt` lists the imports that already broke it. See [ARCHITECTURE.md](../../ARCHITECTURE.md#the-check).

## File size check

`file-size.mjs` fails when a source file in `src/` or `packages/*/src/` is over 800 lines. Source files are `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` and `.tsx`, not declaration files (`.d.ts`). Split a long file into smaller modules rather than raising the limit.

`file-size-baseline.json` lists the files that were already longer, with their length at the time. They don't fail the run. When one of them grows, CI shows a warning on the file. When one is deleted or drops to 800 lines or fewer, the run fails until its entry is removed:

```bash
node tools/lint/file-size.mjs --prune
```

Don't add entries to get a pass. When you move or rename a listed file, rename its entry in the same change and keep the recorded length.

## What's left out

- `test/package-consumer/`: its own project, which needs the packed packages.
- Type-aware checks cover TypeScript under `src`, `test` and `packages/*/{src,test}`. JavaScript files have no types to read, so a missed `await` isn't caught there.
