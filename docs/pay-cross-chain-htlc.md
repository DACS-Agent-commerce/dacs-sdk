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
- generation-fenced source-claim replacement after an authenticated failure,
  with an immutable attempt history and no release of old effect/transaction
  reservations;
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

`authorizeDestinationClaim` preserves HTLC-10's payer free option: the core
does not reveal merely because both locks exist. Once the destination claim is
final, the preimage is public and the source refund path is forbidden. If the
payee's source claim is not yet final, the result is `settle-asymmetric`, not a
refund or terminal ordinary failure.

The selected authority must provide a positive safe-integer
`destinationFinalitySec`. For actual lock expiries, the last permissible reveal
instant is the earlier of:

- `destinationExpiry - destinationFinalitySec`; and
- `sourceExpiry - sourceFinalitySec - safetyWindowSec`.

Both deadlines are evaluated with overflow-safe millisecond arithmetic. The
cutoff itself is exclusive: one millisecond before it can reveal, while at or
after it the core returns `htlc-destination-claim-cutoff-reached` without
preparing or broadcasting a new reveal. A retained destination-claim is treated
as potentially exposed after restart; pending or ambiguous reveal attempts are
never reclassified as a benign timeout refund. A destination claim that is
already final is still authenticated, checkpointed, and recovered after the
cutoff.

The buyer salt is never passed to an adapter and must remain encrypted and
durable until destination-claim finality. Production stores must atomically
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
effect hash and transaction reference, authenticated failed observation, and a
fresh replacement. It requires a reveal checkpoint and an unexpired source
claim window, appends the failed attempt to `sourceClaimAttemptHistory`, keeps
all old effect/transaction reservations, and exposes only the replacement as
the active `prepared` source claim. `recordPrepared` remains immutable for every
ordinary action. The exported in-memory store is for tests and development
only.

When preparing a replacement, the adapter receives `replacement` context with
the new attempt number, prior effect hash/reference, and failure authentication
hash. It must use that context to create a different signed transaction. The
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
must never report `final` for a state it could later reverse. A reorg-capable
adapter therefore needs to keep observing through its required finality horizon
before allowing the core to checkpoint a reveal or report settlement.

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

The package deliberately does not bundle chain SDKs, HTLC contracts, wallets
or funded routes. Those are deployment-specific integrations and require
separate contract audits and funded proofs.
