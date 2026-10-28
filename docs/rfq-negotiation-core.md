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

Either member records the RFQ-4 timeout (CH-4, CH-5 (c)). The member whose turn
it is records it when it tries to send late. The member waiting on the
counterparty records it with any send call, such as `sendAbort()` or
`respond()`, once the counterparty's turn timeout has passed on its trusted
clock: the call answers `rejected` with "RFQ turn timeout elapsed (RFQ-4)" and
stores the `timeout` failure without signing or publishing anything. Before
the timeout has passed, the waiting member's send is refused with
"counterparty owns the next RFQ turn" and nothing is stored. A turn received
after the timeout records it too.

The agreement exchange after acceptance (DACS-3 §8.4.2 steps 4–5) has the same
timeout. Acceptance sets `awaitingSince` to its trusted receipt time on each
member. The buyer's proposal is due `timeoutMs` after that, and the seller's
contribution `timeoutMs` after the buyer generated the proposal's plan. Once
the step a member waits on is overdue, `sendAbort()`, any other send call, or
`startAgreement()` answers `rejected` with "RFQ agreement timeout elapsed
(RFQ-4)" and stores the `timeout` failure; the session stays `accepted` and
nothing is signed or published. `startAgreement()` reads the trusted clock
and uses that one reading both for the deadline and as the new plan's
`generatedAt`; if the clock fails it answers `indeterminate` and signs
nothing. After acceptance, a
clock fault on a send call is `indeterminate` too, until the agreement is
finalized. A send call on the member's own overdue turn records the timeout
before the channel signer is called. A proposal the seller receives after its
deadline (`timeoutMs` after its own acceptance) records the timeout before the
seller signs anything. The seller reads its trusted clock again once its
agreement signer and verifier have settled, and compares it with its
contribution's deadline: `timeoutMs` after the plan's `generatedAt`, which the
buyer's contribution has just been verified to sign, and the same deadline
the buyer waits on. If that has passed, it records the timeout instead of
finalizing and publishes no contribution; until then it finalizes, even after
the proposal's deadline. Before calling its signer, the seller verifies and
durably stores the buyer's proposal. A signer or clock fault answers
`indeterminate` and preserves that step for retry after restart; timeout
drivers then use the contribution deadline. The seller also
never countersigns a plan the buyer dated after the seller's deadline,
but that date is the buyer's clock: `receive()` answers `rejected` with "buyer
dated the RFQ agreement plan after the seller's deadline", calls no verifier
and stores nothing. Only the seller's own trusted clock records the timeout,
so a buyer clock running ahead cannot end the job early. Such a buyer cannot
make a plan the seller will sign, so the
job ends in the RFQ-4 timeout at the seller's own deadline. With clocks in
step this never happens: a plan dated after the seller's deadline also
arrives after it. Keep both members' trusted clocks within a small fraction
of `timeoutMs` of each other.

A record accepted by an SDK before this rule kept the last proposal's time in
`awaitingSince`. When the versioned `agreementTimeout` marker is absent, the
saved local `updatedAt` conservatively bounds acceptance time. The next write
persists that time once, so later writes never extend the proposal window.
New acceptances persist their exact local acceptance time. A contribution
the buyer receives late still finalizes while the buyer has recorded no
timeout, because the seller finalized when it sent it; after the buyer has
recorded one, it is refused, and the two records disagree, as any timeout
race can leave them.

`receive()` returns `rejected` only as its answer about the packet: it is
malformed or misrouted; its job does not exist, has failed, or is stored
corrupt or in an unsupported version; its RFQ turn timed out; or the turn, plan
or counterparty contribution is refused. It returns `indeterminate` instead,
stores nothing, and the same packet can be received again, when:

- the store's `load` throws or reports `unavailable`;
- the trusted clock, the channel signature verifier, the agreement signer or
  the contribution verifier throws, cannot decide, or answers something
  malformed;
- the stored session does not validate, or the clock reads earlier than the
  session's `awaitingSince` (it is behind);
- the role's own agreement contribution does not verify, for example because
  its signer used a stale or wrong key. Only an invalid counterparty
  contribution is `rejected`.

A verifier should answer `fail` or `invalid` for bad counterparty input and
throw only for its own faults: one that throws keeps that packet
`indeterminate` on every retry.

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

Two constructors adapt a structurally compatible demosdk `L2PSMessagingPeer`
to the durable lifecycle transport. Both encrypt canonical packet bytes with
fresh-nonce AES-256-GCM, bind the sender peer, recipient peer, and exact
packet hash as authenticated data, and use the packet ID as the Demos message
deduplication hash. The Demos subnet UID is checked during history recovery.
They differ in who answers for the member binding and the node:

- `openDemosL2psRfqTransport()` checks them itself (see "The checked
  transport" below). Use it.
- `createUnverifiedDemosL2psRfqTransport()` takes the host's word. Its
  `peerForClaim` and `claimForPeer` callbacks are the claim-to-messaging-key
  binding, and it checks only that the two agree. It checks neither the
  node's build nor that the recipient registers on the same node. It is for
  a host with its own verified binding profile, such as one for members whose
  claims are not `did:demos:agent` keys.

This is a low-level transport primitive, not by itself a conforming DACS-3
SR-4 channel. It does not provide:

- the whole §8.3.2 membership binding. The checked transport binds each
  member's claim to the messaging key its frames are routed to and accepted
  from (below), but it does not check the anchored, CCI-signed "L2PS subnet X
  membership = CCI Y" attestation (demosdk 4.0.16 ships
  `l2ps.binding.createMembershipBinding`, `verifyMembershipBinding` and
  `resolveMember`). Those helpers accept only demosdk's own `demos:` claims,
  which are not a DACS-1 scheme: `createMembershipBinding` refuses any other
  ClaimReference scheme and `verifyMembershipBinding` answers false for one.
  With the unverified transport, the host MUST derive both callbacks from
  verified membership evidence, including an authenticated binding of each
  member to the messaging key it registers; `resolveMember(channelId,
  subnetMemberId, rpcUrl)` maps a subnet member ID to a claim, not to a
  messaging key. A member whose primary claim uses another DACS-1 scheme
  needs a host binding profile for that scheme; until the host has one, it
  cannot bind that member and MUST NOT start the transport for it. Never fill
  either callback from an unauthenticated directory: a reciprocal pair of
  wrong answers routes the RFQ to the wrong messaging key, where any holder
  of `sharedKey` can read it.
- the §8.3.4 member acknowledgement. An acknowledgement here is the node's
  statement that it stored the frame (below), not a receipt from the other
  member. The member waiting on a reply detects a silent or censored channel
  through the RFQ-4 timeout instead, during the turns and during the
  agreement exchange: once it has elapsed, `sendAbort()` records the timeout
  as the job's terminal failure (above). A terminal reject or abort expects
  no reply, so its receipt by the other member is never confirmed: that
  member ends in its own RFQ-4 timeout instead. Treat an `acknowledged`
  outbox entry as "stored by the node", never as delivery; any SR-4 delivery
  or quorum claim needs a host phase handler that collects member receipts.
- detection of contradictory views from different sources (§8.3.4), such as
  an operator that shows each member a different history. The agreement
  catches a split only at agreement time: the seller re-derives the plan,
  whose transcript hook is the hash of its own last accepted turn, and
  refuses a buyer plan that differs, so no Agreement is made and the job ends
  in the timeout. Nothing records the fork itself as evidence.
- a normative channel-signature profile. Signing and verification stay with
  the lifecycle's callbacks until DACS-Standard#349 settles the framing.

`createDemosL2psRfqAesGcmCodec()` frames are this SDK's own format: they do
not interoperate with demosdk's `L2PSChannelTransport` or the node's own
encryption helpers. Every holder of `sharedKey` can read the RFQ (CH-2). If
the subnet key is held by anyone besides the two channel members, such as
other subnet members or nodes that take part in the subnet, use a key that
only the two members hold.

### The checked transport

`openDemosL2psRfqTransport()` resolves only once all of these hold. Otherwise
it throws `DemosL2psRfqDeploymentError` or `DemosL2psRfqPeerChannelError`,
each with a `code`, before any peer call:

- Every member is a parameter-free DACS-1 §6.3.1 `did:demos:agent:<key>`
  claim, and its messaging key is that claim's own Ed25519 key, the key the
  SDK's agents already sign with. Node `61b8e75` registers a key only after it
  verifies a signature by that key over `register:{publicKey}:{timestamp}`,
  under the node's configured signing algorithm, Ed25519 by default
  (`L2PSMessagingServer.ts:154-170`), so
  only the claim's holder can register under it and receive what is routed
  there. There are no `peerForClaim`, `claimForPeer` or `localPeerKey`
  options to get wrong. `localClaim` must be such a claim (`local-claim`). A packet for a
  counterparty claim that is not one is refused before anything is sealed
  (`rejected` when it was never sent), and an inbound frame is accepted only
  from the key of its packet's sender claim.
- The peer exposes `config.serverUrl`, `config.publicKey` and
  `config.l2psUid` as own data properties, as demosdk 4.0.16 does, and has
  `requestPublicKey()`. The URL must pass the channel rule below; there is no
  `peerChannel` statement, so a peer that hides its URL is refused
  (`unstated`). The URL names its node by scheme, host, port and path only:
  credentials, a query or a fragment, even an empty `?` or `#`, are refused
  (`node-url`), because the exact URL is the node's identity (below). The peer
  must register the local claim's key (`peer-key`) on `l2psUid` (`subnet`).
- The peer can never dial, or register as, anything else. demosdk 4.0.16
  keeps the caller's `config` object in a writable property and reads
  `serverUrl`, `publicKey` and `l2psUid` from it again on every reconnect
  (`L2PSMessagingPeer.js:37,223,292-299`), so a host that kept the object, or
  replaced `peer.config`, could move an open transport to another node. The
  checked transport requires `config` to be frozen and the peer's own `config`
  property to be neither writable nor configurable (`mutable-peer`).
- `nodeInfo()` returns the node's `getNetworkInfo` response, and it reports
  `nodeVersion.commit` `61b8e75aa8db5e408c49e1c3a89db4d673f45578` with
  `nodeVersion.dirty` `false` (`node-build`). A read that throws or exceeds
  `operationTimeoutMs` is `node-unavailable`. With demosdk, pass
  `() => demos.nodeCall("getNetworkInfo")`: it reads the node on every call,
  and it returns a failed call as a value, which fails the check.
  `demos.getNetworkInfo()` keeps its first answer for the instance's lifetime.

Once open, the checked transport also checks:

- before every send, that the node answers `request_public_key` with the
  recipient's key (`L2PSMessagingServer.ts:373-396`), that is, that the
  recipient is registered on that node under the same subnet. Node `61b8e75`
  acknowledges a send to any other key as `queued` and relays nothing between
  nodes (below), so without this check two members on different nodes would
  see every send acknowledged and none delivered. Otherwise `publish` answers
  `indeterminate` with "Demos L2PS RFQ recipient is not registered on this
  messaging node", or "Demos L2PS RFQ recipient registration check failed"
  when the node gives no answer, and nothing is written to the send outbox
  or sent. The packet stays retryable: `resumeOutbox()` sends it once the
  recipient has registered on that node, and the RFQ-4 timeout ends a job
  whose counterparty never does. A recipient that disconnects between the
  check and the send is queued on that node and receives the frame when it
  registers there again.
- before every resend, that `nodeInfo()` still reports that clean build: a
  resend's safety rests on that node's unique message hash (below).
  Otherwise `publish` answers `indeterminate` with "Demos L2PS RFQ node did
  not confirm the reviewed clean build; nothing is resent". A first send
  does not read the node again.
- that a resend goes through the node that took the frame. Each send outbox
  entry records, as `node`, the exact URL its frame was handed to (in WHATWG
  serialization, so `WSS://Host:443/p` and `wss://host/p` are one node, and
  `wss://host/a` and `wss://host/b` are two). Dedup and history are per node
  database, so absence anywhere else never authorizes a resend: the entry stays
  `indeterminate` with "Demos L2PS RFQ packet was sent through another
  messaging node" (our frame in that history still acknowledges) until the
  transport is opened on the original URL again. The unverified transport
  binds no node, so it never resends such an entry either, and the checked
  one never resends an entry the unverified one wrote.

It cannot check whether TLS certificate checks are on, that `nodeInfo`
reads the node behind the peer's URL, or that one URL always reaches the same
node database: the messaging protocol carries no node identity, and the
node's report is its own unsigned statement. The host MUST NOT put a URL in
front of more than one node database (DNS or load-balancer failover between
nodes that do not share it); give each node its own URL. What the node
says stays unsigned too (the acknowledgement authority, below), and the
installed demosdk files are the host's to check (below).

```ts
// serverUrl wss:// (or ws:// to 127.0.0.1 or [::1]) with no credentials,
// query or fragment; publicKey the local claim's key; l2psUid as below.
const peer = new L2PSMessagingPeer(Object.freeze({ serverUrl, publicKey, l2psUid, signFn }));
Object.defineProperty(peer, "config", { writable: false, configurable: false });
await peer.connect();

const transport = await openDemosL2psRfqTransport({
  peer,
  codec: createDemosL2psRfqAesGcmCodec({ sharedKey: subnetKey }),
  l2psUid,
  localClaim: buyerClaim, // did:demos:agent:<the peer's publicKey>
  nodeInfo: () => demos.nodeCall("getNetworkInfo"), // the peer's node
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

`createUnverifiedDemosL2psRfqTransport()` is synchronous and takes the same
options without `nodeInfo`, plus `localPeerKey`, `peerForClaim`,
`claimForPeer` and an optional `peerChannel` (below). Of the checks above it
applies only the channel rule, once, at construction; it accepts a peer whose
config can still change.

A Demos `submitted` or offline `queued` response acknowledges the exact packet.
The accepted payloads are exactly `{ messageHash, l2psStatus: "submitted" }`
and `{ messageHash, status: "queued" }`, with string fields and the matching
packet hash. `{ messageHash, l2psStatus: "failed" }` is indeterminate. Unknown
keys, including any `error` key, remain indeterminate. These are the shapes in
pinned demosdk 4.0.16 `build/instant_messaging/l2ps_types.d.ts:104-117`;
`L2PSMessagingPeer.js:116-126,319` returns `frame.payload` unchanged, without
the outer `type`, `requestId` or `timestamp` fields.

The injected `peer`, its WebSocket channel and the node behind it are the
acknowledgement authority. An acknowledgement is that node's unsigned statement
that it saved the message. On Demos node `61b8e75` (paths under
`src/features/l2ps-messaging/`), the server sends the `message_sent` or
`message_queued` frame only after the messaging service has stored the row
(`L2PSMessagingServer.ts:262-270,279-294`), as plain JSON
(`L2PSMessagingServer.ts:471-473`). demosdk matches that reply to the request
only by frame type and `requestId` (`L2PSMessagingPeer.js:116-126,311-321`).
Nothing signs it, and the transport checks only its shape and that the echoed
`messageHash` is the packet ID. A stored acknowledgement is final (see below),
so a node that lies, a faulty peer object, or anyone who can rewrite frames on
an unauthenticated link can make the transport stop resending a message the
recipient never received.

The host MUST therefore connect the peer over authenticated `wss://` (TLS with
certificate checks) to a node it trusts, and MUST use that same node for
history and reconcile. Both members MUST register on the same messaging node
(or on nodes that share its database) under the same subnet UID. Node
`61b8e75` answers a send to any key that is not registered there with
`message_queued`, which acknowledges the packet, and delivers queued rows only
to a peer that later registers on that node (`L2PSMessagingServer.ts:259-294,
429-465`); nothing relays between nodes. If each member used a node of its
own, every send would be acknowledged and none delivered. The checked
transport refuses such a send before it is made (above); with the unverified
transport, keeping both members on one node is the host's job. Node `61b8e75` itself
serves plain WebSocket (`Bun.serve` with no TLS options,
`L2PSMessagingServer.ts:51-69`), so a remote node needs a TLS-terminating
proxy in front of it. Plain `ws://` is acceptable only to a loopback IP
literal: `127.0.0.0/8` or `[::1]`.

Both constructors check this when they build the transport. demosdk 4.0.16 declares the
peer's configuration `private` (`L2PSMessagingPeer.d.ts:28-29`), but that only
binds the compiler: at runtime `config` is an own data property, and
`config.serverUrl` is the URL the peer dials on every connect and reconnect
(`L2PSMessagingPeer.js:37,223`). It is not public API, so the transport reads
it defensively, through own data properties only: no getter or proxy trap
runs, and no prototype is consulted. It then applies one rule:

- `wss://` is accepted.
- `ws://` is accepted only to a loopback IP literal, `127.0.0.0/8` or `[::1]`,
  as parsed by the WHATWG URL parser that WebSocket clients also use.
  `localhost` is refused, whether exact, with a trailing dot or as a suffix:
  it is a name that `/etc/hosts` or DNS maps, so the URL alone does not show
  where the socket goes. Write `ws://127.0.0.1:3006` or `ws://[::1]:3006`
  instead of demosdk's `ws://localhost:3006` example.
- Anything else is refused: another scheme, a string that does not parse, or
  a `serverUrl` that is readable but is not a string.

The checked transport refuses a peer that does not expose a readable
`config.serverUrl`. For the unverified transport, such a peer, for example a
host wrapper, must state its channel with `peerChannel: "wss"` or
`peerChannel: "loopback"`. `"loopback"` means plain `ws://` to `127.0.0.0/8`
or `[::1]`, and it is the only way to allow plain WebSocket for such a peer.
Without a readable URL or `peerChannel`, construction fails. When the URL is
readable, it decides, and a `peerChannel` that does not match it is refused.
If a later demosdk 4.x moves the field, a demosdk peer counts as hiding its
URL: the checked transport then refuses it, and the unverified one until the
host sets `peerChannel`.

Every refusal throws `DemosL2psRfqPeerChannelError`, whose `code` is
`unstated`, `malformed`, `insecure` or `mismatch`. Its message never repeats
the URL, which may carry credentials.

The check has limits. It runs once, at construction, so for the unverified
transport a URL changed later is not rechecked; the checked transport refuses
a peer whose URL can change (above). It cannot see whether TLS certificate checks were turned off,
and `peerChannel` is only the host's statement. Above all, TLS authenticates
the channel to the node, not what the node says: an acknowledgement stays the
node's unsigned statement. A node-signed receipt that the transport could
verify is the longer-term fix.

`outboxStore` is a required plain object with `load`/`save` data methods. It is
an authenticated, durable, role-local
companion to the lifecycle's signed-packet store, keyed by packet ID. Its
`load(packetId)` returns the last committed entry or `undefined`. Every
`save(packetId, entry, expectedGeneration)` is a compare-and-swap: commit the
entry only if the stored entry's `generation` (0 when there is no entry)
equals `expectedGeneration`, and resolve `true`; otherwise change nothing and
resolve `false`. An expected generation of 0 matches only when no entry
exists; a present entry with a missing or invalid generation never matches. `entry.generation` is always `expectedGeneration + 1`, so the
first entry for a packet has generation 1. The compare must run atomically
with the write at commit time (for example a conditional `UPDATE ... WHERE
generation = ?` or an `INSERT` that fails on an existing key), not when the
call starts. The transport stops waiting for a slow save after
`operationTimeoutMs`, and that save may still commit later; the compare is what
stops such a late write from replacing a newer generation. A new frame is
stored only where no entry exists, and every later save carries the same
frame, so once any peer call could have used a frame, every resend uses the
same bytes. Authenticate the key
and entry together, isolate buyer and seller authority, retain entries until
the job is retired, and serialize drivers of the same outbox across processes.
There is no volatile fallback. An in-memory store, like the test suite's,
loses the grace and the identical-bytes guarantee on every restart, and the
SDK cannot detect one; it is unsupported. Read/write failure, a refused compare or a
timed-out write stays indeterminate, and a pre-send write that is not
confirmed never calls the peer. Any `save` result other than `true`,
including the `undefined` of an older `save(): void` store, counts as a
refused compare. The entry type is not exported; a host store can name it as
`Parameters<DemosL2psRfqTransportOptions["outboxStore"]["save"]>[1]`.
The entry binds the packet ID,
peers, subnet and codec, and contains only the encrypted envelope, send state,
generation, attempt end time and, for the checked transport, the exact node
URL, which never carries credentials, a query or a fragment (the transport
refuses such a URL); it stores no shared key. The exact `to`, encrypted
ciphertext/nonce/optional ephemeral key, and message hash are saved before
calling `peer.send()`, and retries reuse them. The demosdk sends that payload
unchanged (`L2PSMessagingPeer.js:119-124`); it still creates a fresh outer
request ID and timestamp. Byte identity refers to the message payload, not
those RPC metadata fields.

This version cannot read any send outbox entry written before generations
existed, that is, any entry without a positive integer `generation`. This
applies to every such entry, not only to entries with non-canonical peer keys
(below). `publish` and `reconcile` return `indeterminate` with "Demos L2PS
RFQ send outbox is unavailable" and never read history for that packet, even
when history holds the frame. The transport has never been released, so no
migration is provided. Settle the pending sends of a job before upgrading, or
handle a job left with such an entry like one with a failed history entry
(below).

Peer keys are compared in the node's canonical form. Demos node `61b8e75`
stores, queries and delivers `from`/`to` keys lower-cased with any `0x`
removed (`src/features/l2ps-messaging/keys.ts:13-16`), and registers only hex
keys of at least 64 digits. The transport captures `localPeerKey`, every key
returned by `peerForClaim`, and every inbound and history key in that form, and
calls `claimForPeer` only with canonical keys. A mapping that returns
`undefined` (or `null`), like one that throws, has no answer yet, for example
a directory that has not loaded after a restart. `publish` and `reconcile`
then return `indeterminate`, nothing is sent, and `resumeOutbox()` retries once
the mapping answers. A `claimForPeer` that knows only `0x` or upper-case keys
returns nothing for the canonical key, so sends to that claim stay
`indeterminate` and are never sent. Only a wrong answer refuses a packet: a
value that is not a hex key, the local key, or a key that `claimForPeer` maps
to a different claim. Even then, `publish` returns `rejected` (a terminal
transport failure for the job) only if this transport never stored a frame for
the packet, and so never sent it; otherwise it, like `reconcile`, stays
`indeterminate`, because the packet may already have been delivered. The
transport cannot check the mapping when it is constructed, because it does not
know the remote claims; check it before going live. A key that is not hex of at
least 64 digits once `0x` is removed is refused. The route in the AES-GCM
authenticated data and in the send outbox entry also uses the canonical keys. No signed bytes change, because
packets carry claims, not peer keys. A caller who passed `0x` or upper-case
keys to an earlier build of this unreleased transport sealed frames under the
raw keys; those frames and outbox entries no longer bind and stay
`indeterminate`. A receiver on the node could not open them anyway, because it
sees the canonical sender key.

After an ambiguous response, `resumeOutbox()` searches authenticated Demos
conversation history, decrypts the stored frame, and compares the complete
canonical packet and route. It returns `absent` only when one unpaginated
history response is exhaustive. Timestamp-paginated history can prove presence
but cannot safely prove absence, so it remains `indeterminate` and never
authorizes a resend. History is per peer pair across all jobs and the node
never deletes a row, so once two agents have exchanged more than one page
(`historyPageSize`, 100 rows by default) in their lifetime, absence can never
be proven between them again: a send that never reached the node, such as
one refused during a demosdk reconnect, is then never resent, and the job
ends in the RFQ-4 timeout. This does not hold back a packet the transport
never handed to the peer. The confirmed pre-send write precedes every peer
call, so a packet with no send outbox entry was never sent: `reconcile`
answers `absent` for it at once, without reading history, and the next
`publish` sends it however long the pair's history is. `resumeInbound()` similarly replays history through the
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
seal failure) has no send marker and remains immediately retryable
(`reconcile` answers `absent` for it without reading history, above).

When `peer.send()` rejects with anything but the node's "Duplicate message"
refusal (below), `publish` returns `indeterminate` with the reason "Demos L2PS
RFQ send outcome is unknown: " followed by the error's own `message`, so an
operator can read what the peer or node said. The text is read without running
a getter, any URL in it is replaced with `<url>` because a URL may carry
credentials, and it is reduced to printable ASCII and cut at 200 characters.
Without a readable message the reason is "Demos L2PS RFQ send outcome is
unknown". The transport cannot tell a permanent refusal from a lost reply, so
such a packet is resent after each grace like any ambiguous send; stopping
after repeated identical refusals is a follow-up. A recipient that is not
registered on the node is not refused at all: the node queues the message and
answers `queued` (above). A frame over the node's size limit never reaches the
node (see the size limits below).

The default grace is 60,000 ms; configure a positive integer up to 600,000 ms.
The grace only reduces noise; it is not what makes a resend safe. The evidence
is the Demos node source at commit `61b8e75` (paths under
`src/features/l2ps-messaging/`):

- `handleSend` awaits the messaging service before it replies or delivers
  (`L2PSMessagingServer.ts:262-294`). The service inserts the
  `l2ps_messages` row before it submits to the L2PS mempool
  (`L2PSMessagingService.ts:57-63,134`), and history reads that same table
  directly (`L2PSMessagingService.ts:337-377`). An acknowledged send is
  therefore already visible in history.
- The `message_hash` column is unique (`entities/L2PSMessage.ts:30`). The
  service checks it before the insert and maps a constraint race to the same
  error (`L2PSMessagingService.ts:50-51,136-145`). A repeat is refused with
  "Duplicate message" and is not delivered (`L2PSMessagingServer.ts:267-278`).
  Nothing in the node deletes these rows.

The transport uses the packet ID as the Demos message hash, so on this node a
packet is stored at most once. Delivery may repeat: the node sends queued rows
to a peer that registers and only then marks them delivered
(`L2PSMessagingServer.ts:429-465`), so a crash in between sends them again.
The lifecycle records each received packet ID once and answers a repeat as a
duplicate. The generation-fenced send outbox also makes every resend
byte-identical, so any copy carries the same frame.

No finite grace can prove absence. The node keeps processing after a client
gives up, its database statement, query and lock timeouts are commented out
(`src/model/datasource.ts:58-60`), and demosdk queues a frame whose send
failed, with no expiry, and flushes it on reconnect
(`L2PSMessagingPeer.js:376-395`). A timed-out send can therefore land at any
later time. The 60-second default (twice the pinned demosdk's 15-second send
wait plus its 10-second history wait, rounded up; `L2PSMessagingPeer.js:126,151`)
only avoids most resends that the node would refuse.

When the node refuses a send with "Duplicate message", the transport reads
history. Our own exact frame there acknowledges the packet. Otherwise the send
outbox entry is marked `duplicate`: the node holds that hash, so absence can
never be proven, and the entry stays `indeterminate` and is never resent.

A `duplicate` result can mean zero deliveries:

- The node's check keys on the message hash alone
  (`L2PSMessagingService.ts:50-51,81-86`; unique column
  `entities/L2PSMessage.ts:30`), not on sender, recipient or subnet. The
  hash, our packet ID, may belong to another route or subnet: anyone who sent
  it first, including the node operator, leaves our send refused.
- The node inserts the row before it submits the message to the L2PS mempool
  (`L2PSMessagingService.ts:57-64`). If that submission fails, the row is
  marked `failed` (`L2PSMessagingService.ts:66-67,155`) and the server
  returns an error before routing anything (`L2PSMessagingServer.ts:267-270`).
  Every later send is then refused as a duplicate. Nothing was routed live,
  but the `failed` row stays in history, which the node returns whatever its
  status (`L2PSMessagingService.ts:337-377`). A recipient on the same node
  that runs `resumeInbound()` recovers and delivers the packet from that row.

The transport reports such an entry as `indeterminate` with the fixed reason
"Demos L2PS refused the packet hash as a duplicate that history does not
show"; hosts can match on that text until the reason is exported as a
constant or status code (a follow-up). `publish` never resends it.
`reconcile`, which `resumeOutbox()` calls, keeps reading history, so the entry
can still become `acknowledged` when our exact frame appears, or `rejected` on
a conflicting frame. The SDK has no call that clears a `duplicate` entry. Handle it like a
failed history entry (below): if the counterparty did receive the packet, its
reply still arrives through `receive()` and the job continues. Only otherwise
may the host need to end the job (once the counterparty's turn or agreement
step is overdue, `sendAbort()` records the timeout as the job's failure) and open a new one with
a new `jobId` and `channelId`.

The limits of this evidence:

- Dedup and history are per node database. Reconcile and resend must reach
  the same node, or nodes that share its database. Another node's history
  cannot prove absence there, and that node would accept a resend as a new
  message. The checked transport binds each send outbox entry to its exact
  node URL, keeps its peer on that URL, and never resends the entry through
  another (above). It cannot see a URL that reaches different databases at
  different times; with the unverified transport all of this is the host's job.
- A `failed` history row for the packet blocks every resend, permanently.
- Nothing bounds when a timed-out send lands.
- Node `61b8e75` refuses a sender's message once 200 of its offline messages
  are undelivered, with "Offline message limit reached", before storing it
  (`L2PSMessagingService.ts:39-105`); demosdk passes on only that text. The
  transport treats it like any failed send: `indeterminate`, and resent after
  the grace once history proves absence. It is never an acknowledgement. Only
  the RFQ-4 timeout ends such a job.
- The node pages history by timestamp alone, with a strict `timestamp <
  before` cursor (`L2PSMessagingService.ts:337-374`). When more than a page of
  the pair's rows share one millisecond, the rows past the page on that
  millisecond appear on no page. Recovery and reconcile then stay
  `indeterminate` and never resend, but such a packet is not recovered until
  the node pages by timestamp and row ID.
- All of this describes node `61b8e75`; recheck it when the node changes.
  The node's `getNetworkInfo` must report commit
  `61b8e75aa8db5e408c49e1c3a89db4d673f45578` and `dirty: false` (demosdk's
  `NetworkInfo` type omits that `nodeVersion` field, so read it untyped).
  A node that reports `dirty: true`, or another commit, fails that check even
  when the commit matches: its storage, dedup and history behaviour is not
  the reviewed source, and the absence-then-resend evidence above does not
  hold against it. The checked transport makes this check itself, at open
  and before every resend (above). The unverified transport makes none, so
  with it run the check in the consuming host at startup. On 2026-10-18 and
  again on 2026-10-19 the public testnet node `node2.demos.sh` reported
  commit `61b8e75…` with `dirty: true`, so it fails this check: the checked
  transport does not open against it, and the evidence is unconfirmed there.
  Separately, check in the host that the installed demosdk's
  `build/instant_messaging/L2PSMessagingPeer.js` and `l2ps_types.d.ts` have
  SHA-256 `997e6275122abbd738e2817c6396db60cba72e5859b8c0830b9b942a746c75be`
  and `974b1abe8ad57d3eecc0f91c489b0491a44f31ae36b6e54da4e231343b75d0f2`, as
  in 4.0.16 through 4.0.18. Neither constructor can: they take a peer
  object, not the file it came from. The SDK's own tests check those two
  hashes against the locked demosdk. A demosdk that moves the URL field or
  changes a reply shape fails closed (construction refused, or the send
  `indeterminate`); other changes, such as to its send queue, are why the
  host checks the files. Single storage of a resend rests on the node's
  dedup, not on demosdk.
  The duplicate handling above keys on the node's exact "Duplicate message"
  text.

A send outbox entry stored as `acknowledged` is final. It records the node's
unsigned acknowledgement (see the acknowledgement authority above); it is not
proof of delivery. `reconcile` returns `acknowledged` without reading history,
and `publish` returns it without sending or rewriting the entry, for example after the
lifecycle's own write failed following the acknowledgement. Before any resend,
the transport opens the stored frame once and compares it canonically with the
packet. If the frame does not open (for example, after a key rotated under the
same `codecId`) or opens to other bytes, the result is `indeterminate` and
nothing is sent. `publish` then reads history itself, as `reconcile` does, and
resends only when that read proves absence. So a host that calls `publish`
without reconciling first never resends a frame that history shows; our own
frame there acknowledges the packet, and anything else that is not proven
absence stays `indeterminate` or `rejected` as in `reconcile`. A late first
send can still land after that read, so only the node's unique `messageHash`
keeps one stored row. Within one process, outbox work for each packet runs one call
at a time, so a concurrent `publish` and `resumeOutbox()` cannot both seal a
frame; serializing drivers across processes stays the host's job.

The end timestamp is persisted in the send outbox. `monotonicNowMs` is an
injectable trusted clock; its default uses `process.hrtime.bigint()` in
milliseconds, with a common monotonic origin across process restarts on the
same machine boot. Supply a durable common-origin monotonic clock when moving
between machines or boots; a detected rollback starts and persists a new full
grace. A crash before the end write leaves a durable `sending` marker;
recovery starts one full grace from its first observation and persists that
time. Restarting again does not reset an already persisted end time. Do not
migrate a legacy ambiguous lifecycle entry without its companion send marker:
without one the transport takes the packet as never sent and sends it at once.
Settle it first or seed a conservative `sending` marker through the host store.

| Situation | Extra hold before absence can authorize retry |
| --- | --- |
| Refusal before peer call | 0 |
| Ambiguous send, known end | At most 60 seconds (configured grace) from that end |
| Crash before end write, or detected clock rollback | One full grace from first recovery observation |
| Exact history match, or a stored acknowledgement, at any time | 0; acknowledge immediately |
| Paginated/failed history, a node duplicate refusal without our frame in history, a stored frame that does not open, or an unavailable outbox | Unbounded; stay indeterminate |
| Checked transport: the recipient is not registered on the node | Nothing is sent until it is |
| Checked transport: the entry went through another node URL, or the node does not report the clean build | Until the transport is on that URL and the node reports that build |

The hold itself adds at most the configured grace; the host's next
`resumeOutbox()` cadence adds its polling interval. With the default 20-second
operation limit, a successful single-page absence check and retry dispatch can
also spend up to 120 seconds on outbox read, history, retry outbox read,
opening the stored frame, the retry's own history read and the pre-send write:
at most 180 seconds plus the polling interval after a known send end. The
checked transport also reads the node build and asks about the recipient,
up to 40 seconds more: at most 220 seconds. This transport-only calculation excludes host lifecycle storage, the retry's
own send/acknowledgement wait and end write.
There is no finite whole-call bound for paginated history (a follow-up),
persistence failures, repeated failures or scheduling stalls. The paginated
history case also applies to `publish`: before a resend and after a
"Duplicate message" refusal it reads history while it holds the packet's
in-process lock, so other outbox calls for that packet wait for it.

Node `61b8e75` refuses a send whose `encrypted.ciphertext` is longer than
131,072 characters, before it stores anything (`L2PSMessagingServer.ts:27,
247-249`). The transport applies the same limit, so the node never refuses a
frame of ours for its size. The built-in codec seals at most 98,288 plaintext
bytes (98,304 with its tag, exactly 131,072 Base64 characters). `publish`
answers `rejected` before the send outbox is written for a packet whose
canonical bytes are larger, or for a custom codec's frame over the limit; the
lifecycle records that as a terminal transport failure instead of resending a
frame the node can never take. These complete-packet checks also cover
reject and abort reasons and the host's channel signature (`TSignature`).

Payloads from Demos are size-checked before they are copied or canonicalized:
a frame over that limit, a history page of more than 100 entries, or a page
whose strings total more than 100 × (131,072 + 8,192) characters is refused.
Only sender-chosen fields shaped like an RFQ frame are charged (below), so a
full page of rows the node accepts stays within that budget. A refused live
payload goes to `onError`; a refused history page makes reconciliation or
recovery `indeterminate`.

Live admission and capture run synchronously when the peer emits an event.
The serialized receive lane holds at most 100 events and 16 MiB, including the
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
its share of the 100-event and 16 MiB budget until it settles or times out.
`drain()` waits only for the current generation's lane.

Run `resumeInbound()` for each peer after any `start()`, not only at process
start. Live events that overflowed the lane, timed out in the consumer, or were
retired by `stop()` stay in Demos history and come back only that way.

The node can also lose a live push without an error on either side. Node
`61b8e75` stores the row as `delivered` when the recipient is registered
(`L2PSMessagingService.ts:132`), pushes the frame through a helper that
swallows socket errors (`L2PSMessagingServer.ts:471-477`), and redelivers
only `queued` rows (`L2PSMessagingService.ts:285`). A frame lost that way
reaches neither the consumer nor `onError`; it is only in history. In a
long-running process, therefore, also call `resumeInbound()` for each peer
on a regular cadence, whenever demosdk reports the peer connected again,
and immediately before a waiting member calls `sendAbort()` to record an
RFQ-4 timeout, so a reply already stored on the node is received first.

History is kept per peer pair, not per job, and Demos keeps every row. Recovery
therefore sorts the packets it finds by job and channel and delivers each job's
packets in turn order. IDs are compared by exact code units, not by locale
collation, so two IDs that differ only in a character collation ignores (a
zero-width space, say) stay separate groups. When the consumer does not accept
a packet, recovery holds back the later packets of that job only and goes on
with the other jobs. A packet of the same rank is still offered, and once one
is accepted the job goes on. The result lists each refused packet in `skipped`,
with how many packets that covers (it and the ones held back) and the
consumer's reason. A rejection is the consumer's answer about
the packet, not a transport uncertainty, so it does not make the call
`indeterminate`. The lifecycle rejects, for example, a packet whose job is
retired, not open yet, or carries a failure; when its clock, a verifier or its
signer fails, or its own agreement contribution does not verify, it answers
`indeterminate` instead (see "Running a durable buyer or seller"). Check
`skipped`, and run `resumeInbound()` again after opening a job whose first
packets may already be in history. An `indeterminate` or
`conflict` result, or a consumer that throws, makes the call `indeterminate`.
A consumer timeout or a retired generation still stops recovery, because every
later job would wait on it too.

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

`resumeInbound()` also caps the decoded packet bytes it holds at
`inboundRecoveryMaxBytes` (64 MiB by default, at most 1 GiB). Demos returns
history newest first, so a job's earlier packets may still be on a later page;
recovery therefore delivers nothing until it has read every page, and the cap
bounds what it holds until then. Each distinct packet is charged its decoded
size once. When the next packet would exceed the cap, recovery stops reading,
delivers the packets it already holds, each job in order, and returns
`indeterminate` with "Demos L2PS inbound recovery reached
inboundRecoveryMaxBytes before history ended". The older packets it did not
reach are not delivered. The counterparty holds the subnet key and can fill the
pair's history with large valid frames, so this bound keeps a restart from
running out of memory; such a pair stays `indeterminate` until the cap is
raised. `resumeInbound()` has no cursor yet: every call reads the pair's whole
history again (a follow-up).

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
such a failed-history entry: `resumeOutbox()` keeps returning `indeterminate`.
If the counterparty did receive the packet, its reply still arrives through
`receive()` and the job continues, with the stale entry left `indeterminate`.
Otherwise end the job: once the counterparty's turn, or the agreement step
this member waits on, is overdue on the trusted clock, `sendAbort()` records
the RFQ-4 timeout as the job's terminal failure, without signing or sending
anything; before that it is refused ("counterparty owns the next RFQ turn"
while the session is open, "RFQ session is already terminal" after
acceptance). Then
open a new job with a new `jobId` and `channelId`. Alert on outbox entries
that remain `indeterminate` across restarts. An operator redrive or
acknowledgement call is tracked as a follow-up.

The live receive path reports decryption, mapping and lifecycle failures only
through `onError`. The live Demos payload carries no subnet UID, so live frames
are bound to the subnet only by the codec key; history recovery also checks the
UID. A frame that failed live is recovered only by the next `resumeInbound()`,
so call it again after an `onError` report as well as on every start.

A history row holds fields the node writes (`id`, `from`, `to`, `l2psUid`,
`l2psTxHash`, `timestamp`, `status`) and fields the sender chose
(`messageHash`, `encrypted`). Node `61b8e75` stores any non-empty
`messageHash` and any `encrypted` value with a ciphertext and a nonce, and
never deletes a row (`L2PSMessagingServer.ts:236-250`). A row whose
sender-chosen fields are not shaped like an RFQ frame is therefore skipped,
not refused: a `messageHash` that is not a lower-case SHA-256 hash (demosdk's
own `L2PSChannelTransport` sends 128 hex digits), or an `encrypted` value
that is not a record of Base64 string `ciphertext` and `nonce` within the
frame limits and an optional well-formed string `ephemeralKey` (a number, for
example, even one too large for the canonical form). Such a field is replaced
by `null` and not charged to the page budget. Reconciliation ignores such a row, and
`resumeInbound()` counts it in `ignored` without offering it to the consumer
or becoming `indeterminate`. A malformed node-written field still refuses the
whole page. A row under our packet ID and route whose frame is not well
formed is a conflict, like one that does not authenticate.

Use a dedicated RFQ subnet/peer conversation. The Demos messaging envelope has
no application content-type discriminator, so sharing the same encrypted
conversation with unrelated codecs makes history recovery ambiguous. A
well-formed frame that does not open, a `failed` row, or a transport `l2psUid`
that differs from the subnet the peer registered on keeps every later
`resumeInbound()` for that pair `indeterminate`; so does a pair whose history
is longer than one page, because timestamp pagination cannot prove
completeness. Set `l2psUid` to the subnet the peer registers with.

The SDK accepts a structural peer instead of importing demosdk. At the pinned
demosdk 4.0.16, the only public `instantMessaging` export is the eager package
root, whose clean import fails in this install. demosdk 4.0.17 and later also
export a focused `./instant-messaging` subpath
([kynesyslabs/sdks#125](https://github.com/kynesyslabs/sdks/issues/125),
closed). Either way the host constructs, connects and registers the peer and
passes it in. This transport still delegates DACS channel signing and
verification to the lifecycle callbacks because the normative framing remains
open in DACS-Standard#349.

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

The low-level Demos L2PS transport adapter (above) has landed. The SDK supplies
it with the complete transport-neutral, durable buyer/seller RFQ lifecycle,
agreement/commitment and transcript-policy core, but not a complete live
`negotiate-rfq` phase handler. `openDemosL2psRfqTransport()` binds each
`did:demos:agent` member's claim to its messaging key and checks the node.
Still deferred: a normative channel-signature profile (DACS-Standard#349 must
resolve the current signature-framing conflict first), the subnet-membership
half of the §8.3.2 binding and bindings for other claim schemes, §8.3.4
member acknowledgements, and constructing the demosdk peer.
