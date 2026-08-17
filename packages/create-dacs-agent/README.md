# `create-dacs-agent`

Project generator for the DACS one-click quickstart.

The first stacked work package supports only a single-process offline verifier
simulation:

```bash
npm create dacs-agent@latest my-agent -- --yes --run
```

It generates a small application that calls the reviewed
`@kynesyslabs/dacs-node` simulation. The mocked payment, provider authority,
substrate anchors and finality are visibly non-normative; the project does not
claim DACS conformance, commercial success, x402, Demos settlement, live
readiness or real funds. Independent buyer/seller/verifier role services are
not selectable until they exist.

Runs use fresh job and presentation identifiers, but the simulation has neither
the durable CORE §B.8 nonce ledger nor the DACS-4 §9.4.4 RAV-R5 rail authority
required by a conformant session.

Each invocation selects a CSPRNG-named run directory. The host runner stages
the complete result privately and atomically publishes it, so concurrent runs
cannot share or expose a partially written output tree.

The generator does not fabricate a dependency lock from unpublished packages.
Its normal registry-backed install creates a valid lock; `--no-install` emits
no lock and leaves dependency resolution to the operator. Before building the
Docker profile after `--no-install`, run `npm install --ignore-scripts`; the
Dockerfile requires that registry-created lock and uses `npm ci`.

The project target's parent directory must already exist. The generator writes
the complete project into a private sibling staging directory and atomically
publishes it, so nested symlinks cannot redirect individual template writes and
concurrent generators cannot expose a partial project. The parent is a trusted
cooperative boundary: on POSIX, the final rename may replace an empty target
directory created concurrently, but never merges with or traverses it; a
non-empty target fails. Docker output uses a deny-by-default `.dockerignore`,
copies only explicit build inputs, installs from the generated lock, and places
only compiled output, package manifests and pruned production dependencies in
the non-root runtime stage.

Live generation fails closed until the durable host, doctor and guarded command
work packages have landed and passed their acceptance tests.
