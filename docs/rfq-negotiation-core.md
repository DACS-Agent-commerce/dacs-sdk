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

## Carrying RFQ packets over Demos L2PS

`createDemosL2psRfqTransport()` adapts a structurally compatible demosdk
`L2PSMessagingPeer` to the durable lifecycle transport. It encrypts canonical
packet bytes with fresh-nonce AES-256-GCM, binds the sender peer, recipient
peer, and exact packet hash as authenticated data, and uses the packet ID as
the Demos message deduplication hash. The Demos subnet UID and reciprocal
ClaimReference/peer-key mapping are checked during history recovery.

```ts
const transport = createDemosL2psRfqTransport({
  peer: connectedAndRegisteredL2psMessagingPeer,
  codec: createDemosL2psRfqAesGcmCodec({ sharedKey: subnetKey }),
  l2psUid,
  localClaim: buyerClaim,
  localPeerKey: buyerPeerKey,
  peerForClaim,
  claimForPeer,
  onError: recordChannelFailure,
  outboxStore: authenticatedRoleLocalSendOutbox,
  sendAbsenceGraceMs: 60_000,
  operationTimeoutMs: 20_000,
  consumerTimeoutMs: 30_000,
});

const buyerRfq = createDurableRfqLifecycleClient({
  // ...buyer authority, signers, authenticated store and trusted clock
  transport,
});

transport.start((packet) => buyerRfq.receive(packet));

// After every start(), at process start or after a stop(), recover each peer
// and reconcile both directions before new policy work.
await transport.resumeInbound(sellerClaim);
await buyerRfq.resumeOutbox(jobId);
```

A Demos `submitted` or offline `queued` response acknowledges the exact packet.
The accepted payloads are exactly `{ messageHash, l2psStatus: "submitted" }`
and `{ messageHash, status: "queued" }`, with string fields and the matching
packet hash. `{ messageHash, l2psStatus: "failed" }` is indeterminate. Unknown
keys, including any `error` key, remain indeterminate. These are the shapes in
pinned demosdk 4.0.16 `build/instant_messaging/l2ps_types.d.ts:104-117`;
`L2PSMessagingPeer.js:116-126,319` returns `frame.payload` unchanged, without
the outer `type`, `requestId` or `timestamp` fields.

`outboxStore` is a required plain object with `load`/`save` data methods. It is
an authenticated, durable, role-local
companion to the lifecycle's signed-packet store, keyed by packet ID. Its
`load(packetId)` returns an entry or `undefined`; `save(packetId, entry)` must
atomically commit the supplied entry before resolving. Authenticate the key
and entry together, isolate buyer and seller authority, retain entries until
the job is retired, and serialize drivers of the same outbox across processes.
There is no volatile fallback. Read/write failure stays indeterminate, and a
failed pre-send write never calls the peer. The entry binds the packet ID,
peers, subnet and codec, and contains only the encrypted envelope, send state
and attempt end time; it stores no shared key. The exact `to`, encrypted
ciphertext/nonce/optional ephemeral key, and message hash are saved before
calling `peer.send()`, and retries reuse them. The demosdk sends that payload
unchanged (`L2PSMessagingPeer.js:119-124`); it still creates a fresh outer
request ID and timestamp. Byte identity refers to the message payload, not
those RPC metadata fields.

After an ambiguous response, `resumeOutbox()` searches authenticated Demos
conversation history, decrypts the stored frame, and compares the complete
canonical packet and route. It returns `absent` only when one unpaginated
history response is exhaustive. Timestamp-paginated history can prove presence
but cannot safely prove absence, so it remains `indeterminate` and never
authorizes a resend. `resumeInbound()` similarly replays history through the
normal lifecycle verifier; duplicate packets are harmless. Peer and codec
operations are bounded (20 seconds by default); a send timeout is
`indeterminate`, because the server may accept the packet after the local wait
ends.

After any ambiguous send, including a rejected peer promise or an unrecognised
acknowledgement, an empty history page cannot prove absence until
`sendAbsenceGraceMs` has passed since the local attempt **ended**. Until then,
reconciliation returns `indeterminate` with the fixed reason
"Demos L2PS history cannot yet prove packet absence after a timed-out send".
Presence can still acknowledge immediately. The grace is checked before the
history request, so a request begun during the grace cannot authorize redrive
by finishing after it. A refusal before the peer call (for example, a transient
seal failure) has no send marker and remains immediately retryable.

The default grace is 60,000 ms; configure a positive integer up to 600,000 ms.
This is a **provisional operational default**, twice the pinned demosdk's
15-second send wait plus 10-second history wait, rounded up to 60 seconds
(`L2PSMessagingPeer.js:126,151`). These client waits do not bound node inclusion
or history indexing. No node source or lag bound was supplied with this
snapshot, so the default's coverage of node lag has not been established;
verify it against the deployed testnet node before declaring this transport
ready. Arbitrarily delayed acceptance cannot be excluded by a finite grace.

The end timestamp is persisted in the send outbox. `monotonicNowMs` is an
injectable trusted clock; its default uses `process.hrtime.bigint()` in
milliseconds, with a common monotonic origin across process restarts on the
same machine boot. Supply a durable common-origin monotonic clock when moving
between machines or boots; a detected rollback starts and persists a new full
grace. A crash before the end write leaves a durable `sending` marker;
recovery starts one full grace from its first observation and persists that
time. Restarting again does not reset an already persisted end time. Do not
migrate a legacy ambiguous lifecycle entry without its companion send marker;
settle it first or seed a conservative `sending` marker through the host store.

| Situation | Extra hold before absence can authorize retry |
| --- | --- |
| Refusal before peer call | 0 |
| Ambiguous send, known end | At most 60 seconds (configured grace) from that end |
| Crash before end write, or detected clock rollback | One full grace from first recovery observation |
| Exact history match at any time | 0; acknowledge immediately |
| Paginated/failed history, or an unavailable outbox | Unbounded; stay indeterminate |

The hold itself adds at most the configured grace; the host's next
`resumeOutbox()` cadence adds its polling interval. With the default 20-second
operation limit, a successful single-page absence check and retry dispatch can
also spend up to 80 seconds on outbox read, history, retry outbox read and
pre-send write: at most 140 seconds plus the polling interval after a known
send end. This transport-only calculation excludes host lifecycle storage, the retry's
own send/acknowledgement wait and end write.
There is no finite whole-call bound for paginated history (a follow-up),
persistence failures, repeated failures or scheduling stalls.

Payloads from Demos are size-checked before they are copied or canonicalized:
a frame over the 16 MiB plaintext limit, a history page of more than 100
entries, or a page whose strings total more than 32 MiB is refused. A refused
live payload goes to `onError`; a refused history page makes reconciliation or
recovery `indeterminate`. If your frames are large enough to hit the page
budget, lower `historyPageSize`.

Live admission and capture run synchronously when the peer emits an event.
The serialized receive lane holds at most 100 events and 64 MiB, including the
event being processed. Each event is charged two bytes per string code unit
plus 1 KiB for record and queue metadata. These limits are fixed. Excess live
events are reported immediately through `onError` as a `TransientError` and
dropped; recover them from history with `resumeInbound()`.

Each consumer call, live or recovered, is limited to `consumerTimeoutMs`
(30 seconds by default, at most 600 seconds). The consumer receives
`{ signal }` as an optional second argument; the signal is aborted when the
call times out or when `stop()` retires its generation. A live call that times
out reports a `TransientError` ("Demos L2PS RFQ consumer timed out") through
`onError`, releases its share of the lane budget, and lets the next event
through. In `resumeInbound()`, a timeout stops recovery and returns
`indeterminate` with that reason. The transport ignores whatever a consumer
does after its timeout: no second delivery, no error report, no change to the
lane budget. A store write that the consumer still completes is harmless,
because the lifecycle records each received packet ID (which is also the Demos
message hash) once and treats a repeat as a duplicate.

`stop()` retires pending live and recovered deliveries; work still awaiting
decryption cannot deliver to a consumer registered by a later `start()`.
An already invoked consumer may finish. The outcome of a retired live call is
ignored, and recovery checks retirement again before delivering its next
packet. Each
`start()` gets a fresh receive lane, so a consumer call left over from a
retired generation cannot hold back the new consumer. The retired call keeps
its share of the 100-event and 64 MiB budget until it settles or times out.
`drain()` waits only for the current generation's lane.

Run `resumeInbound()` for each peer after any `start()`, not only at process
start. Live events that overflowed the lane, timed out in the consumer, or were
retired by `stop()` stay in Demos history and come back only that way.

Reconciliation only judges frames the local peer sent to the packet's
recipient; a counterparty frame that reuses the packet hash is ignored. A frame
of ours that decrypts to different bytes, or that the built-in AES-GCM codec
proves unauthenticated, is a terminal transport failure. A codec timeout or
error, or our frame recorded under a different subnet UID, stays
`indeterminate`, so a later `resumeOutbox()` can still settle it. All
decryptions in one reconciliation share a single operation timeout, so
duplicate history entries cannot multiply the wait; frames left unopened when
it runs out keep the entry `indeterminate` and are retried on the next
`resumeOutbox()`.

All frame decryptions in one `resumeInbound()` call also share one operation
timeout, starting at the first open and spanning every history page. Once it
is spent, recovery stops opening frames and returns `indeterminate`; valid
packets already recovered may still be delivered. Retry recovery when the
codec is available. Recovery never authorizes an outbox resend.

The AES-GCM codec cannot tell a tampered frame from a frame sealed under a
different key. If a process restarts with a wrong or rotated `sharedKey`, our
own frames fail authentication and every job whose outbox still needs
reconciliation fails permanently. Keep the previous key until those jobs have
settled.

A Demos `failed` submission status is `indeterminate`: the message may still
have reached the peer. A failed send acknowledgement without a matching history
entry follows the same grace and exhaustive-absence rule as any ambiguous send.
A matching failed history entry cannot prove absence, so it prevents automatic
resend even after the grace expires. The SDK currently has no call that clears
such a failed-history entry: `resumeOutbox()` keeps returning `indeterminate`, and
`sendAbort()` is refused while the counterparty owns the next turn. If
the counterparty did receive the packet, its reply still arrives through
`receive()` and the job continues, with the stale entry left `indeterminate`.
Otherwise the only remedy is to abandon the job: stop driving that `jobId` and
open a new job with a new `jobId` and `channelId`. Alert on outbox entries that
remain `indeterminate` across restarts. An operator redrive or acknowledgement
call is tracked as a follow-up.

The live receive path reports decryption, mapping and lifecycle failures only
through `onError`. The live Demos payload carries no subnet UID, so live frames
are bound to the subnet only by the codec key; history recovery also checks the
UID. A frame that failed live is recovered only by the next `resumeInbound()`,
so call it again after an `onError` report as well as on every start.

Use a dedicated RFQ subnet/peer conversation. The Demos messaging envelope has
no application content-type discriminator, so sharing the same encrypted
conversation with unrelated codecs makes history recovery ambiguous.

The SDK accepts a structural peer instead of importing a private demosdk path.
At demosdk 4.0.16, the only public `instantMessaging` export is the eager package
root, whose clean import currently fails on an undeclared dependency; the
focused public subpath fix is tracked in
[kynesyslabs/sdks#125](https://github.com/kynesyslabs/sdks/issues/125). Until
that package fix lands, the companion host must supply the connected peer. This
transport still delegates DACS channel signing and verification to the
lifecycle callbacks because the normative framing remains open in
DACS-Standard#349.

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

The SDK does not invent the still-undefined encrypted transcript publication
envelope or transcript-signature wire format. Live L2PS RFQ message encryption
is an SR-4 implementation choice and is handled separately above.
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
