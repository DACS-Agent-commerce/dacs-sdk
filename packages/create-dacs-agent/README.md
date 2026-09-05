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

The generator also emits an authority-separated experimental live bootstrap.
Choose `x402`, native `pay-dem`, or `both`; dual-rail listings remain separate
signed offers and each purchase pins one exact rail:

```bash
npm create dacs-agent@latest my-agent -- \
  --yes --mode live-demos \
  --profile dacs-sdk:fixed-price-x402:v1 \
  --rails both \
  --role seller \
  --deploy docker
```

`dacs-sdk:fixed-price-x402:v1` is retained as the compatibility identifier for
the current fixed-price live runtime even when `--rails pay-dem` is selected.
DEM-only projects omit the EVM key, EVM RPC, x402 packages and x402 secret
mounts. Dual projects generate rail-specific listing drafts and require an
explicit `--rail x402` or `--rail pay-dem` for guarded setup and purchase.

Live generation runs the complete read-only pre-start doctor after install.
Exit 5 is retained as a successful, visibly blocked bootstrap when credentials,
funding, signed registries, endpoints or reviewed effect adapters are absent.
It does not start services, publish or pay. Generated Docker services use the
same reviewed host image with separate non-root buyer/seller processes, secret
mounts and data volumes; the template contains only configuration, command
wiring and the seller fulfilment callback.

The live bootstrap currently supervises buyer and seller services. Its
`--role` default is therefore restricted to `buyer` or `seller`; the generated
read-only verifier placeholder is not exposed as a runnable live role until a
real independent verifier service is implemented. Offline mode still runs its
logical verifier simulation and labels it non-conformant.

The generated live project also provides guarded operator commands:

```bash
npm run dacs:doctor -- --phase pre-start --for start --explain
npm run dacs:status
npm run dacs:metrics -- --job <printed-job-id>
npm run dacs:backup -- --output ../backups/agent-YYYYMMDD
npm run dacs:restore -- --from ../backups/agent-YYYYMMDD \
  --backup-id <printed-backup-id> \
  --safety-backup ../backups/pre-restore-YYYYMMDD
npm run dacs:uninstall -- --backup ../backups/final-YYYYMMDD
```

Backup manifests are HMAC-authenticated by a separate operator key, contain
independent buyer/seller trees, and are rehashed before restore. Restore checks
the Standard, configuration and SQLite migration compatibility, requires its
own ephemeral confirmation, creates a safety backup, and rolls both role trees
back on a partial replacement. Uninstall is deliberately a non-destructive
decommission: it stops the deployment and backs it up but retains the actor
data and project.

Operational event journals are private, durable and capped. `dacs:metrics`
projects seller-ready, buyer-received, commerce-complete and two-role
audit-complete timing without presenting the journal as normative DACS proof.
The default fulfilment and static-JSON example are deterministic and
replay-safe; external jobs require a separately reviewed durable
idempotency/reconciliation adapter.

Runs use fresh job and presentation identifiers, but the simulation has neither
the durable CORE §B.8 nonce ledger nor the DACS-4 §9.4.4 RAV-R5 rail authority
required by a conformant session.

Each invocation selects a CSPRNG-named run directory. The host runner stages
the complete result privately and atomically publishes it, so concurrent runs
cannot share or expose a partially written output tree.

The generator does not fabricate a dependency lock from unpublished packages.
Its normal registry-backed install creates a valid lock; `--no-install` emits
no lock and leaves dependency resolution to the operator. Before building the
Docker profile after `--no-install`, run
`npm install --ignore-scripts --omit=optional && npm rebuild better-sqlite3`;
the Dockerfile requires that registry-created lock and uses `npm ci`.

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
scripts globally, omits unused optional dependency trees, and then explicitly
rebuilds only the reviewed `better-sqlite3` host adapter. Compiled live services
use the host package's exact Demos ESM compatibility loader and do not install a
general TypeScript/esbuild production transformer.

Live services remain blocked until the lower Demos identity/registry and x402
effect-adapter stack is installed and passes the generated doctor. This package
does not turn missing production adapters into local substitutes.
