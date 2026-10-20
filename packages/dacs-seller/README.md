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
  railAuthority,         // { rail, stewardClaim, stewardPublicKey, railRegistryVersion, production }: the
                         // steward-signed demos-native:DEM RailDefinition (PA-1, in-code) and local policy
  sessionAdmission,      // { admit(query), resolveVetRecord(query) }: the seller-owned session admission
                         // (profile, challenge, revocation, Vet records; src/dacs/session-admission.mjs)
});
// host.url is http://127.0.0.1:<port>; host.close() drains requests and closes the state.
```

`buildUnsignedIdentityBundle`, `attachIdentityPresentation`,
`buildListingDraft`, `listingSigningMessage` and `attachListingSignature`
build the signed Listing; a wallet signs the returned messages.
`validateListing` reads a Listing through the core SDK and resolves its rail
from a `railAuthority` (or, for tests only, `simulatedFixture: true`). The other root
exports are the parts the host composes, for operators who compose their own:
`createSellerAgent`, `createSellerHttpHandler`, `createSellerTransportStore`,
`createSellerTransportServerAuth` and the buyer side `createSellerAgentClient`
and `createSellerTransportClientAuth`. The kit's other modules are reachable
by path (`@kynesyslabs/dacs-seller/src/...`); they are not a stable API.

## What the host does and does not do

- It fails closed on configuration: unknown options, a missing capability, a
  non-loopback host, a relative, shared or symlinked data directory, or a
  signer that does not control the Listing are refused before anything starts.
  The private stores also check every ancestor of the data directory: each must
  be owned by root or by this user and not be group- or world-writable, so the
  host does not start where `/` belongs to another user (for example some
  rootless containers or sandboxes).
  One live process owns a data directory (`seller-state.lock`): a second host,
  in this process or another, is refused; the lock of a process that is
  provably gone is taken over, and any doubt refuses until it is removed by hand.
- Every request must carry a buyer transport signature over its method, path
  and body, for this seller and Listing; unsigned or mismatched requests are
  refused before the agent runs. Effects are journaled before they run, so a
  restarted host answers a completed request again and never repeats an
  uncertain one. A payment answer that is not final is not cached as final:
  an `indeterminate` answer before the evidence checkpoint (a transfer not yet
  included, for example) keeps nothing, so the same claim reaches payment
  intake again; after the checkpoint a `held` answer, or a delivery that is not
  done yet, runs the agent's retained work again on the buyer's next request
  (which reads back first), and a different claim for the job is still
  refused (`peer_operation_conflict`).
- Payment evidence is anchored through the operator's
  `nativePaymentEvidence` `anchorEvidence` (DACS-4 PC-7(b), write-once). The
  agent keeps each attempt before it calls the wallet. It sends the same
  bytes again on the buyer's next claim (or after a restart) only when no
  attempt can have written them: the last attempt never reached the wallet
  (a crash after the evidence checkpoint), or the wallet answered
  `{ status: "refused", reason }`, which must mean it signed and sent
  nothing. It also needs a readback that finds nothing: at most once per
  request, never in the request of the first attempt, and never once a
  readback has authenticated it. A name-index miss is no proof that nothing
  landed (CORE §5.1): after any other answer, a throw, or a crash during the
  call, the agent only reads back and holds the claim (`readback:
  "indeterminate"`, `anchorOutcome: "sent"` or `"unknown"`) until the write
  reads back; it never sends it again. An unknown readback sends nothing.
- It never uses the simulated fixture substrate. Native Agreement readback and
  native artifact publication are required together, and the agent refuses a
  fixture fallback (`fixture_substrate_disabled`). `createSellerAgent` takes
  the fixture substrate (`anchors`) only with `simulatedFixture: true`: that
  test profile signs over not-performed Vet references and an unsigned
  in-code rail, and is not covered by PROFILE.json.
- It selects its rail only from `railAuthority` (DACS-4 9.4.3-9.4.4, DACS-1
  LRR-6): the complete `demos-native:DEM` RailDefinition signed by the steward
  key the operator gives, with `governance.anchoring: "in-code"` (PA-1). The
  core SDK checks the signature and the availability. A new session is refused
  (`rail_unavailable`) unless the rail is `live`: `disabled`, `failed`, gated
  (this package runs no operator preflight) and `mocked` rails are not
  selected. Each session pins the exact signed definition before its Agreement
  is signed, and commitment and payment intake read the rail from that pin
  only. A pin is in flight from the seller's Agreement signature on: a later
  revision (a disabled rail or a new `railRegistryVersion`) does not change
  it, and the session keeps the registry version it pinned. A proposal the
  seller has not signed (a rejected one, for example) has no session yet, and
  its retry selects the rail again under the current authority. A pin the
  configured steward did not sign is refused, so a rotated steward key refuses
  sessions pinned under the old one until that key is configured again.
- It opens a new session only under `sessionAdmission`, before anything of it
  is kept, read, signed or sent. Its `admit` answer must bind the exact job,
  buyer, buyer bundle and Listing pin, and must carry three things:
  - both parties configured for this package's exact profile (the Standard
    commit and the complete document tuple in PROFILE.json; CORE §11.1.2);
  - the challenge the seller issued for this job, equal to the bundle's
    `sessionNonce` and consumed by this attempt (CORE SN-1..SN-4). The agent
    itself also binds each nonce to the first job that presented it (kept
    with that session, so across a restart): the same nonce for another job
    is refused before `admit` is asked. Issuance and the revocation reading
    remain the operator's own answers;
  - a revocation reading of the Listing, `active` and at most five minutes
    old (DACS-1 RB-5/RB-6).

  Anything missing, malformed, duplicated or different is refused
  (`session_not_admitted`), and an `admit` that throws is refused too
  (`session_admission_unavailable`). Neither refusal keeps an effect. Each Vet
  reference the context gives is relied on only through the record
  `resolveVetRecord` returns. That record must be a CompositeVerificationRecord
  with the reference's exact hash, for this job, party and bundle, with a
  `pass` decision (DACS-2 §7.7.1). It must be signed by the party's
  counterparty verifier, which the reference names as `signer` (DACS-2
  §7.7.2): the buyer's record by this seller, the seller's own record by the
  buyer. The context's Vet requirement invocations go into the delivery
  audit source, so the agent checks them with the SDK delivery runner's own
  check (`sellerFulfilmentVetRequirementsViolation`) before it signs: exactly
  one per record, evaluating its party, naming that counterparty as
  verifier, the Listing's `buyerRequirement` for the buyer's record, and
  every required claim covered by a result for this job. Each record must
  also pass the SDK's strict CompositeVerificationRecord check against its
  invocation: its `requirementHash` is the hash of that exact requirement
  and its decision replays from the invocation's results (DACS-2 §7.7.1).
  This package resolves no VerifyResult, so a requirement with a required
  claim is refused. Otherwise the Agreement is not signed, before any
  payment. A session
  in flight, signed under its pin, continues without a new admission. The agent
  itself never makes up a revocation reading: its startup check reads only the
  Listing's own bytes, signature and rail.
- The profile gates (`vet_context_required`, `session_admission_required`,
  `settlement_profile_unavailable`, `rail_unavailable`,
  `native_evidence_required`, `bundle_finalization_unavailable`) refuse before
  any read, write, signature
  or send, and the transport answers them as definite refusals that keep no
  effect in the journal: once the operator completes the configuration, the
  same request runs.
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
- It signs no completed DACS-5 bundle (`bundle_finalization_unavailable`
  from both the bundle request and the countersignature, after the delivery
  check): the ST-11 finalizer, which needs finalized and independently
  resolved Vet, commitment, settlement and bundle records, is not part of this
  package. The session ends at delivery.
- It does not mount the Vet and Agreement context route itself: the challenge
  a session needs comes from the operator's `sessionAdmission`.
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
