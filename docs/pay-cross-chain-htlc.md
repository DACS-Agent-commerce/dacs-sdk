# Cross-chain HTLC settlement safety core

The SDK exposes a chain-neutral `pay-cross-chain-htlc` producer core for
DACS-4 §9.5.4. It coordinates authenticated chain adapters but never needs a
payer or payee private key. An adapter can dispatch each effect to a separate
role-local signer.

The core implements the normative HTLC lifecycle:

- a unique buyer salt with at least 128 bits of entropy;
- RFC 5869 HKDF-SHA256 preimage derivation using the exact `jobId` and
  `agreementHash` inputs;
- separate chain-native hashlocks derived from the same preimage;
- exact amount conversion for each chain's token decimals;
- source/destination timelock and actual-expiry asymmetry checks;
- an authority-bound `destinationFinalitySec` budget that is included in the
  canonical intent and enforced before destination-claim preparation and
  broadcast;
- payer source lock, then payee destination lock only after source finality;
- an immutable authenticated source-finality checkpoint persisted before the
  destination lock is prepared and bound into that prepared action;
- payer destination claim/reveal, then payee source claim;
- durable signed effects recorded before any broadcast and generation-fenced
  across worker takeover;
- byte-identical retained-effect rebroadcast after ambiguity or restart;
- generation-fenced replacement of a source claim or reveal authenticated as
  `failed` or `absent`, at most three per session, with an immutable attempt
  history and no release of old effect/transaction reservations;
- benign two-leg refunds only before a final reveal; and
- a durable reveal checkpoint that permanently blocks source refund and emits
  `dest-revealed-source-unclaimed` ST-8 recovery state until source-claim
  finality or expiry.

```ts
import {
  advanceCrossChainHtlc,
  type CrossChainHtlcAdapter,
  type CrossChainHtlcStore,
} from "@kynesyslabs/dacs/rails";

const result = await advanceCrossChainHtlc({
  authority,
  buyerSalt,
  hashlocks: chainNativeHashlockDeriver,
  authorizeDestinationClaim: payerAcceptedMarketRisk,
  owner: workerId,
  adapter: roleSeparatedChainAdapter satisfies CrossChainHtlcAdapter,
  store: encryptedDurableStore satisfies CrossChainHtlcStore,
});
```

Restart safety rests on the store: the core is restart-safe only over a
durable, atomic, encrypted host store that implements the contract below and
survives the process. This package does not ship one. The exported
`createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true })` loses every
secret, signed action and checkpoint on restart, after which the core would
prepare and broadcast a second source lock; without that option it throws a
`TypeError`. Use it only in tests and development.

`authorizeDestinationClaim` preserves HTLC-10's payer free option: the core
does not reveal merely because both locks exist. Once the destination claim is
final, the preimage is public and the source refund path is forbidden. If the
payee's source claim is not yet final, the result is `settle-asymmetric`, not a
refund or terminal ordinary failure. If the source expiry passes without that
claim, the result is `operator-alert` with reason
`htlc-source-claim-missed-after-reveal` (see Operator alerts).

The selected authority must provide a positive safe-integer
`destinationFinalitySec`. For actual lock expiries, the last permissible reveal
instant is the earlier of:

- `destinationExpiry - destinationFinalitySec`; and
- `sourceExpiry - sourceFinalitySec - safetyWindowSec`.

Both deadlines are evaluated with overflow-safe millisecond arithmetic. The
cutoff itself is exclusive: one millisecond before it can reveal, while at or
after it the core returns `htlc-destination-claim-cutoff-reached` without
preparing or broadcasting a new reveal. A retained destination-claim is treated
as potentially exposed after restart; a pending reveal attempt never becomes a
refund. A retained reveal the adapter authenticates as `absent` or `failed`
can never land, so its bytes are not rebroadcast: it is replaced while the
claim window is open, and otherwise raises an `operator-alert` (see below).
Only once both the destination and the source expiry have passed, so
the payee can no longer claim the source leg, and the adapter authenticates the
retained claim as `absent` or `failed`, the core refunds both legs with reason
`destination-claim-unlanded`. A claim the adapter does not report at all is
not authenticated and keeps blocking refunds. Adapters must therefore report
`pending`, never `absent`, while a reveal can still land. Past the claim
cutoff nothing more is sent for a retained reveal, but one that is still
`pending` or unreported may still land and its preimage may be in a mempool:
until both expiries have passed it returns `waiting` with reason
`htlc-destination-claim-unresolved-after-cutoff`, so that a person can still
help it land before the destination expiry, and afterwards it stays blocking
with reason `htlc-destination-claim-unresolved-after-expiry`. Hosts page on
both. A destination claim that is already final is still authenticated,
checkpointed, and recovered after the cutoff.

A reveal is only ever prepared against a final destination lock. If the
destination-lock observation later regresses while a retained reveal is not
yet final (omitted, `pending` or `absent`), the core returns `indeterminate`
with reason `htlc-destination-lock-finality-regressed` and prepares,
broadcasts and refunds nothing until the adapter reports the lock final again:
the reveal may still land, and refunding the source then would give the payer
both legs. Once the reveal itself is final, the destination-lock observation
no longer matters, because a contract may delete the lock's record when the
reveal claims it. The core records the reveal checkpoint with the source
expiry of the retained source-finality checkpoint and drives the payee's
source claim exactly as when the lock still reads final, under the same
source-expiry cutoff; settlements, `settle-asymmetric` progress and
checkpoint-path operator alerts name the retained destination-lock reference.
Neither leg is ever refunded on this path, and a source claim that
misses the source expiry is the usual `operator-alert`
`htlc-source-claim-missed-after-reveal`.

Refunds are per leg. After the destination expiry the payee's destination
refund is driven; after the source expiry the payer's source refund is driven
in the same call, even if the destination refund cannot be prepared, broadcast
or observed. When the final destination lock's expiry breaks the absolute
margin (`sourceExpiry` must exceed `destinationExpiry + sourceFinalitySec +
safetyWindowSec`) or its terms do not match the intent, the payer never reveals:
the result is `refund-pending` with reason
`destination-expiry-margin-insufficient` or `destination-lock-terms-mismatch`
from that point on, and each leg is refunded at its own expiry. Callers keep
advancing a `refund-pending` session until it is `refunded`.

The payer's source refund never depends on the destination lock's expiry
being usable. The payee's role signs the destination lock, so its expiry is
the payee's choice. A final destination lock whose integer `expiresAt` overflows the
safe-integer range when converted to milliseconds, or lies at or before the
lock's own `includedAt`, is unusable: the payer never reveals against it, and
the result is `refund-pending` with reason `destination-lock-expiry-invalid`.
The source leg is refunded at the source expiry. The payee's destination leg
is refunded at its expiry when that expiry is in range. An expiry beyond the
top of the range never arrives for the core, so that leg stays `waiting` and
the session stays `refund-pending` after the payer's own refund is final; one
below the bottom of the range has long passed, so that leg is refunded at
once.

The core never returns `failed` while a locked leg still needs a refund or
claim that it will drive later. Before the destination lock exists, a failed
destination lock is `refund-pending` with reason `destination-lock-failed`,
and a destination lock that can no longer be placed with the absolute margin
is `refund-pending` with reason `destination-lock-window-closed`; the source
leg is refunded at its expiry (reason `destination-lock-missing` when no
destination lock was prepared or it is authenticated `absent`). When the
source lock's terms ruled out the destination lock, its
`source-lock-terms-missing` or `source-lock-terms-mismatch` reason is kept
through the source refund.

A retained destination lock that the adapter has not authenticated as
`failed` or `absent` may still land, whether it is reported `pending` or not
reported at all (anyone who saw its signed bytes can rebroadcast them). Such a
session is never `refunded`: after the source refund it stays
`refund-pending` with reason `destination-lock-unresolved`, its reference in
`txRefs` and its `destination-refund` leg `waiting`. The core keeps observing;
if the lock lands it becomes final and its refund is driven after the
destination expiry like any other. Adapters must therefore report `pending`,
never `absent`, while a destination lock can still land, exactly as for a
reveal.

A reveal that reverts on chain (out of gas, a fee spike, a token hook) still
publishes the preimage: on EVM and Solana the failed transaction's calldata is
on chain. From then on the payee can claim the source leg, so the payer must
claim the destination before its expiry or lose the source amount. A reveal
the adapter authenticates as `absent` (for example a Solana transaction whose
recent blockhash expired, or an EVM transaction whose nonce was reused) never
reached the chain, but it was broadcast, so the mempool may have seen the
preimage; its bytes can never land, so rebroadcasting them cannot help. When
the adapter authenticates the active reveal as `failed`, or as `absent` naming
it, the core therefore replaces it while the destination-claim window is still open (the
same cutoff as a first reveal) and the absolute margin holds: it asks the
adapter for a fresh signed reveal of the same preimage into the same
destination lock, persists it with the store's
`replacePreparedDestinationClaim` compare-and-swap, and only then broadcasts
it. A replacement costs the payer nothing, because the preimage is already
out, so the payer's `authorizeDestinationClaim` decision gates only the first
reveal. Each session allows at most three replacements. A failed or absent
reveal is never reported as a routine `refund-pending` or `waiting`. When no
replacement is allowed (the claim window has closed, the margin is gone, the
cap is reached, or the adapter refuses to prepare one) the result is
`operator-alert` with reason `htlc-destination-claim-failed-preimage-public`
when any attempt failed on chain, or
`htlc-destination-claim-absent-preimage-broadcast` when every attempt was
authenticated absent, and a host must page an operator at once (see Operator
alerts). Once both expiries have passed and
the adapter authenticates the active reveal as `failed` or `absent`, both legs
are refunded per leg with reason `destination-claim-unlanded`; if the payee
already claimed the source with the published preimage, the source refund
reverts and the session is `refund-stalled`.

Every refund result carries `refunds`, the state of each locked leg's refund
(`destination-refund` appears once the destination lock is final, or while a
retained destination lock may still land): `waiting` (its lock has not
expired, a retained reveal still blocks it, or its lock is not final yet),
`uncertain` (due, but this call could not prepare, persist, broadcast or
observe it; the next call reuses the retained bytes), the adapter's
authenticated `pending`, `final` or `failed`, or `absent` (below). A refund
broadcast in this call reads `pending` until a later call observes it, even if
this call's observation still reports it `absent`. A payer whose own refund is final can see it
even while the payee's leg is still uncertain. The core never re-sends a
refund the adapter reports `failed`, so such a session returns the distinct
status `refund-stalled`, naming the failed leg in `refunds`; it still drives
the other leg. A host must alert an operator on `refund-stalled`, for example
when a refund broadcast against a clock running ahead of the chain reverted as
not yet expired, and keep advancing the session.

A retained refund the adapter authenticates as `absent` never reached the
chain and can no longer, so its bytes are not re-sent either, and the core
does not yet replace refunds. That leg is reported as `absent` in `refunds`,
and the result is `operator-alert` with reason `htlc-refund-absent`, which
carries the same `refunds` map. The other leg is still driven in the same
call. The same holds while a checkpointed source lock has regressed (see
below): a retained refund authenticated `absent` or `failed` is never re-sent
there either, and the result is `htlc-refund-absent` or `refund-stalled`.

## Operator alerts

`operator-alert` means the core cannot safely drive the session further on
its own and a person must act. It carries a `reason` and the session's
current `txRefs`; `htlc-refund-absent` also carries `refunds`. It is
resumable, not terminal: a host pages an operator and keeps advancing the
session, and a later call re-observes the chain and returns to normal progress
if the chain has changed. The reasons are:

- `htlc-source-claim-missed-after-reveal`: the payer's reveal is final, so
  the payer holds the destination funds, but the payee's source claim did not
  reach the chain before the source expiry. The source lock stays in the
  contract; the core never refunds it, because a refund would give the payer
  both legs. The operator checks whether a source claim is still pending (if
  it reaches finality before the expiry the next call settles), and otherwise
  arranges the payee's payment outside the core, for example by having the
  payer refund the source and pay the payee under the agreement.
- `htlc-destination-claim-failed-preimage-public`: a reveal failed on chain,
  so the preimage is public, and the core cannot send another one: the
  destination-claim window has closed, the absolute margin is gone, three
  replacements have already failed, or the adapter would not prepare a
  replacement. The payee can claim the source leg with the public preimage
  until the source expiry. Page at once: while the destination lock has not
  expired, the operator tries to land a reveal by hand (or fixes the adapter
  so that the next call replaces it); otherwise the operator reconciles the
  legs with the parties. Both legs are refunded automatically once both
  expiries pass, and `refund-stalled` then shows a source refund that reverted
  because the payee had claimed the source.
- `htlc-destination-claim-absent-preimage-broadcast`: as above, but every
  reveal was authenticated `absent`: none reached the chain, yet each was
  broadcast, so the preimage may be known to anyone who saw the mempool. Page
  at once and act as for `htlc-destination-claim-failed-preimage-public`.
- `htlc-source-claim-replacement-limit-reached`: the payer's reveal is final,
  and the payee's source claim has been replaced three times and failed or
  was absent again. The core prepares no further fee-paying claims. The
  operator finds out why the claim cannot land (a paused contract, or a lock
  already claimed outside the core) before the source expiry; past it the
  reason becomes `htlc-source-claim-missed-after-reveal`.
- `htlc-refund-absent`: a retained refund is authenticated `absent` and the
  core will not re-send it; `refunds` shows that leg as `absent`. The operator
  lands a refund for that leg by hand. Refund replacement is not implemented
  yet.

`failed` is returned only when the core has nothing it can drive: the inputs
or authority are invalid; the store is corrupt, conflicting or lacks a
required method; retained evidence and a new observation contradict each
other (a changed source-lock checkpoint fact, a reveal checkpoint for another
transaction, a final reveal of another or a malformed preimage, a final source
claim without a final source lock or without a final or checkpointed reveal,
or a final source claim while the checkpointed reveal is reported `pending`,
`failed` or `absent`, `htlc-reveal-checkpoint-contradicted`);
the source lock itself failed, so
nothing was locked; or the source claim is final but reached finality after
the source expiry (`settlement-atomicity`). These need an operator to
reconcile the record, not a retry. Every other non-final state is
`waiting`, `indeterminate`, `settle-asymmetric`, a refund status or
`operator-alert`, and a host keeps advancing the session.

The authority binds each leg's token by its chain-native identifier,
`sourceTokenId` and `destinationTokenId` (the token contract address, or the
chain's asset id or mint), into the canonical intent. `sourceAsset` and
`destinationAsset` are only the currency symbol, which cannot tell two tokens
on a multi-token HTLC contract apart.

Final `source-lock` and `destination-lock` observations carry `lockTerms`: the
locked `token`, `amountBaseUnits` (canonical decimal), chain-native
`hashlock`, `sender` and `recipient`, read from that contract's lock record
and reported in the same form as the intent. `token` must be the token
actually locked, read from the lock record; for a single-token contract it is
the contract's configured token, never a value copied from the intent. The
core consults the terms only at the two forward decisions that depend on them:

- before the destination lock is prepared or its retained bytes rebroadcast,
  the source lock's terms must equal `sourceTokenId`, `sourceAmountBaseUnits`,
  `sourceHashlock`, `payerSourceAddress` and `payeeSourceAddress`. Otherwise
  the destination is never locked and the result is `refund-pending` with
  reason `source-lock-terms-missing` or `source-lock-terms-mismatch`; the
  source leg is refunded at its expiry;
- before the payer reveals, the destination lock's terms must equal
  `destinationTokenId`, `destinationAmountBaseUnits`, `destinationHashlock`,
  `payeeDestinationAddress` and `payerDestinationAddress`. Otherwise the payer
  never reveals and the result is `refund-pending` with reason
  `destination-lock-terms-missing` or `destination-lock-terms-mismatch`; each
  leg is refunded at its own expiry.

Missing terms never make an observation unavailable, so refunds and the
payee's source claim never wait on them. Once a reveal is retained the core
never consults the destination lock's terms again: the reveal was prepared
against matching terms and may already have exposed the preimage, so after an
ambiguous broadcast or a restart its exact retained bytes are rebroadcast even
if the terms now read as missing or different. Only the absolute expiry margin
and the destination-claim cutoff still gate that rebroadcast. Once a reveal
checkpoint exists the core never consults terms at all: a contract may delete
or rewrite its lock record after the reveal. Terms that are present but malformed still make the
observation invalid, like any other malformed field. The refund reason
describes the current observation, so it can change while refunds proceed (for
example to `destination-timeout` once a refunded lock's terms can no longer be
read). This is a public adapter contract addition.

The core compares token ids, addresses and hashlocks as exact strings, so the
authority, the hashlock deriver and the adapter must use one canonical form
per chain family. A different spelling of the same value is a mismatch: it
never moves funds forward, but it forbids the step and sends the session to
refunds. Use:

- EVM: `0x`-prefixed lowercase hexadecimal for addresses and token contracts
  (no EIP-55 checksum casing), and for a `bytes32` hashlock `0x` plus 64
  lowercase hex digits;
- Solana: the base58 string of the public key or mint, unchanged (it is
  case-sensitive);
- any other chain: the form its hashlock deriver returns and one documented
  address form. The adapter converts what the contract records into that form
  before reporting `lockTerms`.

The buyer salt is never passed to an adapter. The host must keep the original
buyer salt encrypted and durable until the session is terminal: settlement is
recorded, both legs are refunded, or the core returns a permanent `failed`.
Destination-claim finality is too early to discard it: every call to
`advanceCrossChainHtlc` rebuilds the intent from `buyerSalt`, and the binding
hash covers `buyerSaltHash`. Post-reveal source claims and replacements still
need the derived preimage. A missing or different salt fails closed before
any preparation or broadcast and prevents recovery. Because `operator-alert`
is resumable, an alert being retried is not final; retain the salt while the
host keeps advancing that session. Production stores must atomically
enforce cross-session salt uniqueness, authenticate retained signed payloads,
and persist both finality checkpoints. After the source lock becomes final, the
core calls `recordSourceFinality` with the exact source-lock transaction
reference and prepared-effect hash, its within-ledger inclusion/finality
timestamps and expiry, and the adapter's authentication hash. This
generation-fenced write must be immutable
and must complete before destination-lock preparation. The destination-lock
adapter receives the retained checkpoint and must set
`sourceFinalityCheckpointHash` to the value returned by
`crossChainHtlcSourceFinalityCheckpointHash`. `recordPrepared` must atomically
reject a destination lock when the checkpoint is absent or the binding does not
match. Claims and takeovers must return the checkpoint; the core validates the
retained binding before observing the ledger or revealing the preimage.

This checkpoint is the causal ordering proof between chains. Source and
destination timestamps belong to different ledger clock domains, so the core
does not numerically order a destination transaction's `includedAt` against the
source transaction's `finalityObservedAt`. Adapters must still provide coherent
within-ledger evidence: each lock's finality timestamp cannot precede its own
inclusion timestamp, and its expiry must be after its own inclusion. Valid
cross-chain clock skew therefore does not block settlement.

Stores must also implement
`replacePreparedSourceClaim` as a source-claim-only compare-and-swap. The CAS
binds the settlement and authority hash, current owner/generation, exact active
effect hash and transaction reference, the authenticated `failed` or `absent`
observation (an `absent` one carries the active attempt's reference), and a
fresh replacement. It requires a reveal checkpoint and an unexpired source
claim window, rejects a replacement once three are recorded, appends the
replaced attempt to `sourceClaimAttemptHistory`, keeps
all old effect/transaction reservations, and exposes only the replacement as
the active `prepared` source claim.

`replacePreparedDestinationClaim` is the same compare-and-swap for a failed or
absent reveal. It swaps only while the stored `destination-claim` is still the
one named by `priorEffectHash` and `priorTxRef`, and it rejects a replacement
after a reveal checkpoint or any prepared refund, after the source-recovery
cutoff of the retained source-finality checkpoint, or once three replacements
are recorded. It appends the failed attempt to
`destinationClaimAttemptHistory`, which `claim` must return, keeps all old
reservations, and exposes only the replacement as the active `prepared`
reveal. An earlier attempt can still land, so the checkpoint passed to
`recordRevealFinal` may name the active reveal or any attempt in that history,
and the store must accept either. The core fails closed with
`htlc-destination-claim-replacement-store-unsupported` before any effect when
a runtime store lacks the method. `recordPrepared` remains immutable for every
ordinary action. The exported in-memory store is for tests and development
only and requires `{ acknowledgeVolatile: true }`.

When preparing a replacement of either claim, the adapter receives
`replacement` context with the new attempt number, prior effect
hash/reference, and failure authentication hash (`priorTxRef` is an
`htlc-claim` reference for a source claim and an `htlc-reveal` reference for a
reveal). It must use that context to create a different signed transaction. The
core rejects an unchanged effect or transaction reference, persists the new
attempt before broadcast, and reuses those exact retained bytes after an
ambiguous restart. Store implementations must return the complete immutable
history on claim/takeover; the core validates the history chain before any
ledger observation or effect.

The source expiry is also an exclusive broadcast boundary. The core rechecks it
around initial source-claim preparation, after persistence, around replacement
preparation, and again after the replacement CAS immediately before broadcast.
If expiry arrives after a replacement is committed, the replacement and its
audit history remain durable for reconciliation, but it is not broadcast at or
after the expiry.

`HtlcObservedAction.state: "final"` is an authenticated adapter assertion, not
an independently corroborated core observation. Each chain adapter owns the
confirmation-depth and irreversibility policy selected by the intent, including
reorg detection. It must return `pending` while reversal remains possible and
must never report `final` for a state it could later reverse.

The same holds for `absent` and `failed`. "Authenticated" here is the
adapter's promise: the core checks only that each `authenticationHash` is 64
lowercase hexadecimal characters and never verifies it against a chain or a
verifier. Every `final`, `failed` and `absent` state is therefore an adapter
claim, and refunds after both expiries rely on an adapter's `absent`. A
required verifier hook for observations is an open launch-gate-2 design
question for this rail; until then, the adapter audit below is the control.

`observe` reports each action only for the core's own transaction, the
retained prepared action's `txRef`, never a counterparty's or anyone else's
transaction against the same lock. In particular, a payee who claims the
source outside the core with a published preimage must not be reported under
`source-claim`. The core rejects an observation of a transaction it did not
prepare: the whole snapshot is unavailable, the result is `indeterminate`
with reason `htlc-ledger-observation-unavailable`, and nothing is replaced,
rebroadcast or refunded until the adapter reports correctly. When a claim has
replacement history, `observe` reports the active attempt, the one `claim`
returns in `prepared`: `pending` while it can still land, its final or failed
state once it has one, and `absent` only once it never reached the chain and
can no longer. The one exception is an earlier attempt that landed after all,
for example one reported `absent` too early: every attempt of a claim carries
the same preimage, so `observe` must then report that attempt `final`, and the
core accepts it exactly as the active one. For a reveal it checkpoints that
attempt and drives the payee's source claim; for a source claim it settles. A
failed earlier attempt says nothing about the active one, so only the active
attempt's `failed` or `absent` allows a replacement or, after both expiries,
refunds. A claim's `absent` must therefore name the attempt it is about in
`txRef`. One that names an earlier attempt, or none, is refused: nothing is
replaced, rebroadcast or refunded on it, the result is `indeterminate` with
reason `htlc-destination-claim-absent-unbound` or
`htlc-source-claim-absent-unbound`, and past the claim cutoff a retained
reveal reported that way pages like one that is unreported. An `absent` that
names a transaction the core did not prepare makes the whole snapshot
unavailable. An adapter that keeps reporting the earlier failure holds the
session at `operator-alert` and refunds nothing.

Once a lock is final, and in particular once the core has checkpointed the
source lock, the adapter must keep reporting it `final`, with its inclusion
and expiry, for the rest of the session: also after the lock is claimed or
refunded and even if the contract deletes its record. The claim or refund is
its terminal disposition and is reported on its own action; only `lockTerms`
may then be omitted. A checkpointed source lock that is no longer reported
final returns `indeterminate` with reason
`htlc-source-finality-checkpoint-without-final-lock`, and a destination lock
that regresses while a retained reveal is not yet final returns
`indeterminate` with reason `htlc-destination-lock-finality-regressed`. Both
are resumable: nothing moves the regressed leg, and the next call resumes once
the adapter reports the lock final again. A destination lock that regresses
after the reveal is final no longer waits: the reveal checkpoint and the
payee's source claim proceed from the retained source-finality checkpoint and
destination-lock reference, as described above, and nothing is refunded.
While the source lock has regressed and no reveal was ever
prepared, the preimage is still private, so the payee cannot claim the source
and the core still drives the payee's destination refund after its expiry,
exactly as on the refund path: it prepares one only when none is retained, and
it never re-sends a retained refund authenticated `absent` or `failed`. Such a
refund returns `operator-alert` `htlc-refund-absent` or `refund-stalled` on
this path too, instead of the regression's `indeterminate`. A
final lock observation that is malformed (missing or invalid inclusion or
expiry, or malformed terms) returns `indeterminate` with reason
`htlc-adapter-lock-observation-invalid` until the adapter reports it
correctly. The exception is a destination lock with an integer expiry that is
out of range or not after its inclusion: that is the payee's on-chain choice,
not an adapter fault, so the session takes the refund path with reason
`destination-lock-expiry-invalid` (see above). A reorg-capable
adapter therefore needs to keep observing through its required finality horizon
before allowing the core to checkpoint a reveal or report settlement.

A final `source-claim` observation must also provide `finalityReachedAt`: an
authenticated, chain-native Unix-millisecond timestamp for when the selected
source-chain finality condition was actually reached. This is distinct from
`finalityObservedAt`, the later wall-clock time at which the adapter observed
that condition. When `includedAt` is available, adapters must report
`includedAt <= finalityReachedAt <= finalityObservedAt`; without inclusion
evidence, `finalityReachedAt <= finalityObservedAt` still applies. The core
compares `finalityReachedAt`, not observation latency, with `expiry_source`, so
a claim that reached finality in-window can settle even when observed later. A
claim reaching finality after the expiry is a terminal settlement-atomicity
failure. Missing, malformed, or impossibly ordered timing proof fails closed.
Successful `CrossChainHtlcSettlement.settlementFinality` records both timestamps:
`finalityReachedAt` preserves the expiry decision and `finalityObservedAt`
remains the audit/evidence observation time. It also binds the exact
`sourceExpiry` used for that decision.

This is a public adapter contract addition. Existing adapters, including those
that durably cache authenticated observations, must retain and return both
timestamps for final source claims; they must derive `finalityReachedAt` from
the chain's selected confirmation/commitment proof and must not substitute the
poll time. `CrossChainHtlcStore` implementations do not synthesize or backfill
this adapter evidence; their settlement schema must persist both finality
timestamps plus the exact source expiry. `recordSettlement` must compare that
expiry with the immutable reveal checkpoint and reject a claim whose
`finalityReachedAt` is after it. Settled replay must revalidate the same bound;
legacy settlement rows without it fail closed rather than being upgraded from
observation time.

For a final destination claim, adapters should emit `revealedPreimageHex` in
canonical lowercase, unprefixed form. The core accepts that producer form plus
equivalent uppercase hexadecimal and an optional `0x`/`0X` prefix for
compatibility. It strictly requires exactly 64 hexadecimal digits after the
optional prefix, decodes them as 32 bytes, and compares those bytes to the
derived preimage. Whitespace, signs, odd or wrong lengths, and non-hexadecimal
characters are rejected rather than normalized.

The source-finality checkpoint additions are a public adapter/store contract
change. Existing durable-store implementations must add `recordSourceFinality`,
return `sourceFinalityCheckpoint` from `claim`, and enforce the destination-lock
binding before adopting this version. Existing adapters must accept the
checkpoint on destination-lock preparation and return the matching hash. The
core fails closed with `htlc-source-finality-store-unsupported` before any new
chain effect when a runtime store has not adopted the required method. The
core also rejects legacy retained destination locks that lack this causal
binding; stores must not backfill a checkpoint after destination-lock
preparation, and operators must reconcile such legacy sessions explicitly. The
preimage parser remains compatible with canonical lowercase producers while
also accepting byte-equivalent uppercase and prefixed values.

## Host recovery checklist

- Supply a durable, atomic, encrypted `CrossChainHtlcStore` that survives the
  process. Restart safety depends on it; the in-memory store does not provide
  it.
- Keep the original buyer salt encrypted and durable until the session is
  terminal: settlement is recorded, both legs are refunded, or the core
  returns a permanent `failed`. Keep it across destination-claim finality and
  every source-claim retry or replacement; retain it while retrying an alert.
- Supply that same salt on every `advanceCrossChainHtlc` call, including after
  a restart. The current store API does not return secrets on takeover.
- Page an operator on each of these results, and keep advancing the session
  (except after `failed`). `htlcNeedsOperator(progress)` returns `true` for
  exactly this list:
  - `operator-alert`, every reason. Page at once on
    `htlc-destination-claim-failed-preimage-public` and
    `htlc-destination-claim-absent-preimage-broadcast`: the preimage was
    broadcast, so the payee can claim the source before its expiry. The other
    reasons are `htlc-source-claim-missed-after-reveal`,
    `htlc-source-claim-replacement-limit-reached` and `htlc-refund-absent`;
  - `refund-stalled`: a refund reverted and is not re-sent;
  - `waiting` with reason `htlc-destination-claim-unresolved-after-cutoff`: a
    broadcast reveal is still unresolved after the claim cutoff, so nothing
    more is sent for it, and the payee may learn the preimage; before the
    destination expiry a person can still help it land;
  - `waiting` with reason `htlc-destination-claim-unresolved-after-expiry`: a
    reveal is still unresolved after both expiries and blocks both refunds;
  - `failed`: there is nothing left to drive and the record needs
    reconciling.
- Every other `waiting` and `indeterminate` result is retried by advancing
  the session again. A host may also page when one persists, for example an
  adapter that keeps reporting `htlc-adapter-lock-observation-invalid` or an
  `absent` that does not name the active claim (`…-absent-unbound`).
- Two kinds of session never reach a terminal state on their own: one whose
  destination lock has an expiry beyond the safe-integer range, which stays
  `refund-pending` after the payer's refund is final, and one whose
  `htlc-refund-absent` leg an operator refunded by hand. Once an operator has
  reconciled both legs on chain, the host closes the session in its own
  records; only then may it discard the buyer salt.

## Adapter audit checklist

An adapter is fit for production only if an audit confirms each rule below;
the core cannot check them itself.

- `final` only once the state is irreversible under the intent's finality
  policy; `pending` while a reorg or reversal remains possible.
- A final lock keeps being reported `final`, with its inclusion and expiry,
  for the rest of the session, also after it is claimed or refunded and even
  if the contract deletes its record.
- `pending`, never `absent`, while a lock, reveal, claim or refund can still
  land; `absent` only once it is authenticated that it cannot. A retained
  reveal or source claim reported `absent` is replaced, so a premature
  `absent` puts a second claim on the wire, and the earlier attempt may still
  land. For a reveal that means the payer already holds the destination funds:
  unless the adapter then reports the earlier attempt `final`, the core treats
  the replacement's revert as an unlanded reveal, alerts, and once both
  expiries pass refunds the payer's source as well, so the payer ends with
  both legs and the payee with neither, unless the payee claimed the source
  outside the core first. A retained refund reported `absent` raises
  `htlc-refund-absent`.
- A claim's `absent` names the attempt it is about in `txRef`; one that
  names an earlier attempt, or none, is refused.
- `failed` only once the failure itself is final.
- `observe` reports each action only for the core's own retained
  transaction, never a counterparty's, such as a payee's own source claim.
- With replacement history, `observe` reports the active attempt, and
  `absent` once that attempt never reached the chain and can no longer; but
  an earlier attempt that landed after all is reported `final` instead.
- `lockTerms` are read from the contract's lock record in the canonical form
  above, never copied from the intent.
- A final source claim carries a chain-derived `finalityReachedAt`, and a
  final reveal carries `revealedPreimageHex`.
- A replacement preparation returns a different signed transaction, and a
  retained action is broadcast byte for byte.

The package deliberately does not bundle chain SDKs, HTLC contracts, wallets
or funded routes. Those are deployment-specific integrations and require
separate contract audits and funded proofs.
