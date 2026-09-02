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

The pay-DEM runner has one additional write-ahead boundary. After the SDK has
signed and confirmed the transfer and validated its body, denomination fork,
fees and maximum debit, it synchronously records a write-once preparation
checkpoint before invoking broadcast. The checkpoint is limited to public
reconciliation facts: canonical transaction hash, nonce, payer, payee, OS
amount, maximum OS debit and network. If this write or its directory sync fails,
broadcast is not invoked.

There are two deliberately equivalent crash windows:

1. the preparation checkpoint is durable and the process stops before calling
   broadcast; and
2. broadcast starts or lands but its response remains pending/ambiguous and the
   process stops.

On restart the durable records cannot safely distinguish those windows. Both
therefore fail closed: keep the original intent armed, observe only the recorded
hash/nonce, and require operator reconciliation. Never reconstruct, re-sign or
resubmit the transfer under that wallet/run id. The checkpoint intentionally
does not persist the signed validity body, so a hash and nonce are recovery
coordinates, not an exact-resubmission capability.

The test-only `reopenPayDemFundedRun` helper authenticates the retained intent
from the original public input and returns these read-only coordinates after a
restart; it never invokes a rail.

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

For normal, non-funded use, `createPayDemRail`'s
`journalPreparedTransfer` hook is optional. Omitting it does not make an
individual call retry; the rail still submits once and observes inclusion by its
precomputed canonical hash. It does mean the low-level rail has no durable
hash/nonce recovery record after process loss. Cross-process at-most-once use
must wrap it with `payDemSettle` and a durable `SettlementIdempotencyStore`, and
read-only reconciliation needs an application-owned durable journal or
equivalent rail record. The default settlement store is process-local.
The `settleFromRail` convenience path exposes these dependencies through its
`payDem` options. Calls made through `payDemSettle` also attach the exact rail,
job, phase index, derived settlement key, network, payer, payee and OS amount to
the prepared-transfer checkpoint. Operators must authenticate that complete
tuple in the same durable authority as the settlement intent before using it for
recovery. The reconciliation callback receives that immutable tuple and repeats
the chain-observed OS amount in its result; a missing, non-final or contradictory
observation must throw. After restart, even a cached success is reconciled before
reuse. Only an authoritative `null` proof for the exact tuple may authorize one
new submission under a held intent; non-observation or an ambiguous transaction
must never do so.

Hash-first observation has a finite wait even when the Demos native client's
broadcast promise or a status call never settles. A pending JavaScript promise
alone does not keep Node alive, but the current fetch calls do not attach an
AbortSignal deadline. An active socket may outlive the SDK result and keep the
process open. The operator may terminate that process after preserving the
durable records; termination never authorizes a rerun. One SDK broadcast call
may contain bounded transport or HTTP 502/503/504 retries of the same signed
transaction. Those attempts retain one hash and nonce; the DACS rail does not
invoke broadcast again after ambiguity.

All persisted inputs, including operation, run id and marker details, must be
public reconciliation facts. Never pass private keys, mnemonics, credentials,
tokens or wallet objects. The helper rejects common secret-shaped detail keys,
but cannot determine whether an arbitrary string is sensitive. The generic
helper validates storage shape, not payment-rail semantics: each funded suite
must separately require and validate its amount, total-debit cap, identities and
outcome-specific reconciliation fields before calling it.
