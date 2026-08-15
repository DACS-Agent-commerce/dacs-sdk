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
intact directory. It never removes the intent, even when submission fails
ambiguously, and it records at most one outcome through the helper. On supported
POSIX filesystems it rejects relative paths, recognized operating-system
temporary roots, symlink components, unsafe owners and unsafe mode bits. It
synchronizes each marker file and the checked directory before continuing.

The intact directory is the local guard domain. The helper coordinates
cooperating processes that run as the same uid and use that exact ledger. It does
not defend against the directory owner or root deleting, replacing or editing
the ledger, and pathname checks cannot prove that a mounted volume, cache,
container layer or workspace will survive cleanup or host loss. Operators must
therefore provision and retain one durable private ledger outside disposable
workspaces and caches, protect it operationally, and use the same ledger for
every attempt on that host. Copying the checkout, selecting or
recreating a directory, or moving to another host does not carry history
automatically.

Never retry an ambiguous wallet/run-id combination elsewhere. Reconcile the
original transaction read-only first; any separately approved attempt needs new
wallets and a new run id. Marker outcomes are write-once only through this
helper, remain owner-editable files, and are diagnostics rather than settlement
or DACS proof.

All persisted inputs, including operation, run id and marker details, must be
public reconciliation facts. Never pass private keys, mnemonics, credentials,
tokens or wallet objects. The helper rejects common secret-shaped detail keys,
but cannot determine whether an arbitrary string is sensitive. The generic
helper validates storage shape, not payment-rail semantics: each funded suite
must separately require and validate its amount, total-debit cap, identities and
outcome-specific reconciliation fields before calling it.
