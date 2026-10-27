# Private buyer client snapshot

This PR is an isolated development snapshot. It is **not launch-ready**. The package is private, its exports are empty, and purchase actions remain held.

Live wiring requires a real D11 PurchaseStore with synchronous, re-entrant, serializing transactions and the destination regressions rerun against it; approved immutable DEC-16 testnet identity admission before effects; independent programme review; and coordinated Standard release and trusted profile admission. The buyer store tests run against the package's concrete SQLite adapter; they cover the package store only and do not satisfy those prerequisites.

After `npm ci --no-audit` and `npm run build` at the SDK root, run `npm test --workspace @kynesyslabs/dacs-client`. Every executable package test is discovered, run one file at a time, and reported with its registered test count. Separately supplied source-repository acceptance tests report explicit skips when unavailable. Historical copied tests requiring missing application components are labelled text evidence under `evidence/source-tests/`, outside executable discovery; their historical pass counts establish no current coverage.

The hold gate pins only this package. Unrelated SDK files and later main/PR commits need no client re-pin. The gate establishes package integrity, not the absence of external callers. Client changes still require reviewed reciprocal hold/gate pins and provenance records.

The SDK raw JSON default remains 1 MiB. The explicit maximum supports bounded 4 MiB RPC reads and configured Directory reads up to 10,000,000 bytes; streaming and exact-byte admission use the same validated bound. The root `demosTransactionContentMatches` export is used by both the native transport and SR-2 adapter to compare signed and executed content.
