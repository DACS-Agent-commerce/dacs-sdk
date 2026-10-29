# Private buyer client snapshot

This PR is an isolated development snapshot. It is **not launch-ready**. The package is private, its exports are empty, and purchase actions remain held.

Live wiring requires a real D11 PurchaseStore with synchronous, re-entrant, serializing transactions and the destination regressions rerun against it; approved immutable DEC-16 testnet identity admission before effects; independent programme review; and coordinated Standard release and trusted profile admission. The buyer store tests run against the package's concrete SQLite adapter; they cover the package store only and do not satisfy those prerequisites.

After `npm ci --no-audit` and `npm run build` at the SDK root, run `npm test --workspace @kynesyslabs/dacs-client`. Every executable package test is discovered, run one file at a time, and reported with its registered test count. Separately supplied source-repository acceptance tests report explicit skips when unavailable. Historical copied tests requiring missing application components are labelled text evidence under `evidence/source-tests/`, outside executable discovery; their historical pass counts establish no current coverage.

The hold gate pins only this package. Unrelated SDK files and later main/PR commits need no client re-pin. The gate establishes package integrity, not the absence of external callers. Client changes still require reviewed reciprocal hold/gate pins and provenance records.

The SDK raw JSON default remains 1 MiB. The explicit maximum supports bounded 4 MiB RPC reads and configured Directory reads up to 10,000,000 bytes; streaming and exact-byte admission use the same validated bound. The root `demosTransactionContentMatches` export is used by both the native transport and SR-2 adapter to compare signed and executed content.

Portal entries require a nonempty primitive operation id (at most 256 characters) and handoff token (at most 1024). They authenticate the stored purchase capability before the host lookup or private reads: exact token bytes hashed as SHA-256 of `dacs-handoff-hash:` followed by the token, constant-time comparison with its lowercase hex hash, matching id/kind/owner, and a canonical `Date.toISOString()` lifetime later than both the business clock and internal wall clock. Both clocks must be valid nonnegative integer epoch milliseconds; the host may further refuse access.

Before constructing the service, migrate older databases with `ALTER TABLE operations ADD COLUMN handoff_expires_at TEXT` and provision explicit finite lifetimes. Missing columns produce `schema_migration_required`; null, malformed or past lifetimes grant no access, including links returned by status. Capability expiry is independent of approval `expires_at`.

Migrate evidence callers from `portalEvidence(operation)` to `portalEvidence(operationId, token)`. Evidence and status project approval expiry without writes; `portalOperation` retains the action-side expiry transition. The retained protocol readback exception authenticates the same capability first. Package exports remain empty and purchase actions remain held.
