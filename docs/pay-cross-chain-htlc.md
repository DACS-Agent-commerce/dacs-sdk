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
- payer source lock, then payee destination lock only after source finality;
- payer destination claim/reveal, then payee source claim;
- durable signed effects recorded before any broadcast and generation-fenced
  across worker takeover;
- byte-identical retained-effect rebroadcast after ambiguity or restart;
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

The buyer salt is never passed to an adapter and must remain encrypted and
durable until destination-claim finality. Production stores must atomically
enforce cross-session salt uniqueness, authenticate retained signed payloads,
and persist the reveal checkpoint. The exported in-memory store is for tests
and development only.

`HtlcObservedAction.state: "final"` is an authenticated adapter assertion, not
an independently corroborated core observation. Each chain adapter owns the
confirmation-depth and irreversibility policy selected by the intent, including
reorg detection. It must return `pending` while reversal remains possible and
must never report `final` for a state it could later reverse. A reorg-capable
adapter therefore needs to keep observing through its required finality horizon
before allowing the core to checkpoint a reveal or report settlement.

The package deliberately does not bundle chain SDKs, HTLC contracts, wallets
or funded routes. Those are deployment-specific integrations and require
separate contract audits and funded proofs.
