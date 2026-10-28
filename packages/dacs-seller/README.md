# `@kynesyslabs/dacs-seller`

A self-hosted DACS seller: one seller agent for one signed fixed-price DEM
Listing, behind the authenticated seller transport and its durable journal, on
loopback. The agent runs negotiation (DACS-3), the finalized commitment,
`pay-dem` payment intake and delivery through the core SDK
(`@kynesyslabs/dacs`), with the operator's Vet context, native payment
evidence and native DEM delivery capabilities, which the host requires. This
is the devnet-demo seller kit, ported from the plugin seller kit (see
[SOURCES.md](SOURCES.md)). Its packaged native readers are **fixture-only**:
the native DEM delivery capability and the DEM delivery context accept only a
`TEST-` authority (`src/dacs/native-dem-delivery-consumer.mjs`,
`src/dacs/dem-delivery-context-consumer.mjs`), and
`createNativePaymentEvidenceConsumer` accepts only a literal `127.0.0.1` RPC
origin (`src/dacs/native-payment-evidence-consumer.mjs`). The host checks
`agreementAnchor` and `artifactAnchor` only by shape, and the wallet journal's
`broadcast` is the operator's own callback, so an operator-supplied anchor or
broadcast can still reach a real Demos node: keep them on the fixture too. It
is not qualified for mainnet. The standalone host retains all jobs and refuses
new jobs before admission after `maxJobs` (default 10,000); terminal DACS-5
bundle completion and transport-row reclamation are not wired.
The live node2 deployment is unsupported; the pinned node profile is not a
qualification for a current testnet deployment.

The repository's `engines` require Node.js `^20.19.0 || >=22.12.0`; the
durable stores use the native `better-sqlite3` module. Use the same version of
`@kynesyslabs/dacs` as this kit.

```js
import { startSellerHost } from './src/index.mjs';
import { createOperatorBuyerAccess } from './src/devnet-demo/buyer-access.mjs';

const host = await startSellerHost({
  signer,               // { claim: 'did:demos:agent:<hex>', sign(bytes) -> 64-byte Ed25519 signature }, synchronous
  listing,              // the signed Listing this seller serves; the signer must control it
  dataDirectory,        // absolute real path of a private (0700) directory owned by this user
  buyerAccess: createOperatorBuyerAccess({ openBuyerAccess: true }),
  agreementAnchor,      // { source, readAgreement(input) }: native Agreement readback
  artifactAnchor,       // { writer, publish, readRetained, verifyReceipt }: native artifact publication
  deliverableProducer,  // synchronous, deterministic (input) -> JSON bound to the Agreement and settlement
  deliverySchemaVerifier, // { schemaUrl, verify({ schemaUrl, cleartextPayload }) -> { disposition } }
                          // required when the Listing names a schema; implements that exact schema
  maxJobs: 10000,        // shared agent/store lifetime cap; checked before challenge consumption
  deliveryEvidenceEnabled, // optional boolean (default false): publish settlement evidence with delivery
  host,                  // optional literal loopback address (127.0.0.1 or ::1); default 127.0.0.1
  port,                  // optional local port, 0 to 65535; default 0 (an ephemeral port)
  now,                   // optional () -> epoch milliseconds; default Date.now
  observeDemosTransfer, // optional compatibility option; native intake uses nativePaymentEvidence's observer
  nativePaymentEvidence, // createNativePaymentEvidenceConsumer({ ..., anchorEvidence: journal.anchorEvidence }):
                         // payment evidence anchored by the wallet journal (below), and its readback; the
                         // agent reads the signed CREATE's projection from the same journal
  demDeliveryContext,    // createDemDeliveryContext(...): the Vet context the Agreement derives from
  nativeDemDelivery,     // createNativeDemDeliveryCapability(...): Deliverable publication and readback
  railAuthority,         // { rail, stewardClaim, stewardPublicKey, railRegistryVersion, production }: the
                         // steward-signed demos-native:DEM RailDefinition (PA-1, in-code) and local policy
  sessionAdmission,      // { admit, resolveVetRecord, readVetAnchorReceipt, verifyVetAnchorReceipt,
                         // readRevocationSurfaces, readRevocationMarker }: the seller-owned session admission,
                         // Vet record reader, receipt reader and receipt verifier, and revocation readers
                         // (src/dacs/session-admission.mjs); admit must name both participants on the exact
                         // [PROFILE.json](PROFILE.json) profile: standardRevision
                         // d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20 and documentVersions
                         // CORE 0.3, DACS-1 0.7, DACS-2 0.6, DACS-3 0.5, DACS-4 0.8, DACS-5 0.5
  reconcilePaymentEvidence: journal.reconcilePaymentEvidence, // the same journal's answer for an evidence
                         // anchor that was sent or whose outcome is unknown ('unsigned' | 'rebroadcast' | 'pending')
});
// journal = createPaymentEvidenceWalletJournal(...) (below); the host refuses any other pair.
// host.url is http://127.0.0.1:<port>; host.close() drains requests and closes the state.
// host.issueSessionChallenge({ jobId, buyer }) issues the challenge the buyer's bundle presents.
```

Imports in this README are paths inside this directory: it has no package
manifest yet, so `@kynesyslabs/dacs-seller` cannot be installed or imported by
name. `src/dacs/listing.mjs` exports `buildUnsignedIdentityBundle`,
`attachIdentityPresentation`, `buildListingDraft`, `listingSigningMessage` and
`attachListingSignature`, which build the signed Listing; a wallet signs the
returned messages. A buyer builds its presentation with
`buildUnsignedIdentityBundle({ address, presentedAt, sessionNonce })`, where
`sessionNonce` is the challenge the seller issued.
`createPaymentEvidenceWalletJournal` composes the payment evidence anchor and
`reconcilePaymentEvidence` from the operator's wallet (below).
`validateSellerListing` (`src/dacs/rail-authority.mjs`) reads a Listing
through the core SDK and resolves its rail from a `railAuthority` (or, for
tests only, `simulatedFixture: true`). `createSellerAgent` is exported by
`src/dacs/seller-agent.mjs`.
The root `src/index.mjs` exports `startSellerHost`, `createSellerHttpHandler`,
`createSellerAgentClient`, `createSellerTransportStore`,
`createSellerTransportServerAuth`, `createSellerTransportClientAuth` and
`createPaymentEvidenceWalletJournal`. The kit's other modules are reachable by
path; they are not a stable API.

`deliverableProducer` is called repeatedly during preparation, verification and
recovery. It must synchronously return identical JSON for the same Agreement,
Listing and settlement, including after restart. Persist application-generated
content before returning it. A Promise is refused as `deliverable_producer_async`.
The operator supplies `deliverySchemaVerifier` for the exact signed schema URL;
unknown schemas refuse construction before any Agreement can be signed. Its
`verify` may be async and must return `{ disposition: 'valid' | 'invalid' |
'indeterminate', reason? }` after checking the actual payload against that schema.
An `indeterminate` verdict retains its reason and holds preparation for retry,
including after restart, without consuming the delivery permit. An `invalid`
verdict remains a preparation failure. This kit prepares inline public storage
payloads only. The native host requires an explicit `expectedSizeBytes` in the
signed Listing before any Agreement is signed. Pass it to `buildListingDraft`;
it is the exact UTF-8 byte length of the canonical JSON payload, not an estimate
or an upper bound. It must fit the report's job/Agreement/settlement bindings
and must not exceed 16384 bytes (`MAX_STORAGE_ARTIFACT_BYTES`, the capacity of
the one storage CREATE that carries it). Listings without a size remain valid
general DACS Listings but need a different delivery profile. DACS-4 §9.6.1
requires an extended pointer above 128 KiB; this profile has no pointer
publisher and refuses a larger Listing before any Agreement is signed. An actual
producer output that exceeds the limit or differs from the declared exact size
holds preparation for retry without consuming the payment permit. After fixing
the producer, retry the same payment claim; do not collect another payment.

`artifactAnchor` publishes native artifacts for the seller named by `writer`.
Its `publish({ logicalAddress, artifact, artifactKind, authorize })` must check
`authorize()` immediately before retaining a CREATE intent and must durably keep
the signed transaction before sending it. `readRetained({ logicalAddress,
artifactKind })` must authenticate the exact retained artifact, receipt, native
transaction reference and signed projection when returning `status: 'present'`;
`verifyReceipt` independently checks those bindings. Retain one logical record
per address; an uncertain send is reconciled from its original transaction.
The agent durably records `commitmentPublishAsked` before calling `publish`.
After that, a plain `absent` or `indeterminate` read holds the commitment. Only
the actual object returned by `provenUnsignedAbsence(reason)` (from
`src/dacs/native-dem-delivery-consumer.mjs`) authorizes another call to publish:
the operator must first prove from its complete durable publication and wallet
journals that no signed CREATE for this address can land. A missing name-index
entry, an RPC failure, or a copied/serialized proof is insufficient. A retained
attempt from an older version without this marker is conservatively treated as
already asked. Read-only recovery never initiates publication, even with proof.
Keep both journals across restart; losing or rolling them back invalidates the
proof. Without a valid proof after a failure before signing, the commitment
remains held until the operator can reconcile it.

The HTTP limiter is global (120 requests/minute, eight concurrent requests)
and includes unauthenticated traffic. Put the host behind a front end with a
per-client limiter so one client cannot exhaust the shared request budget.

## What the host does and does not do

- It fails closed on configuration: unknown options, a missing capability, a
  non-loopback host, a relative, shared or symlinked data directory, or a
  signer that does not control the Listing are refused before anything starts.
  The private stores also check every ancestor of the data directory: each must
  be owned by root or by this user and not be group- or world-writable, so the
  host does not start where `/` belongs to another user (for example some
  rootless containers or sandboxes).
  Job capacity counts saved sessions and active reservations. An unsaved
  reservation is reclaimed only when its holder is proven exited; live or
  unproven holders continue to reserve capacity.
  One live process owns a data directory (`seller-state.lock`): a second host,
  in this process or another, is refused; the lock of a process that is
  provably gone is taken over, and any doubt refuses until it is removed by hand.
- Every request must carry a buyer transport signature over its method, path
  and body, for this seller and Listing; unsigned or mismatched requests are
  refused before the agent runs. Effects are journaled before they run, so a
  restarted host answers a completed request again and reconciles uncertain
  work through the agent's retained state. A commitment retry first reads back
  the original CREATE and publishes again only with proof that nothing was signed.
  Agreement state reads use isolated retained snapshots; cached payment and
  delivery answers require current durable settlement credit (DACS-4 SB-2).
  A payment answer that is not final is not cached as final:
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
  paid order is not stranded by a failure the seller can retry; a first claim that ran again from its start
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
  submission and its fulfilment binding before it asks `nativeDemDelivery.submit`.
  A present CREATE restores that binding during reconciliation, including for
  earlier checkpoints without it; its payload and receipt still need fresh
  authentication before delivery is ready. A submission that
  fails before anything is signed, or a host that dies between the record and
  the call, leaves a record with no CREATE, and only the capability can tell
  that from a CREATE it signed and lost. Its `read` returns
  `provenUnsignedAbsence(reason)` (from
  `src/dacs/native-dem-delivery-consumer.mjs`)
  exactly when it can prove no signed CREATE for the address was sent or
  remains available to send; the agent then asks again, and the paid order is
  delivered with one CREATE. Any other answer (a miss, a lagging name index,
  an error, or a CREATE it signed that is not on the chain) holds the
  delivery and never submits again: a landed CREATE would be made twice. A
  `read` that never returns the proof strands a paid order after one failed
  submission. An operator-supplied `artifactAnchor` must return it from `read`
  for an address with no stored intent (`readRetained` reports plain absence
  there), and from both readers for a stored intent that carries no hash and
  no signed transaction when neither the source nor the seller's wallet
  retains a signed CREATE for the address: one a shutdown cut before it was
  signed (`closing`), one the wallet answered without signing (`unsigned`),
  and one the process died on while the wallet was asked (`intent`; the wallet
  journals a signature before it sends anything, so a signature it made but
  did not journal was never sent).
  Publishing such an intent again replaces it under the address's lock and
  asks the wallet once more. An operator's refusal (`denied`), a broadcast
  rejection, or any row with a hash or a signed CREATE is only read back. The
  proof rests on the artifact journal and the wallet journal being the ones
  that recorded the attempt: a journal lost, or restored from an older copy,
  after a Deliverable landed reads as never asked, and the order is submitted
  again (an operator-induced limit). The package's reference implementation,
  `createDevnetDemoArtifactAnchor` (`src/devnet-demo/artifact-anchor.mjs`),
  cannot be constructed in this snapshot: its constructor requires the opaque
  devnet-demo source capability, and `isDevnetDemoTransport` always returns
  `false` (`src/dacs/devnet-source.mjs`), so it refuses every input. Supply an
  anchor that enforces the contract.
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
    this address is or can still be executed; only this answer lets the agent
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
  transaction: of demosdk 4.0.16's `demosclass.js` `sign()` result, only those three members (its
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
  `readAccountNonce()` reads a non-negative account nonce or an authenticated
  `{ nonce, blockHeight }` snapshot. `readTransactionState({ txHash })` answers
  `'applied'`, `'pending'`, or `'absent'`. Applied means successful execution;
  inclusion alone does not establish execution. An ordinary miss or unknown
  answer keeps the original signed CREATE alive for rebroadcast. To release a
  CREATE whose nonce another transaction consumed, a qualified reader must
  return `{ nonce, blockHeight }` and
  `{ state: 'absent', checkedThroughBlock }` from a complete authenticated
  transaction index, including failed transactions, on the same chain.
  `checkedThroughBlock` must be at least the nonce snapshot's `blockHeight`.
  A bare nonce or an unfenced absence never authorizes supersession.
