# Architecture

This page explains how the code in `src/` is layered and which imports are allowed.
For the folder list, commands and setup, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Layers

The SDK takes an agent through five steps: identify, vet, negotiate, settle and verify. The code for those steps sits on a stack of layers. Each layer may use the layers below it, never the ones above.

| Layer | Folders in `src/` | What lives there |
| --- | --- | --- |
| **apps** | `cli/`, `bin/` | The `dacs` command-line tool. |
| **api** | `commerce/`, `agent/Agent.ts`, `agent/index.ts`, `index.ts` | The entry points users call: the fixed-price coordinators and `createAgent`. |
| **adapters** | `filesystem/`, `substrate/` (except the port), `wire/`, every `*Fs.ts` file | Code that touches disk, the Demos network or HTTP: file-backed stores, the Demos adapter, the seller HTTP wire format. |
| **protocol** | `identity/`, `discovery/`, `negotiate/`, `rails/`, `registry/`, `agent/`, `seller/` | The rules of each step: vetting, negotiation, payment on each rail, delivery, bundles and reputation. |
| **ports** | `substrate/SubstrateAdapter.ts` | Interfaces the protocol code calls and the adapters implement. |
| **model** | `artifacts/` | The DACS records: their types, validators and signatures. |
| **kernel** | `errors.ts`, `version.ts`, `internal/`, `canonical/`, `crypto/` | Errors, canonical JSON and hashing, decimals, signing, and small shared helpers. |

Inside a layer, the folders also have a fixed order, so that two folders never depend on each other. The full order, lowest first, is in [`tools/lint/layers.json`](./tools/lint/layers.json). For example, inside **protocol** the order is `identity`, `discovery`, `negotiate`, `rails`, `registry`, `agent`, `seller`: `rails` may import `negotiate`, but `negotiate` may not import `rails`.

The workspace packages under `packages/` sit on top of all of this. They import the SDK by its package name (`@kynesyslabs/dacs` and its subpaths), never by a path into `src/`.

## Why it is layered this way

- **Each part can be read on its own.** Protocol code can be understood without knowing how files are written or how the network is reached.
- **Tests stay small.** The lower a piece of code sits, the less it needs set up around it to be tested.
- **There are no circular imports.** A circle between two folders means neither can change without the other.

## The check

`tools/lint/layers.mjs` reads every import in `src/`, works out which part of the order each file belongs to, and fails when an import points up the order. It counts plain imports, `import type`, `export … from`, dynamic `import()` and `import("…")` types. A type-only import still ties two parts together, so it follows the same rule.

Run it from the repository root after installing the linter's dependencies:

```bash
npm ci --prefix tools/lint --ignore-scripts
node tools/lint/layers.mjs
```

CI runs it in the `lint` workflow.

It also fails when:
- a file in `src/` is not covered by any entry in `layers.json`; add the new folder or file to the order;
- an import names a file that does not exist.

### Imports that already broke the rule

[`tools/lint/layers-baseline.txt`](./tools/lint/layers-baseline.txt) lists the imports that broke the order when the check was added, one `from -> to` pair per line. They do not fail the run. Most are a file that sits in the wrong folder, such as a small helper in `agent/` that `rails/` also needs.

The list only shrinks:
- When an import on the list is removed, the check fails until the line is removed too. `node tools/lint/layers.mjs --prune` removes every line that no longer occurs.
- Never add a line to get a pass. Fix the import instead.

`--write-baseline` rewrites the whole list from the code. Use it only in a change that edits `layers.json` itself, and say why in that change.

## When the check fails

The usual fixes, best first:

1. **Move the code down.** If a lower part needs something from a higher one, the thing is probably in the wrong place. Move it to the lowest part that all its users can reach, and import it from there.
2. **Pass it in.** If lower code needs to call higher code, define an interface in the lower part and let the caller pass an implementation in. This is how protocol code reaches the network today: it calls a `SubstrateAdapter`, and the Demos adapter implements it.
3. **Change the order.** If two parts are in the wrong order, change `layers.json` in its own change, explain why, and rewrite the baseline with it.
