# Funded E2E safety boundary

The funded x402 and pay-DEM suites are disabled by default. They are operational
boundary tests, not conformance fixtures, and a successful marker outcome is a
diagnostic observation rather than independent proof of settlement or DACS
completion.

Every funded attempt must use all of the following:

- fresh, dedicated payer and payee wallets;
- a new operator-approved run id;
- an explicit amount and maximum-total-debit cap checked before broadcast;
- a pre-existing marker directory on persistent local storage, owned by the
  process uid with mode `0700`; and
- an explicit live-test confirmation flag.

The shared `funded-run-marker` helper durably creates an exclusive intent before
the first irreversible call. Its identity is the operation/run-id pair, so
changing wallets, amounts, or other details cannot bypass a residue in the same
directory. It never removes the intent, even when submission fails ambiguously,
and it records at most one outcome. It refuses relative, temporary, symlinked,
non-private, or replaceable marker paths and synchronizes both marker files and
the pinned directory before continuing.

The directory is the local guard domain. Copying the checkout, selecting a new
directory, or moving to another host does not carry its history automatically.
Operators must therefore keep one durable private ledger per execution host and
must never retry an ambiguous wallet/run-id combination elsewhere. Reconcile the
original transaction read-only first; any separately approved attempt needs new
wallets and a new run id.

Marker details are public reconciliation facts only. Never pass private keys,
mnemonics, credentials, tokens, or wallet objects. The helper rejects common
secret-shaped field names, but cannot determine whether an arbitrary string is
sensitive.
