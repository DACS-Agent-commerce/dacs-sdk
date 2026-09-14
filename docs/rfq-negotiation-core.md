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
);

if (opened.decision !== "pass") {
  throw new Error(opened.reason);
}
```

## Admitting channel messages

`admitChannelMessage()` applies the §8.3.3/CH-6 structural, channel-binding,
and monotonic-sequence gates. A mandatory adapter verifier authenticates the
sender signature and returns `pass`, `fail`, `indeterminate`, or `error`.

For a sender, `prepareChannelMessageSigningInput()` validates the unsigned
envelope and returns the same immutable envelope/hash pair. The adapter then
applies its steward-approved signature framing and attaches the signature.

The verifier receives an owned, deeply frozen message, the exact unsigned
envelope, and its lowercase-hex SHA-256 hash. The core deliberately does not
construct signature bytes. Current DACS prose, conformance vectors, and Demos
L2PS disagree about signature framing and encoding; that upstream decision is
tracked in DACS-Standard#349. Baking one private interpretation into this API
would make the other two incompatible.

## Advancing an RFQ

`advanceRfqSession()` first authenticates the channel message, then applies the
RFQ rules in one pure state transition:

- the Listing-selected initiator must send the first `offer`;
- members alternate, and a reply can bind the standing proposal with
  `refs.repliesTo`;
- `counter` prices must remain inside the inclusive, half-up Listing band;
- metered totals are recomputed from the Listing and canonical quantity;
- `accept` must name the exact standing proposal sequence;
- `maxTurns`, reject, abort, and trusted-receipt-clock timeout are terminal;
- terminal state cannot be reopened by replay.

```ts
const advanced = await advanceRfqSession(
  storedState,
  receivedEnvelope,
  trustedReceivedAt,
  adapter.verifyChannelMessage,
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
redrive only an authenticated `absent` result. A permanent transport rejection
or trusted-clock timeout is retained as a terminal lifecycle failure.

```ts
const buyerRfq = createDurableRfqLifecycleClient({
  role: "buyer",
  store: buyerAuthenticatedStore,
  transport: privateMemberTransport,
  reserveChannelId,
  signChannelMessage: buyerChannelSigner,
  verifyChannelMessage,
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
own signers. Receiving the buyer's valid Agreement proposal re-derives the
expected draft from the seller's accepted checkpoint, rejects substituted
terms, creates only the seller contribution, verifies both signatures, and
returns that detached contribution. Both roles end with the same finalized
Agreement; the buyer-side orchestrator then passes it and the exact accepted
checkpoint to `commitRfqAgreement()`.

`createInMemoryRfqLifecycleNetwork()` and
`createInMemoryDurableRfqLifecycleStore()` are deterministic local/test
implementations. The in-memory store is not a production authenticity or
restart boundary.

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
the accepted session and signed Agreement. `planRfqTranscriptDisclosure()`
then applies the Listing policy and permits encrypted publication only when
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
`negotiate-rfq` phase handler.
DACS-Standard#349 must resolve the current channel signature-framing conflict
before the adapter can safely choose a normative wire format.
