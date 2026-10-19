# `@kynesyslabs/dacs-seller`

A self-hosted DACS seller: one seller agent for one signed fixed-price DEM
Listing, behind the authenticated seller transport and its durable journal, on
loopback. The agent runs negotiation (DACS-3), the finalized commitment,
`pay-dem` payment intake and delivery through the core SDK
(`@kynesyslabs/dacs`), with the operator's Vet context, native payment
evidence and native DEM delivery capabilities, which the host requires. This is the devnet-demo seller kit, ported from the
plugin seller kit (`RUNTIME-PORTS.json` and `PROVENANCE.json` in the
repository). It is not qualified for mainnet.

Requires Node.js 22.13 or later (`node:sqlite`) and the same version of
`@kynesyslabs/dacs` as a peer.

```js
import { startSellerHost, createOperatorBuyerAccess } from '@kynesyslabs/dacs-seller';

const host = await startSellerHost({
  signer,               // { claim: 'did:demos:agent:<hex>', sign(bytes) -> 64-byte Ed25519 signature }, synchronous
  listing,              // the signed Listing this seller serves; the signer must control it
  dataDirectory,        // absolute real path of a private (0700) directory owned by this user
  buyerAccess: createOperatorBuyerAccess({ openBuyerAccess: true }),
  agreementAnchor,      // { source, readAgreement(input) }: native Agreement readback
  artifactAnchor,       // { writer, publish, readRetained, verifyReceipt }: native artifact publication
  deliverableProducer,  // (input) -> the deliverable bound to the Agreement and settlement
  observeDemosTransfer, // (txHash) -> pay-dem transfer observation, e.g. the core seller observer
  nativePaymentEvidence, // createNativePaymentEvidenceConsumer(...): payment evidence anchoring and readback
  demDeliveryContext,    // createDemDeliveryContext(...): the Vet context the Agreement derives from
  nativeDemDelivery,     // createNativeDemDeliveryCapability(...): Deliverable publication and readback
});
// host.url is http://127.0.0.1:<port>; host.close() drains requests and closes the state.
```

`buildUnsignedIdentityBundle`, `attachIdentityPresentation`,
`buildListingDraft`, `listingSigningMessage` and `attachListingSignature`
build the signed Listing; a wallet signs the returned messages. The other root
exports are the parts the host composes, for operators who compose their own:
`createSellerAgent`, `createSellerHttpHandler`, `createSellerTransportStore`,
`createSellerTransportServerAuth` and the buyer side `createSellerAgentClient`
and `createSellerTransportClientAuth`. The kit's other modules are reachable
by path (`@kynesyslabs/dacs-seller/src/...`); they are not a stable API.

## What the host does and does not do

- It fails closed on configuration: unknown options, a missing capability, a
  non-loopback host, a relative, shared or symlinked data directory, or a
  signer that does not control the Listing are refused before anything starts.
  One live process owns a data directory (`seller-state.lock`): a second host,
  in this process or another, is refused; the lock of a process that is
  provably gone is taken over, and any doubt refuses until it is removed by hand.
- Every request must carry a buyer transport signature over its method, path
  and body, for this seller and Listing; unsigned or mismatched requests are
  refused before the agent runs. Effects are journaled before they run, so a
  restarted host answers a completed request again and never repeats an
  uncertain one.
- It never uses the simulated fixture substrate. Native Agreement readback and
  native artifact publication are required together, and the agent refuses a
  fixture fallback (`fixture_substrate_disabled`).
- It starts only with the whole chain to delivery: native payment evidence,
  the DEM delivery context and native DEM delivery. The agent signs an
  Agreement only over the Vet references the context gives
  (`vet_context_required` otherwise; it never signs the synthetic
  not-performed references), commits and takes payment only with the whole
  chain (`settlement_profile_unavailable`), and takes payment only as native
  payment evidence (`native_evidence_required`), so it never commits an
  Agreement it cannot settle or claims a payment it cannot deliver for. These
  capabilities accept only `TEST-` authorities and a loopback fixture node
  (below), so the host does not start against a real node.
- It does not mount the Vet and Agreement context route: its challenge
  issuance limits are not settled (`ADMISSION.md`).
- The devnet source transport, wallet custody and the wallet journal are not
  part of this package. The kit builders that need them (the devnet artifact
  anchor, issued-write readback and the source mode of native payment
  evidence) refuse every value here; the operator supplies its own
  capabilities. Native DEM delivery and the DEM delivery context accept only
  `TEST-` authorities, as in the source kit. Native writes also need a
  qualified node deployment (`QUALIFIED_NODE_COMMITS`).
- Not shipped: the operator's test wallet custody (`operator-custody.mjs`),
  journal-bound issuance (`seller-issuance.mjs`) and the wallet write batch
  (`seller-write-batch.mjs`).
