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
The private package uses a core tarball built from the same checkout.

```js
import { startSellerHost, createOperatorBuyerAccess } from '@kynesyslabs/dacs-seller';

const host = await startSellerHost({
  signer,               // { claim: 'did:demos:agent:<hex>', sign(bytes) -> 64-byte Ed25519 signature }, synchronous
  listing,              // the signed Listing this seller serves; the signer must control it
  dataDirectory,        // absolute real path of a private (0700) directory owned by this user
  buyerAccess: createOperatorBuyerAccess({
    openBuyerAccess: true,
    buyerForJob,        // synchronous jobId -> retained buyer's 0x-hex wallet, or null for an unknown job
    buyerLookupReady,   // synchronous () -> true only after the operator's purchase lookup is attached
  }),
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
                         // readRevocationSurfaces, readRevocationMarker, readSessionRecipeRegistryPin? }: the
                         // seller-owned session admission, Vet record reader, receipt reader and receipt
                         // verifier, revocation readers, optional registry pin reader for presence-only
                         // Vet requirements (src/dacs/session-admission.mjs); admit must name both participants on the exact
                         // [PROFILE.json](PROFILE.json) profile: standardRevision
                         // d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20 and documentVersions
                         // CORE 0.3, DACS-1 0.7, DACS-2 0.6, DACS-3 0.5, DACS-4 0.8, DACS-5 0.5
  reconcilePaymentEvidence: journal.reconcilePaymentEvidence, // the same journal's answer for an evidence
                         // anchor that was sent or whose outcome is unknown ('unsigned' | 'rebroadcast' | 'pending')
  reconcileDeliverableCreate: deliveryJournal.reconcile, // optional: the Deliverable journal's answer for a
                         // submitted Deliverable that reads back as absent (below); nativeDemDelivery must be
                         // made with the same journal's `submit`
});
// journal = createPaymentEvidenceWalletJournal(...) (below); the host refuses any other pair.
// deliveryJournal = createDeliverableWalletJournal(...) (below); the host refuses any other pair.
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
`createSellerHttpHandler`, `createSellerTransportStore`,
`createSellerTransportServerAuth` and the buyer side `createSellerAgentClient`
and `createSellerTransportClientAuth`. The incomplete `createSellerAgent` constructor
stays outside the root API, as required by [PROFILE.json](PROFILE.json).
The kit's other modules are reachable
by path (`@kynesyslabs/dacs-seller/src/...`); they are not a stable API.

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
  Two private stores also check the ancestors of their own paths: the party
  Vet store requires each ancestor to be owned by root or by this user and not
  be group- or world-writable (a sticky root scratch directory is allowed),
  and the wallet journal refuses a non-sticky ancestor that others can write. The host
  checks only the data directory itself — a private, real, 0700 directory
  owned by this user — not its ancestors, so place it where no other user can
  replace it.
  The other durable and transport stores validate their immediate store directories.
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
  `@kynesyslabs/dacs-seller/src/dacs/native-dem-delivery-consumer.mjs`)
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
- Without the next option, a Deliverable CREATE the capability signed but did
  not broadcast (or that the node dropped) reads back as a plain absence, and the
  order stays held: only the capability's own journal could send it again.
  `createDeliverableWalletJournal({ path, signCreate, broadcast,
  readAccountNonce, readTransactionState })` is that journal, built as
  `createPaymentEvidenceWalletJournal` is (the same primitives, checks and
  nonce rule, in its own file with its own `journalId`; a file made for the
  other kind is refused). Its `submit` is the capability's `submit`: it signs
  once, keeps the exact signed CREATE before it broadcasts it, and answers
  `{ status: "accepted", reconciliationId }`. `signCreate` is asked for the
  Deliverable's CREATE (`artifactKind: "Deliverable"`, the report as
  `artifact`, and its `deliveryBinding`, which the CREATE's metadata must carry
  exactly). Pass its `reconcile` as `reconcileDeliverableCreate` (the host and
  `createSellerAgent` take the pair only from one journal, and refuse a
  wrapper, another journal or a scripted answer). The agent records the
  journal's id with the submission. When the Deliverable then reads back as a
  miss (absent, or the SR-2 adapter's name-index or native-address miss; not a
  failed or timed-out read) it asks `reconcile`:
  - `{ status: "rebroadcast" | "pending" | "applied", txHash }`: the one kept
    CREATE was sent again unchanged (not when it is applied), or is pending;
    the delivery is held until it reads back, and nothing is signed again;
  - `{ status: "unsigned" }`: no signed CREATE can still land (never signed, or
    superseded under the nonce rule above): the Deliverable is submitted once more
    through the journal, which signs one new CREATE;
  - a throw, another answer, or a journal that is not the one recorded with the
    submission (a lost or replaced file, or none recorded: `wallet_journal_changed`)
    keeps the delivery held with its cause.
  A submission the SDK recorded as accepted and whose CREATE can no longer land
  (superseded) is not signed again: it stays held with that cause.
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
  The journal keeps the signed CREATE and its nonce in its SQLite file (a
  private 0600 file) before it broadcasts it, and keeps at most one live signed
  CREATE per address. Its `readSignedProjection({ logicalAddress })` answers
  that CREATE's public projection, read only; the agent authenticates the
  evidence readback with it. The file has its own `journalId`: the agent keeps
  it with each anchor attempt and never asks another journal (a lost or
  replaced file) about that attempt, so such a file holds the claim (`held`,
  `reconcileError.code: "wallet_journal_changed"`) instead of signing a second
  CREATE; restore the file to resolve it. The journal also refuses
  (`wallet_journal_unknown_attempt`) an attempt whose `txHash` it never kept. While that CREATE can still be executed, the journal
  broadcasts the same signed bytes again (`rebroadcast`, or `pending` when the
  broadcast fails). The node never executes a transaction whose nonce the
  account has reached: it refuses it, or includes it as failed. So once the
  account nonce has reached the kept nonce (read first), and a complete
  authenticated index proves non-execution through that snapshot height, the
  journal marks it superseded (and keeps it). It then answers `unsigned`, and the next anchor signs the same evidence
  anew, with a higher nonce. A read that fails, times out (`readTimeoutMs`,
  10 s by default) or answers anything else never supersedes it. Timeouts and malformed
  replies stay held. A complete name/native-address miss can ask only the
  retained owning journal; the miss alone never authorizes a send.
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
  trusted steward did not sign is refused. During key rotation, configure
  `railAuthority.historicalStewards` as an array of distinct
  `{ stewardClaim, stewardPublicKey }` pairs from the operator's trusted key
  history. The same claim may have multiple historical keys. Keep each old identity while its sessions remain in flight. Those
  sessions reverify their exact signed pins under that identity after restart;
  new sessions always use the current steward and definition. Saved pins
  supply no trusted keys: a saved key selects only from that trusted history.
  Existing pins without explicit steward identity use their signed definition
  and the trusted key history for their claim.
- It opens a new session only for a presentation of a challenge it issued,
  on a Listing its own revocation check finds not revoked, and only under
  `sessionAdmission`, before anything of it is kept, read, signed or sent.
  - **Issuing.** `host.issueSessionChallenge({ jobId, buyer })` keeps a fresh
    256-bit nonce for that job and buyer, valid for ten minutes, before it
    returns `{ jobId, buyer, sessionNonce, issuedAt, expiresAt }`. The operator
    hands it to the buyer, whose bundle carries it as `sessionNonce` (CORE
    SN-1..SN-3; delivering the challenge to the buyer is up to the operator).
  - **Generation.** Only the seller generates the nonce, using its own CSPRNG.
    Supplying `sessionNonce` to the issuer is refused. The buyer copies the
    returned value into its bundle and signs afterward (CORE SN-1..SN-3).
  - **Consumption.** A presentation attempt for a new session consumes the
    nonce its bundle carries, durably and before the attempt is validated:
    before its signature, its buyer and job binding, the revocation check and
    `admit` (CORE SN-4, IBH-4). A refused attempt consumes it too, a `503`
    included, so after a refused attempt the buyer asks the operator for a
    new challenge. After an admitted one, the buyer sends the admitted
    presentation again (a new challenge would be another bundle, refused as
    `session_not_admitted`). Configuration, Listing validity and rail selection
    gates come first, as does a presentation with no session nonce
    (`session_not_admitted`, DACS-1 §6.3.2); those refusals consume nothing.
    Buyer-access and malformed-bundle refusals consume a recognized challenge.
  - **Later presentations.** Any later presentation that carries the nonce is
    refused (`session_not_admitted`): another one, a re-signed one, or one
    for another job. The presentation that was admitted is the one exception:
    sent again (a retry after a lost answer), it continues its own session,
    including after the challenge lifetime. Expiry bounds first admission.
  - **Refused before `admit`.** On first admission, a nonce the seller did
    not issue, one issued for another job or buyer, or an expired one is
    refused before `admit` is asked.

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
  and exact hash, an established observation, at `included` or `finalized` for
  Demos (`accepted` is allowed only by bindings with durable admission); none,
  one for another address or hash, an indeterminate
  observation, or a `submitted`, `rejected`, `dropped`, `replaced`,
  `expired` or `reorged` one refuses before the Agreement is signed
  (`VET_RECORD_UNVERIFIED`). The host checks what the receipt names and its
  state, then asks the operator's `verifyVetAnchorReceipt({ jobId, role,
  party, ref, record, receipt })` and signs only on the answer `'valid'`
  (CORE SR2-4: the receipt's fields alone are assertions, not proof); an
  `'invalid'` or `'indeterminate'` answer, any other value, or a throw
  refuses before any signature. The verifier authenticates the receipt's
  evidence against the chain, as the operator's reader does a revocation
  surface; the package does not do it, since the receipt may name any writer
  (SR2-5 binds the writer the receipt names, with no rule tying it to the
  record's signer). The record must be a CompositeVerificationRecord
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
  every required claim covered by a result for this job, except a
  presence-only claim (`verificationRequired: false`), which has no result
  (DACS-2 forbids a synthetic one). A presence-only member must name a
  registered claim scheme and select no `maxAge` or `recipeVersion`
  (DACS-1 PCR-1/PCR-2); one that does is refused like any other invocation
  mismatch. A presence-only requirement whose `primaryClaimSelector` names
  a claim without a passing verified result is also refused: the SDK's
  exact selector replay requires one, so the refusal reports
  `(invalid: aggregation-mismatch)`, not a presence success.
  Each record must
  also pass the SDK's strict CompositeVerificationRecord check against its
  invocation: its `requirementHash` is the hash of that exact requirement
  and its decision replays from the invocation's results (DACS-2 §7.7.1).
  A presence-only claim is counted in the party's exact bundle, whose
  presentation is verified, against the registry snapshot the operator
  pinned for the job: the optional `readSessionRecipeRegistryPin({ jobId })`
  returns its sha-256 hash (read once, only for such a requirement, with the
  other readers' byte, list and time limits). Without that reader, or with an
  answer that is not a hash, a presence-only requirement is refused; a reader
  that fails or times out makes the check indeterminate.
  The durable seller profile requires every claim in a bundle used for
  presence-only Vet to omit `expiresAt`. It refuses an expiring bundle before
  signing an Agreement contribution, so advancing the clock cannot invalidate
  a retained presence session. Core presence evaluation is unchanged.
  The agent restores only empty result invocations and refuses evidence-bearing
  invocations before replay. Supplying `sessionAdmission.vetEvidence` is rejected
  explicitly; presence replay does not enable verified-claim proposals.

  The direct `vetRecordProblem` helper separately accepts `evidence` for strict
  replay preparation: `resolveContent`, `resolveRecipe`,
  `isRecipeSignerAuthorized`, `isVerifyResultSignerAuthorized` and
  `verifyAuthorityAttestation`, plus optional `resolveLatestRecipe`. Each receives
  `{ jobId, role, party }`. Content replies are `null`, canonical JSON objects,
  or base64url bytes; recipe and result signatures, authority evidence and
  requirement parameters are independently checked by the core.
  `resolveLatestRecipe({ scheme, method, required })` returns the authenticated
  `{ sessionRecipeRegistrySnapshotHash, recipeVersion, availability }` selection
  or `null`. An implicit member is satisfied only by that family's selected
  latest live version. A result outside that version leaves the member
  unsatisfied; an independently passing pinned alternative may still satisfy
  its group.
  Every verified member, bound or unused, needs each method family at its
  version: an implicit family's selected head must be live; an explicit pin,
  bound or unused, needs an exact steward-authorized signed recipe that is not
  mocked, disabled or failed (DACS-2 CRQ-2/CRQ-3). A result at another version
  than an implicit member's selected head leaves that member unsatisfied,
  whether bound or projected.
  Malformed replies and inconsistent snapshot pins also refuse the whole record. Both party records share one snapshot pin, and a replay caches each
  family's bounded registry read and each exact recipe descriptor. No older live version is chosen as fallback.
  Reads retain their 64 KiB, value/list, 10 s individual and 30 s total limits;
  unavailable readers keep their original cause. These helper capabilities do
  not change the agent's invocation or restoration gate. A session
  in flight, signed under its pin, continues without a new admission or
  revocation check. The agent's startup check reads only the Listing's own
  bytes, signature and rail; revocation is checked per new session (above).
- The staged bilateral Vet provider retains the exact seller presentation
  signing bytes in its party Vet job row. An atomic reservation permits one
  signer invocation across providers. A failed or interrupted signer call or
  outcome save leaves that reservation pending; a retry never signs again.
  Completed presentations are verified before reuse. Unsigned rows from older
  versions have no safe reservation and remain held without another signer call.

  For the presentation, `wallet.signBytes(bytes, request)` receives a frozen
  request with `jobId`, `signer`, `reservation` and `signedBytes` (lowercase hex).
  A wallet that supports recovery must retain its signature under that identity
  before answering. Its optional read-only
  `wallet.reconcilePresentationSignature(request, { signal, maxBytes, timeoutMs })`
  returns raw JSON bytes of exactly `{ ...request, status: 'signed', signature }`.
  The provider admits at most 4,096 bytes before decoding and waits at most ten
  seconds. Remote adapters must enforce the byte limit before decoding their
  own wire replies and honor the abort signal. The recovered signature must
  verify for the exact retained bundle. Missing capability, unknown or absent
  outcome, mismatched identity, invalid signature, malformed reply or timeout
  returns `seller_presentation_indeterminate`; none permits another signature
  or challenge. A lost save acknowledgement reuses the completed job row
  without a wallet lookup. This changes no signed wire format or factory gate.
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
  payment evidence (`native_evidence_required`), so these capabilities and the supported Listing size are checked before
  commitment or payment intake. Actual delivery still depends on valid producer
  output and available operator capabilities. These
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
  with its seller state. Expired unattempted challenges may be reclaimed;
  accepted presentations retain their exact admission checkpoint for replay.
  Retired unsigned admissions release active capacity within bounded history.
  The operator issues challenges only for buyers about to present.
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

This checkout provides source modules. Build the core from the same checkout
before importing the seller source kit.

The rail availability checks implement DACS-4 RAV-R1 through RAV-R3 and
RAV-R5. The seller does not emit the RAV-R4 `errorClass: substrate` field.
The SR-2 fixture's genesis response (numeric block zero and a `confirmed`
status) is a simulation contract, not the pinned node's genesis RPC shape.

## Package checks

From the repository root, build and provision the locked smoke consumer before testing:

```sh
npm run build
npm run seller:prepare
npm run seller:test
```

Setup derives the consumer graph from `package-lock.json`, packs this checkout,
and installs the native SQLite binding. Tests use that prepared environment
offline and run every executable seller file once. Root `npm test` runs the
separate TypeScript suite. Existing unresolved stack failures still block a
complete seller-suite pass. For another setup, pass a directory to
`seller:prepare -- <path>` and set `DACS_SELLER_SMOKE_DIR` to it for tests: a
completed setup is reused, an interrupted or outdated one is rebuilt, and a
directory that is not a seller consumer setup is never replaced.
