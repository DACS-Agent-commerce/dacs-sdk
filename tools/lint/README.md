# Linter

ESLint with bug-finding rules only. There are no style rules. It lives here, apart from the packages, so it never ships in them.

## Run it

The type-aware checks read this repo's dependencies, so install those too. The run can take a few minutes and needs up to about 6 GB of memory.

```bash
npm ci --ignore-scripts
npm ci --prefix tools/lint --ignore-scripts
npm run lint --prefix tools/lint
```

## Existing issues

`eslint-suppressions.json` lists the issues that were already in the code when the linter was added, as a count per file and rule. They don't fail the run. A new issue does, even in a file that is already listed.

After fixing listed issues, shrink the list, or the run fails:

```bash
npm run lint:prune --prefix tools/lint
```

Don't add entries to it to get a pass. Fix the new issue, or use an `eslint-disable-next-line` comment that says why it's safe.

## What's left out

- `test/package-consumer/`: its own project, which needs the packed packages.
- Type-aware checks cover TypeScript under `src`, `test` and `packages/*/{src,test}`. JavaScript files have no types to read, so a missed `await` isn't caught there.
