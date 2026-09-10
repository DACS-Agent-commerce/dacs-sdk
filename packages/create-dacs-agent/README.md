# `create-dacs-agent`

Project generator for the DACS one-click quickstart.

The default remains the single-process offline verifier simulation:

```bash
npm create dacs-agent@latest my-agent -- --yes --run
```

It generates a small application that calls the reviewed
`@kynesyslabs/dacs-node` simulation. The mocked payment, provider authority,
substrate anchors and finality are visibly non-normative; the project does not
claim DACS conformance, commercial success, x402, Demos settlement, live
readiness or real funds.

The generator also emits an authority-separated experimental live bootstrap:

```bash
npm create dacs-agent@latest my-agent -- \
  --yes --mode live-demos \
  --profile dacs-sdk:fixed-price-x402:v1 \
  --deploy docker
```

Live generation runs the complete read-only pre-start doctor after install.
Exit 5 is retained as a successful, visibly blocked bootstrap when credentials,
funding, signed registries, endpoints or reviewed effect adapters are absent.
It does not start services, publish or pay. Generated Docker services use the
same reviewed host image with separate non-root buyer/seller processes, secret
mounts and data volumes; the template contains only configuration, command
wiring and the seller fulfilment callback.

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
the non-root runtime stage. Live installation disables dependency lifecycle
scripts globally and then explicitly rebuilds only the reviewed
`better-sqlite3` host adapter.

Live services remain blocked until the lower Demos identity/registry and x402
effect-adapter stack is installed and passes the generated doctor. This package
does not turn missing production adapters into local substitutes.
