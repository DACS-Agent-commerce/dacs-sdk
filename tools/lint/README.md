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

## Shared helper check

`shared-helpers.mjs` fails when a file in `src/` declares its own copy of a small helper that should exist once, in `src/internal/`: `deepFreeze`, `exactKeys`, `hasExactKeys`, `isRecord`, `nonEmpty`, `plainObject` and `plainRecord`. Import the shared one instead. If there isn't one yet, move a copy into `src/internal/`, import it from there, and remove the copies you replaced.

`shared-helpers-baseline.txt` lists the copies that already existed. They don't fail the run. When one is removed, the run fails until its line is removed too (`--prune`).

The check is by name. It counts top-level `function` declarations and `const` names whose value is an arrow function or a function expression, also when wrapped in parentheses, `as`, `satisfies` or `!`. Inside `src/internal/` a name may be declared once; a second declaration there counts as a copy.

The file size and shared helper checks also have a `--write-baseline` flag that rewrites the list from the code. Use it only in a change that edits the check itself, and say why in that change; never use it to get a pass.

## Error code check

`error-codes.mjs` checks how errors are built in the files and folders that `error-codes.json` lists under `migrated`. The list is empty until a folder moves to error codes; a folder is listed with a trailing slash. The catalog is the `codeCategory` table in `src/errors.ts`. Each code is lower case, shaped `domain.reason`, and has one category. `sdk.unclassified` is reserved for this check and never goes in the table.

In a migrated file the check refuses:

- `new DacsError`, `new TransientError`, `new CounterpartyError` or `new SubstrateError` without a `code` written as a string literal, with a code that is not in the catalog, or with `sdk.unclassified`;
- a catalog code on `TransientError`, `CounterpartyError` or `SubstrateError` whose category in the table differs from the class's;
- `category` beside `code` on `DacsError`, because the table decides the category;
- any other class that extends `DacsError` and neither takes a catalog code nor declares its own `code`;
- `new WireError`, `new RawJsonAdmissionError`, `new AnchorWaitError`, and a call without a code to the `fail()` helper declared in `src/wire/validate.ts` or the `reject()` helper declared in `src/canonical/rawJson.ts`, in a file that declares or imports it. A function of the same name that is not that helper, such as a Promise executor's `reject`, is not checked. Their codes stay outside the catalog;
- a plain `Error`, `TypeError`, `RangeError` or `SyntaxError` throw that is not listed under `retainedPlainThrows`.

A retained throw is listed with its path, the throw written as it is in the file, and the reason it stays, for example a programmer assertion that no caller can reach. The check also fails when a listed throw has no reason or no longer exists, or when a migrated path does not exist.

Classes are found by name: every top-level class under `src/` that extends `DacsError`, directly or through other classes. The check reads the syntax only. It cannot tell whether a plain throw reaches a caller, so a listed throw is a judgement for the reviewer.

## What's left out

- `test/package-consumer/`: its own project, which needs the packed packages.
- Type-aware checks cover TypeScript under `src`, `test` and `packages/*/{src,test}`. JavaScript files have no types to read, so a missed `await` isn't caught there.
