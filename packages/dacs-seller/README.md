# `@kynesyslabs/dacs-seller`

A self-hosted DACS seller: one seller agent for one signed fixed-price DEM
Listing, behind the authenticated seller transport and its durable journal, on
loopback. The agent runs negotiation (DACS-3), the finalized commitment,
`pay-dem` payment intake and delivery through the core SDK
(`@kynesyslabs/dacs`), with the operator's Vet context, native payment
evidence and native DEM delivery capabilities, which the host requires. This is the devnet-demo seller kit, ported from the
plugin seller kit (`RUNTIME-PORTS.json` and `PROVENANCE.json` in the
repository). It is a **fixture-only kit**: its native capabilities accept
only `TEST-` authorities and a loopback fixture node, so it cannot start
against, or read from, a real Demos node (see "What the host does and does
not do"). It is not qualified for mainnet.

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
  nativePaymentEvidence, // createNativePaymentEvidenceConsumer({ ..., anchorEvidence: journal.anchorEvidence }):
                         // payment evidence anchored by the wallet journal (below), and its readback; the
                         // agent reads the signed CREATE's projection from the same journal
  demDeliveryContext,    // createDemDeliveryContext(...): the Vet context the Agreement derives from
  nativeDemDelivery,     // createNativeDemDeliveryCapability(...): Deliverable publication and readback
  railAuthority,         // { rail, stewardClaim, stewardPublicKey, railRegistryVersion, production }: the
                         // steward-signed demos-native:DEM RailDefinition (PA-1, in-code) and local policy
  sessionAdmission,      // { admit, resolveVetRecord, readVetAnchorReceipt, readRevocationSurfaces, readRevocationMarker }:
                         // the seller-owned session admission, Vet record and receipt readers and revocation
                         // readers (src/dacs/session-admission.mjs)
  reconcilePaymentEvidence: journal.reconcilePaymentEvidence, // the same journal's answer for an evidence
                         // anchor that was sent or whose outcome is unknown ('unsigned' | 'rebroadcast' | 'pending')
});
// journal = createPaymentEvidenceWalletJournal(...) (below); the host refuses any other pair.
// host.url is http://127.0.0.1:<port>; host.close() drains requests and closes the state.
// host.issueSessionChallenge({ jobId, buyer }) issues the challenge the buyer's bundle presents.
```

`buildUnsignedIdentityBundle`, `attachIdentityPresentation`,
`buildListingDraft`, `listingSigningMessage` and `attachListingSignature`
build the signed Listing; a wallet signs the returned messages. A buyer
builds its presentation with `buildUnsignedIdentityBundle({ address,
presentedAt, sessionNonce })`, where `sessionNonce` is the challenge the
seller issued. `createPaymentEvidenceWalletJournal` composes the payment
evidence anchor and `reconcilePaymentEvidence` from the operator's wallet
(below).
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
  refused (`peer_operation_conflict`). After the checkpoint the retained work
  alone decides what a claim may send: a readback that fails on a retry (a
  node or name-index outage) is a `held` answer with its cause
  (`nativeReadCode`). A claim whose effect a thrown error or a crashed host
  left uncertain runs again through reconciliation, from what the agent
  retained: after the checkpoint its retained work runs again; before it
  (a crash during the first claim) nothing was sent and every step is
  replay-idempotent, so the same claim runs again from its start, under the
  same gates. Either way the claim then goes back to the same retry, so a
  paid order is never stranded; a first claim that ran again from its start
  and kept nothing (a transfer not on the node, an underpaid one) is released
  as on the ordinary path, so the buyer's corrected claim reaches payment
  intake. Until a gate that refuses the claim (a closed buyer access, an
  unusable rail) passes again, its claims answer `503 operation_uncertain` and
  run again on the next one. Once the agent retains work for a claim, no
  answer or refusal of it releases its slot: a different claim for the job is
  refused until it is delivered. A transaction hash is read as core payment
  intake reads it (lower case, with or without `0x`). Under a seller session
  delegation that has expired, a held claim answers its last answer and an
  uncertain one stays uncertain: neither runs again, since a run can sign and
  send. The Deliverable is submitted again only on an absence that is
  authoritative (the agent never asked for it, or the delivery reader proved
  nothing was signed); a readback that misses or fails holds the delivery. A
  seller signature whose signer failed released nothing, so the next holder of
  the job signs the same bytes again.
- The delivery capability owes that proof. The agent records a Deliverable
  submission before it asks `nativeDemDelivery.submit`, so a submission that
  fails before anything is signed, or a host that dies between the record and
  the call, leaves a record with no CREATE, and only the capability can tell
  that from a CREATE it signed and lost. Its `read` returns
  `provenUnsignedAbsence(reason)` (from
  `@kynesyslabs/dacs-seller/src/dacs/native-dem-delivery-consumer.mjs`)
  exactly when it holds no signed CREATE for the address and never asked its
  wallet to sign one; the agent then asks again, and the paid order is
  delivered with one CREATE. Any other answer (a miss, a lagging name index,
  an error, or a CREATE it signed that is not on the chain) holds the
  delivery and never submits again: a landed CREATE would be made twice. A
  `read` that never returns the proof strands a paid order after one failed
  submission. The package's devnet artifact anchor returns it for an address
  with no stored intent and no signed CREATE retained by the source or its
  wallet, and for an intent a shutdown cut before it was signed.
- Payment evidence is anchored through `nativePaymentEvidence`'s
  `anchorEvidence` (DACS-4 PC-7(b), write-once) and answered for by the
  required `reconcilePaymentEvidence`. The agent, whether the host composes
  it or an operator does with `createSellerAgent`, takes the two only from
  one `createPaymentEvidenceWalletJournal` (the journal's own
  `anchorEvidence` inside the consumer, and its `reconcilePaymentEvidence`):
  any other pair, a wrapper or two journals included, is refused when it is
  constructed (and by the host at start), so the answers that allow a second
  signature come only from the journal's own records.
  The agent keeps each attempt before it calls the wallet. It sends the same
  evidence again on the buyer's next claim (or after a restart) only when no
  attempt can have written it: the last attempt never reached the wallet
  (a crash after the evidence checkpoint), or the wallet's journal answered
  `{ status: "unsigned" }` (below). No answer of the anchor itself allows it.
  It also needs a readback that finds nothing: at most once per request,
  never in the request of the first attempt, and never once a readback has
  authenticated it. A name-index miss is no proof that nothing landed
  (CORE §5.1). After any other answer, a throw, or a crash during the call
  (`anchorOutcome: "sent"` or `"unknown"`), a readback that finds nothing asks
  `reconcilePaymentEvidence`, once per claim. It is the wallet's own journal
  for this exact evidence, and the host does not start without it, so a paid
  order whose anchor outcome is unknown always has a way on. It is called with
  `{ logicalAddress, artifact, writer, artifactKind, jobId, receiptContentHash,
  attempt: { outcome, answer } }`:
  - `{ status: "unsigned" }` must mean that no transaction the wallet signed for
    this address is or can still be included; only this answer lets the agent
    send the same bytes again;
  - `{ status: "rebroadcast" | "pending", txHash }` means the one signed
    transaction was broadcast again unchanged (a dropped submission), or is
    still pending; the agent waits for its readback and never asks for a new
    signature;
  - any other answer or a throw keeps the claim held (`reconcileError` keeps
    the cause).

  `createPaymentEvidenceWalletJournal({ path, signCreate, broadcast,
  readAccountNonce, readTransactionState })` gives both functions from the
  operator's wallet primitives. `signCreate(input)` signs, and does not send,
  the storage CREATE (`{ signedTransaction, txHash, nonce }`).
  `signedTransaction` is the JSON of exactly the public signed projection
  `{ hash, content, signature: { type, data } }` of the Demos signed
  transaction: of the SDK's `sign()` result, only those three members (its
  `status`, `blockNumber` and `ed25519_signature` are left out; node 61b8e75
  refuses a truthy `status`, which the signature does not cover). Before it is
  kept, the journal checks it is what the node executes and the SR-2 readback
  reads back as this evidence: `hash` is `txHash` and the SHA-256 of
  `JSON.stringify(content)`, its nonce is `nonce`, and it is the
  `CREATE_STORAGE_PROGRAM` of exactly this evidence (salt `''`, encoding
  `json`, metadata `logicalAddress`, `artifactKind`, `contentHash` =
  `receiptContentHash` and `envelopeHash` = the SHA-256 of the canonical
  evidence) at this logical address, with `to` and the operation's
  `storageAddress` the address the writer, the program name and the nonce
  derive, from the writer's address (`from` and `from_ed25519_address`), with
  the writer's Ed25519 signature over the hash as `0x` and lower-case hex.
  Anything else is refused (`wallet_sign_invalid`), and nothing is kept or
  sent.
  `broadcast({ signedTransaction, txHash })` sends exactly those bytes.
  `readAccountNonce()` reads the wallet account's nonce on the chain, and
  `readTransactionState({ txHash })` answers `applied` (executed), `pending`
  (in the mempool, not yet included) or `absent` (anything else). Node 61b8e75
  includes a mempool transaction whose nonce another write reached as failed,
  and then reports it `included`. So on that node both reads come from the
  same node, account nonce first: `getTransactionStatus` `pending` is
  `pending`; `included` with `getTxByHash` `status: "confirmed"` is `applied`;
  `included` with `status: "failed"`, or `unknown`, is `absent`.
  The journal keeps the signed CREATE and its nonce in its SQLite file (a
  private 0600 file) before it broadcasts it, and keeps at most one live signed
  CREATE per address. Its `readSignedProjection({ logicalAddress })` answers
  that CREATE's public projection, read only; the agent authenticates the
  evidence readback with it. The file has its own `journalId`: the agent keeps
  it with each anchor attempt and never asks another journal (a lost or
  replaced file) about that attempt, so such a file holds the claim (`held`,
  `reconcileError.code: "wallet_journal_changed"`) instead of signing a second
  CREATE; restore the file to resolve it. The journal also refuses
  (`wallet_journal_unknown_attempt`) an attempt whose `txHash` it never kept. While that CREATE can still be included, the journal
  broadcasts the same signed bytes again (`rebroadcast`, or `pending` when the
  broadcast fails). The node never executes a transaction whose nonce the
  account has reached: it refuses it, or includes it as failed. So once the
  account nonce has reached the kept nonce (read first), and the CREATE is
  then neither applied nor pending, the journal marks it superseded (and keeps
  it). It then answers `unsigned`, and the next anchor signs the same evidence
  anew, with a higher nonce. A read that fails, times out (`readTimeoutMs`,
  10 s by default) or answers anything else never supersedes it. An unknown
  readback sends nothing and asks nothing.
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
- It opens a new session only for a presentation of a challenge it issued,
  on a Listing its own revocation check finds not revoked, and only under
  `sessionAdmission`, before anything of it is kept, read, signed or sent.
  - **Issuing.** `host.issueSessionChallenge({ jobId, buyer })` keeps a fresh
    256-bit nonce for that job and buyer, valid for ten minutes, before it
    returns `{ jobId, buyer, sessionNonce, issuedAt, expiresAt }`. The operator
    hands it to the buyer, whose bundle carries it as `sessionNonce` (CORE
    SN-1..SN-3; delivering the challenge to the buyer is up to the operator).
  - **Operator-generated nonces.** An operator whose own issuer generates
    nonces may pass `sessionNonce`: lowercase hex, at least 128 bits from a
    CSPRNG (SN-2 is the issuer's duty), and at most 128 hex characters, a
    local limit of this seller that SN-2 does not set. A nonce is issued
    only once.
  - **Consumption.** A presentation attempt for a new session consumes the
    nonce its bundle carries, durably and before the attempt is validated:
    before its signature, its buyer and job binding, the revocation check and
    `admit` (CORE SN-4, IBH-4). A refused attempt consumes it too, a `503`
    included, so after a refused attempt the buyer asks the operator for a
    new challenge. After an admitted one, the buyer sends the admitted
    presentation again (a new challenge would be another bundle, refused as
    `job_taken`). Only the configuration gates, the operator's buyer access, a
    bundle that is not an IdentityBundle at all, a presentation that carries
    no session nonce (refused as `session_not_admitted`, DACS-1 §6.3.2) and
    the rail selection, which read the seller's own state, come first: those
    refusals consume nothing.
  - **Later presentations.** Any later presentation that carries the nonce is
    refused (`session_not_admitted`): another one, a re-signed one, or one
    for another job. The presentation that was admitted is the one exception:
    sent again (a retry after a lost answer), it continues its own session.
  - **Refused before `admit`.** A nonce the seller did not issue, one issued
    for another job or buyer, or an expired one is refused before `admit` is
    asked.

  **Revocation.** The agent decides whether its Listing is revoked itself,
  with the core SDK's DACS-1 RB-4..RB-6 check (`checkListingRevocation`), for
  every new session. The operator gives only readers:
  `readRevocationSurfaces({ jobId, listingPin })` answers the discovery
  surfaces it read for the Listing (1 to 16 core `RevocationSurface`s), and
  `readRevocationMarker(markerAnchor)` the RevocationMarker a surface's
  binding names, or null. A `revoked` surface counts only through its marker,
  which the core fetches, hashes and verifies against the Listing signer;
  that refuses the session (`session_not_admitted`). A reader that throws, a
  missing, stale (a catalog entry older than a day), unverified or malformed
  surface, or a marker that does not read back or verify makes the check
  indeterminate, which refuses it too (`session_admission_unavailable`, with
  the cause). An `active` surface is the reader's reading: Demos gives no
  authenticated proof that a revocation marker is absent (CORE §5.1).

  Its `admit` answer must bind the exact job, buyer, buyer bundle and Listing
  pin, and must name both parties configured for this package's exact
  profile (the Standard commit and the complete document tuple in
  PROFILE.json; CORE §11.1.2). It carries nothing else: an answer with a
  revocation reading or a challenge is refused.

  Anything missing, malformed, duplicated or different is refused
  (`session_not_admitted`), and an `admit` that throws is refused too
  (`session_admission_unavailable`). Neither refusal keeps an effect. Each Vet
  reference the context gives is relied on only through the record
  `resolveVetRecord` returns, and only with the SR-2 receipt
  `readVetAnchorReceipt` returns for it (DACS-2 VPC-3: a signed record is not
  thereby admitted). The receipt must be a CORE §5.1 receipt for the
  reference's own address (the job's canonical `dacs2:composite:` address)
  and exact hash, an established observation, at `accepted`, `included` or
  `finalized`; none, one for another address or hash, an indeterminate
  observation, or a `submitted`, `rejected`, `dropped`, `replaced`,
  `expired` or `reorged` one refuses before the Agreement is signed
  (`VET_RECORD_UNVERIFIED`). The host checks what the receipt names and its
  state; the operator's reader authenticates it against the chain, as it does
  a revocation surface. The record must be a CompositeVerificationRecord
  with the reference's exact hash, for this job, party and bundle, with a
  `pass` decision (DACS-2 §7.7.1). It must be signed by the party's
  counterparty verifier, which the reference names as `signer` (DACS-2
  §7.7.2): the buyer's record by this seller, the seller's own record by the
  buyer. The seller's bundle in the context is the Listing's, or a
  presentation of exactly that identity made for the session (another
  `presentedAt` and `sessionNonce`, as the package's Vet provider presents it
  to the buyer's challenge) whose presentation the seller signed; the seller's
  record must be of that bundle. The context's Vet requirement invocations go into the delivery
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
  in flight, signed under its pin, continues without a new admission or
  revocation check. The agent's startup check reads only the Listing's own
  bytes, signature and rail; revocation is checked per new session (above).
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
  a session needs is the one `host.issueSessionChallenge` issued, which the
  operator delivers to the buyer. The host keeps every issued challenge
  with its seller state; nothing removes one yet, so the operator issues one
  only for a buyer that is about to present.
- The devnet source transport and wallet custody are not part of this
  package (the payment-evidence journal composes the operator's own wallet
  primitives). The kit builders that need them (the devnet artifact
  anchor, issued-write readback and the source mode of native payment
  evidence) refuse every value here; the operator supplies its own
  capabilities. Native DEM delivery and the DEM delivery context accept only
  `TEST-` authorities, as in the source kit. Native writes also need a
  qualified node deployment (`QUALIFIED_NODE_COMMITS`).
- Not shipped: the operator's test wallet custody (`operator-custody.mjs`),
  journal-bound issuance (`seller-issuance.mjs`) and the wallet write batch
  (`seller-write-batch.mjs`).
