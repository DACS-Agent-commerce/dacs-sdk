# RFQ negotiation core

The RFQ core implements transport-neutral DACS-3 channel admission, the bounded
turn state machine, a role-separated durable lifecycle, Agreement co-signing,
and the finalized commitment handoff. It does not open a Demos L2PS subnet or
choose the unresolved Demos channel-signature wire for the application.

## Opening a session

`openRfqSession()` derives all negotiation authority from the exact verified
Listing: participants, Listing pin, pricing model, initiator, `maxTurns`,
`timeoutSec`, and an optional pinned `channelSubnet`.

The second argument must durably and idempotently reserve the channel ID. A
reservation returns the DACS four-value decision:

- `pass`: this exact job/listing/member reservation owns the channel ID;
- `fail`: a prior or different session owns it;
- `indeterminate`: durable uniqueness cannot currently be established;
- `error`: the reservation check itself failed.

Only `pass` opens the session. Store the returned immutable state in an
authenticated durable store; a process-local `Set` is not a CH-6 reservation.

The third argument is the session's verifier-owned `RfqProfileAdmission`
(CORE §11.1.2(3); see "Advancing an RFQ"). It is checked after the input is
validated and before the reservation: without an admitted profile nothing is
reserved and no state is issued, with the same decisions as admission.

```ts
const opened = await openRfqSession(
  {
    jobId,
    verifiedListing,
    buyer,
    seller,
    channelId,
    startedAt: Date.now(),
  },
  async (reservation) => channelReservations.reserve(reservation),
  { profile: deploymentProfile, authority: sessionProfileAuthority },
);

if (opened.decision !== "pass") {
  throw new Error(opened.reason);
}
```

## Admitting channel messages

`admitChannelMessage()` applies the §8.3.3/CH-6 structural, channel-binding,
and monotonic-sequence gates. A mandatory adapter verifier authenticates the
sender signature and returns `pass`, `fail`, `indeterminate`, or `error`.

Channel messages follow DACS-3 v0.6 §8.3.3 (DACS-Standard PR #367, resolving
#349). A reader selects one of two operations structurally, before any
cryptography, and never falls back to the other for the same object:

- `current-read` (default) requires the exclusive
  `canonicalChannelMessageVersion: "1"` discriminator, a registered sender
  claim scheme, and the version-1 signature envelope
  `{ signatureVersion: "1", signer, algorithm, value }` with a SIG-6 unpadded
  Base64URL `value`. Unknown top-level members are retained in the signed
  scope (SIG-5). A signer that does not identify the sender (CF-3) is a CH-7
  `fail`. Every wire member, the discriminator and `refs` included, is read
  as an own property: a value inherited from a prototype neither selects the
  arm nor enters validation.
- `legacy-import` must be selected explicitly (`{ operation: "legacy-import" }`)
  and admits only the frozen historical Demos wire: no discriminator, the
  exact seven-member envelope, a bare 128-character lowercase-hex signature,
  and a sender in the frozen historical grammar (`cci:<64 lowercase hex>` or
  a pre-profile `did:<method>:<id>`, the Standard reference reader's
  `parse_historical_claim_ref`). New producers MUST NOT emit it.
- A `signature.signer` that does not parse under the current registered
  grammar is malformed input (`error`); only a well-formed signer that names
  another party is the CH-7 `fail`.

`current-read` also requires the CORE §11.1.2(3) corrective-profile
admission, passed as the verifier-owned `profileAdmission` option: the exact
profile the deployment runs (`releasePin` plus the complete `moduleVersions`
tuple), the authenticated CH-1 member set, and the `authority` resolved for
this session from trusted context outside the message and admission context.
Admission checks it before any message processing and has no default:

- no capability or no authority refuses the session as `indeterminate`;
- a malformed capability or authority, a partial or extended module tuple,
  duplicate participants, or `authenticated: false` is `error`;
- an authority for another session, release pin, module version or member set
  (compared by CF-3 identity) is `fail`.

Before any cryptography, `current-read` then requires the sender's CF-3
identity (canonical scheme and identifier) to occur in that member set (CH-7).
A sender outside it is `fail` and the verifier is never called; a missing set
is `indeterminate` and a duplicated or malformed one `error`, through the
profile checks above. A parameter-only variant of a member is that member.

`legacy-import` is the archival path of §11.1.2(4) and does not consult it.
It has no member set either, so on that arm the verifier owns the membership
check for the historical session.
The SDK decides all 51 non-SR-1 vectors of `canonical-channel-message-v0.6`
this way, including the seven `current-profile-*` vectors.

For a sender, `prepareChannelMessageSigningInput()` validates the unsigned
envelope and returns the immutable envelope, its lowercase-hex SHA-256 hash,
and the exact CH-8 `signedBytes`
`UTF8("dacs-canonical-channel-message:v1:") || ASCII(hex)`. It is
producer-side and therefore current-only: `legacy-import` is a reader
operation and CH-10 forbids emitting the historical wire, so no option can
select the `UTF8("dacs-channelmsg:v1:") || raw digest` framing here. The
adapter signs those bytes with the member's primary key and attaches the
envelope. It does not consult profile admission, because it is also the CH-8
hash of stored and received envelopes: a caller that signs its result must
admit the exact profile for the session first. The durable client does.

The verifier receives an owned, deeply frozen message, the exact unsigned
envelope, its hash, the same `signedBytes` and the selected operation. The
input is a union discriminated by `operation`: on `current-read` it always
carries the CH-1 `member` the sender resolved to, spelled as in the member
set; on `legacy-import` it carries no `member`. It verifies the signature over `signedBytes` (the CH-8 framing
for the selected operation), checks `operation`, and owns key resolution and
algorithm dispatch (Ed25519, ECDSA secp256k1, SR-1 aggregate) for that
member. The profile capability carries no keys or key types. It returns the
four-value decision. A `pass` result carries
the admitting `operation`, so a caller can keep historical audit state apart
from live negotiation state (§8.3.3) by checking the value itself.

## Advancing an RFQ

`advanceRfqSession()` first authenticates the channel message, resolves the
admitted sender to the matching member's primary claim (CH-7: parameter-only
ClaimReference variants name the same member and never select a different
one; `resolveRfqMember()`), then applies the RFQ rules in one pure state
transition. `expectedSender` and `standingProposal.proposer` always hold the
primary claim, whatever spelling arrived on the wire; the transcript
re-verifier resolves the same way.

- the Listing-selected initiator must send the first `offer`;
- members alternate, and a reply can bind the standing proposal with
  `refs.repliesTo`;
- `counter` prices must remain inside the inclusive, half-up Listing band;
- metered totals are recomputed from the Listing and canonical quantity;
- `accept` must name the exact standing proposal sequence;
- `maxTurns`, reject, abort, and trusted-receipt-clock timeout are terminal;
- terminal state cannot be reopened by replay.

The RFQ layer passes its own buyer and seller as the participants, so the
caller's `RfqProfileAdmission` carries only `profile` and `authority`. Without
it every turn is refused: admission runs before any state transition, so an
expired call without it returns no `timed-out` state. `openRfqSession()` refuses, before reserving the
channel, members whose claim scheme is not registered: `current-read` could
never admit their turns.

```ts
const advanced = await advanceRfqSession(
  storedState,
  receivedEnvelope,
  trustedReceivedAt,
  adapter.verifyChannelMessage,
  { profile: deploymentProfile, authority: sessionProfileAuthority },
);

if (advanced.decision === "pass") {
  await stateStore.put(advanced.state);
}
```

Persist a passing transition, `lastSequence`, and `lastMessageHash` atomically.
The latter is the canonical hash of the last authenticated unsigned channel
envelope and becomes the agreement's transcript hook. The sender-controlled
`sentAt` field never extends the per-turn timeout.

`rfqSessionCheckpointHash()` supplies a stable content key for a validated
checkpoint. It is not a MAC or signature and does not replace keyed local-store
authenticity.

## Running a durable buyer or seller

`createDurableRfqLifecycleClient()` owns the restart/replay boundary around the
pure reducer. Buyer and seller clients use separate stores and separate
agreement signers. Each exact signed turn or detached Agreement contribution
is added to a role-local outbox in the same compare-and-swap transition as its
new local state, before transport publication.

The injected store MUST authenticate persisted bytes and isolate role
authority. The injected transport returns `acknowledged` only after the exact
packet is durably accepted by the confidential member transport. If publish is
ambiguous, `resumeOutbox()` reconciles the original packet ID and bytes; it may
redrive only an authenticated `absent` result. Republication is an action under
the profile, so `resumeOutbox()` admits it first; without admission it returns
the refusal and leaves every pending entry as stored. A permanent transport rejection
or trusted-clock timeout is retained as a terminal lifecycle failure.

Every client operation on a current record, `getStatus()` included, admits the
session's profile once, before it compares, interprets or returns anything in
the record. A refusal is `rejected` or `indeterminate` and carries no record,
so a session whose authority is withdrawn yields no signed turn or Agreement
through the client. The store adapter itself is raw storage and admits nothing.

```ts
const buyerRfq = createDurableRfqLifecycleClient({
  role: "buyer",
  store: buyerAuthenticatedStore,
  transport: privateMemberTransport,
  reserveChannelId,
  signChannelMessage: buyerChannelSigner,
  verifyChannelMessage,
  // Resolves { profile, authority } for { role, jobId, channelId,
  // participantIdentities } once per operation: open, each turn sent,
  // respond (before its policy runs), each packet received, startAgreement,
  // resumeOutbox and getStatus. No authority, or a throw, refuses the
  // operation before anything is reserved, signed, published or stored, and
  // returns no record.
  profileAdmission: resolveSessionProfileAdmission,
  agreementSigner: buyerAgreementSigner,
  verifyAgreementContribution,
  nowMs: trustedClock,
});

await buyerRfq.open({
  jobId,
  verifiedListing,
  buyer,
  seller,
  channelId,
  selectedRail,
  payoutBindings,
});

await buyerRfq.sendOffer(jobId, proposal);
await buyerRfq.receive(authenticatedCounterpartyPacket);
await buyerRfq.sendAccept(jobId);
await buyerRfq.startAgreement(jobId);

// Call this after restart, before creating any new outbound effect.
await buyerRfq.resumeOutbox(jobId);
```

The seller uses the same factory with `role: "seller"`, its own store and its
own signers. Every `receive()` admits the profile before it compares the
packet with the record (a duplicate included) or looks at the packet kind.
Receiving the buyer's valid Agreement proposal re-derives the
expected draft from the seller's accepted checkpoint, rejects substituted
terms, creates only the seller contribution, verifies both signatures, and
returns that detached contribution. Both roles end with the same finalized
Agreement; the buyer-side orchestrator then passes it and the exact accepted
checkpoint to `commitRfqAgreement()`.

For a single-host production process, create the role-local authenticated
filesystem store before constructing the lifecycle client:

```ts
const store = await createFsDurableRfqLifecycleStore({
  dir: "/var/lib/dacs/buyer/rfq",
  role: "buyer",
  integrityKey: roleLocalSecretWithAtLeast32RandomBytes,
});
```

The directory must be absolute, local to one role, owned by the current user,
and mode `0700`; existing unsafe permissions are rejected rather than silently
changed. Record files are mode `0600`, authenticated with HMAC-SHA-256, written
with filesystem synchronization and guarded by cross-process compare-and-swap
locks. Keep the integrity key outside the directory and never share either the
directory or key between buyer and seller. Wrong keys, modified records,
symbolic-link substitution, rollback attempts, and non-append-only history fail
closed. Use a backend with equivalent keyed authenticity, exclusive creation,
atomic compare-and-swap, and generation fencing when multiple hosts can write.

`createInMemoryRfqLifecycleNetwork()` and
`createInMemoryDurableRfqLifecycleStore()` are deterministic local/test
implementations. The in-memory store is not a production authenticity or
restart boundary.

### Records written before the v0.6 channel wire

Records whose turns use the v0.6 `CanonicalChannelMessage` wire have
`storeVersion: 2` (`DURABLE_RFQ_LIFECYCLE_STORE_VERSION`). Records written
before it have `storeVersion: 1`
(`DURABLE_RFQ_LIFECYCLE_HISTORICAL_STORE_VERSION`) and hold the historical
envelope. The record version, never the message shape, selects how a stored
turn is hashed, and the version-1 reader checks the original bytes. Such a
record still loads, validates and is returned by `getStatus()` without a
resolver call (the archival read), so a finalized Agreement stays reachable. The pre-v0.6 session itself is abandoned
(CORE §11.1.2(4)): `open`, `send*`, `respond`, `receive`, `resumeOutbox` and
`startAgreement` return a non-retryable `rejected` without signing,
publishing, admitting or reconciling anything, and no store transition can
write a version-1 record. `open` loads the job first, so a version-1 record
is refused before the reservation or the profile resolver is called. After
admission it loads the job once more, and only a job that is still missing
reserves its channel. One window remains, because the store interface has no
reservation primitive: a version-1 record that another process creates between
that last load and `create()` is still refused, but only after one resolver
call and one reservation. Start a new session, with a new `jobId` and
`channelId`, under the current profile.


## Finalizing and committing an accepted agreement

`deriveRfqAgreement()` accepts only a validated `accepted` checkpoint and the
same exact verified Listing and post-Vet party bundles. It derives the price and
metered quantity exclusively from the accepted proposal, binds
`derivedFromChannel` to the admitted channel ID and `lastMessageHash`, and
builds the Listing-selected `AgreementDocument` or
`PayeeBoundAgreementDocument`.

`signRfqAgreement()` collects the required buyer and seller signatures over the
normative agreement domain. `commitRfqAgreement()` then verifies both party
signatures, rebinds the agreement to the accepted checkpoint and authenticated
commitment session, and uses the common SR-2 finality commitment engine. It
returns success only after an authenticated finalized receipt and the
receipt-time deadline/Listing-validity checks.

These three functions do not check profile admission. A caller MUST admit the
exact corrective profile for the session first (CORE §11.1.2(3)). The durable
client does so before it signs or finalizes an agreement; it does not publish
commitments.

```ts
const draft = deriveRfqAgreement({
  session: acceptedState,
  verifiedListing,
  buyer,
  seller,
  selectedRail,
  payoutBindings,
  generatedAt: Date.now(),
});

const agreement = await signRfqAgreement(
  draft,
  buyerAgreementSigner,
  sellerAgreementSigner,
);

const committed = await commitRfqAgreement(
  {
    agreement,
    verifiedListing,
    rfqSession: acceptedState,
    session: authenticatedCommitmentSession,
    createdAt: Date.now(),
    commitmentSigner: orchestratorSigner,
  },
  finalityProvider,
  verifySignature,
);
```

## Current boundary

`prepareRfqTranscript()` re-verifies the complete ordered private message set,
member turns, proposal bounds, exact acceptance and final-message hook against
the accepted session and signed Agreement, reading every turn with
`current-read` under the caller's `RfqProfileAdmission`. A transcript written
before the v0.6 channel wire (any turn without the discriminator) returns
`error` ("predates the DACS-3 v0.6 channel wire; it is archival only"): it is
never re-verified as current and cannot feed disclosure.
`planRfqTranscriptDisclosure()`, whose verifiers object carries the same
`profileAdmission` as an own member, then applies the Listing policy and permits encrypted
publication only when
every member's injected consent verifier returns `pass`. The default `none`
policy never invokes the verifier and retains the transcript privately;
recommended publication may be omitted, while required publication fails
closed.

The SDK does not yet invent a ciphertext or transcript-signature wire format.
DACS-Standard#351 tracks the missing normative `TranscriptSignature`, consent,
encryption-envelope, SR-2 address and receipt-binding definitions. Once that is
resolved, the verified transcript and disclosure plan can feed the conforming
encrypted publisher.

The live Demos L2PS adapter also remains separate. Until it lands, the SDK
supplies the complete transport-neutral, durable buyer/seller RFQ lifecycle,
agreement/commitment and transcript-policy core but not a complete live
`negotiate-rfq` phase handler. The channel wire itself is now fixed by
DACS-3 v0.6 (see "Admitting channel messages"); `@kynesyslabs/demosdk@4.0.16`
`l2ps.channel` still emits a historical shape and is not a conforming
producer (DACS-Standard#414).

## Changelog

Unreleased: DACS-3 v0.6 channel wire (breaking pre-v1 correction, CORE
§11.1.2).

- **Breaking:** `prepareChannelMessageSigningInput()` requires the
  `canonicalChannelMessageVersion: "1"` discriminator and throws without it;
  its result adds `signedBytes` (CH-8 bytes to sign) and `operation`.
  Producers sign `signedBytes`, not the hex hash.
- **Breaking:** `admitChannelMessage()` defaults to `current-read` and needs
  the verifier-owned `profileAdmission` option; the historical wire needs
  `{ operation: "legacy-import" }`. `advanceRfqSession()` and
  `prepareRfqTranscript()` take an `RfqProfileAdmission` argument,
  `planRfqTranscriptDisclosure()` verifiers a `profileAdmission` member, and
  `createDurableRfqLifecycleClient()` a `profileAdmission` resolver.
- **Breaking:** `DURABLE_RFQ_LIFECYCLE_STORE_VERSION` is now `2`. Records
  written by earlier SDK versions (`storeVersion: 1`) stay readable through
  `getStatus()`, including finalized Agreements, but are read-only: their
  sessions cannot continue and must be restarted. Pre-v0.6 transcripts are
  refused by `prepareRfqTranscript()` with `error`.
- **Breaking:** `openRfqSession()` takes an `RfqProfileAdmission` third
  argument and refuses, without reserving the channel, when the profile is not
  admitted. The durable client's `open()` resolves it before reserving, and
  loads the job again just before the reservation. A version-1 record created
  by another process after that load is still refused, but after one resolver
  call and one reservation; closing that window needs a store-level
  reservation primitive.
- **Breaking:** the durable client resolves the profile once per operation on
  a current record and admits it before it compares, interprets or returns
  anything in the record: every `send*`, `respond()` (before the policy is
  called), `receive()` (before the duplicate check and any packet kind,
  including the agreement proposal and contribution), `startAgreement()`
  (before its duplicate check), `resumeOutbox()` (before it reads, reconciles
  or republishes the outbox) and `getStatus()`. Local refusals such as a
  terminal session or the counterparty's turn now come after admission. A
  refusal signs, publishes and writes nothing and returns no record;
  `resumeOutbox()` leaves pending entries as stored.
- **Breaking:** `getStatus()` returns `DurableRfqLifecycleStatus`: the store's
  load result, or a `DurableRfqAdmissionRefusal` (`rejected` or
  `indeterminate`, no record) for a current record whose profile is not
  admitted. A version-1 record is still returned as `ok` without a resolver
  call.
- **Breaking:** `current-read` refuses a sender outside the profile
  capability's CH-1 member set as `fail` before calling the verifier (CH-7).
  `ChannelMessageSignatureVerificationInput` is now a union discriminated by
  `operation`: `current-read` carries a required `member`, `legacy-import` no
  `member`. It is a type alias, no longer an interface, so an adapter type
  that `extends` it must use an intersection instead.
- **Breaking:** `advanceRfqSession()` admits the profile before any state
  transition: an expired call without admission is refused and returns no
  `timed-out` state.
- **Breaking for verifier adapters:** verify the signature over `signedBytes`
  (the CH-8 framing of the selected operation), not over the hash, and check
  `operation`. `ChannelMessageSigningInput` gains the required `signedBytes`
  and `operation` fields, and `ChannelMessageSignatureVerificationInput` the
  required `signedBytes` and `operation` fields.
- **Breaking for custom store adapters:**
  `DurableRfqLifecycleRecord.storeVersion` is now the union `1 | 2`. An
  adapter that accepts only `DURABLE_RFQ_LIFECYCLE_STORE_VERSION` reports every
  existing record as unsupported; accept both versions to keep version-1
  records readable.
- `prepareChannelMessageSigningInput()`, `deriveRfqAgreement()`,
  `signRfqAgreement()` and `commitRfqAgreement()` do not check profile
  admission; callers must admit the profile first (CORE §11.1.2(3)).
- `current-read` reads every wire member as an own property: an envelope whose
  discriminator is only inherited is refused, and an inherited `refs` is
  ignored. `planRfqTranscriptDisclosure()` reads `profileAdmission` only as an
  own member.
- `durableRfqLifecycleRecordViolation()` returns a violation for any input
  instead of throwing, and checks every transcript turn against the record
  version. The filesystem store's `create()` and `compareAndSwap()` return
  `corrupt` for such candidates, including `null` and other non-objects.
- `openRfqSession()` refuses members with unregistered claim schemes.
- `canonicalChannelMessageSignedBytes()` and
  `legacyChannelMessageSignedBytes()` throw unless given 64 lowercase hex
  characters, and return an unpooled `Uint8Array`.
