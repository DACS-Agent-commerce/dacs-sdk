import { randomBytes } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

const snapshotLabels = vi.hoisted(() => [] as string[]);

// Pass-through spy: admission tests prove a peer-supplied value was refused
// before the deep canonical snapshot ever ran on it.
vi.mock("../../src/canonical/snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/canonical/snapshot.js")>();
  return {
    ...actual,
    snapshotCanonicalJsonRead<T>(value: T, label: string): T {
      snapshotLabels.push(label);
      return actual.snapshotCanonicalJsonRead(value, label);
    },
  };
});

import {
  canonicalize,
  contentHash,
  createDemosL2psRfqAesGcmCodec,
  createDemosL2psRfqTransport,
  createDurableRfqLifecycleClient,
  createInMemoryDurableRfqLifecycleStore,
  rfqLifecyclePacketId,
  TransientError,
  type AttestationRef,
  type DemosL2psRfqEncryptedMessage,
  type DemosL2psRfqHistoryPage,
  type DemosL2psRfqIncomingPayload,
  type DemosL2psRfqMessageHandler,
  type DemosL2psRfqPeerLike,
  type DemosL2psRfqStoredMessage,
  type DemosL2psRfqTransportOptions,
  type DemosL2psRfqWireCodec,
  type DurableRfqLifecycleRole,
  type DurableRfqLifecycleTransport,
  type IdentityBundle,
  type Listing,
  type RfqChannelReservationInput,
} from "../../src/index.js";

const NOW = 1_780_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const CHANNEL_ID = "demos-l2ps-rfq-channel-01";
const L2PS_UID = "l2ps:rfq-test-subnet";
const BUYER = "did:demos:buyer-l2ps-rfq";
const SELLER = "did:demos:seller-l2ps-rfq";
const BUYER_PEER = "a".repeat(64);
const SELLER_PEER = "b".repeat(64);
const THIRD_PEER = "c".repeat(64);
// Base64 length of the largest frame the codec accepts (16 MiB + GCM tag).
const MAX_CIPHERTEXT_CHARS = Math.ceil((16 * 1024 * 1024 + 16) / 3) * 4;

function identity(claim: string): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: claim,
    presentedAt: NOW - 1_000,
    claims: [{ ref: claim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: claim, signature: "identity-proof" }],
    },
  };
}

function vetRef(locator: string): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator },
    contentHash: "a".repeat(64),
  };
}

const buyer = {
  identityBundle: identity(BUYER),
  vetRecordRef: vetRef("stor:buyer-l2ps-rfq-vet"),
};
const seller = {
  identityBundle: identity(SELLER),
  vetRecordRef: vetRef("stor:seller-l2ps-rfq-vet"),
};

function listing(): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 3,
    listingId: "demos-l2ps-rfq-listing",
    requiredCapabilities: ["SR-2", "SR-4"],
    seller: {
      identity: identity(SELLER),
      displayName: "Demos L2PS RFQ seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Private L2PS quote",
      description: "A two-peer encrypted RFQ fixture",
      category: "data.finance",
      tags: ["rfq"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-rfq", parameters: { maxTurns: 4, timeoutSec: 10 } },
      { kind: "commit-agreement" },
      { kind: "deliver-attested-payload" },
    ],
    pricing: {
      kind: "negotiable",
      bandCenter: { amount: "10", currency: "USDC" },
      minPct: 20,
      maxPct: 20,
    },
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 10_000, notAfter: NOW + 1_000_000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.alloc(64, 7).toString("base64url"),
    },
  };
}

function openInput() {
  const value = listing();
  return {
    jobId: JOB_ID,
    verifiedListing: {
      disposition: "verified" as const,
      listing: value,
      pin: {
        listingId: value.listingId,
        version: value.listingVersion,
        contentHash: contentHash(value as unknown as Record<string, unknown>),
      },
    },
    buyer,
    seller,
    channelId: CHANNEL_ID,
  };
}

function durableReservation() {
  const reservations = new Map<string, string>();
  return (input: Readonly<RfqChannelReservationInput>) => {
    const exact = canonicalize(input as unknown as Record<string, unknown>);
    const prior = reservations.get(input.channelId);
    if (prior !== undefined && prior !== exact) return "fail" as const;
    reservations.set(input.channelId, exact);
    return "pass" as const;
  };
}

function peerForClaim(claim: string): string | undefined {
  if (claim === BUYER) return BUYER_PEER;
  if (claim === SELLER) return SELLER_PEER;
  return undefined;
}

function claimForPeer(peer: string): string | undefined {
  if (peer === BUYER_PEER) return BUYER;
  if (peer === SELLER_PEER) return SELLER;
  return undefined;
}

class FakeL2psHub {
  readonly messages: DemosL2psRfqStoredMessage[] = [];
  readonly handlers = new Map<string, Set<DemosL2psRfqMessageHandler>>();
  sends = 0;
  loseNextResponse = false;

  peer(localPeer: string): DemosL2psRfqPeerLike {
    return {
      isConnected: true,
      isRegistered: true,
      send: (to, encrypted, messageHash) =>
        this.send(localPeer, to, encrypted, messageHash),
      history: (peerKey, options) =>
        this.history(localPeer, peerKey, options),
      onMessage: (handler) => {
        const handlers = this.handlers.get(localPeer) ?? new Set();
        handlers.add(handler);
        this.handlers.set(localPeer, handlers);
      },
      removeMessageHandler: (handler) => {
        this.handlers.get(localPeer)?.delete(handler);
      },
    };
  }

  private async send(
    from: string,
    to: string,
    encrypted: DemosL2psRfqEncryptedMessage,
    messageHash: string,
  ) {
    this.sends += 1;
    let stored = this.messages.find(
      (message) =>
        message.from === from &&
        message.to === to &&
        message.messageHash === messageHash,
    );
    if (stored === undefined) {
      stored = {
        id: `message-${this.messages.length + 1}`,
        from,
        to,
        messageHash,
        encrypted: structuredClone(encrypted),
        l2psUid: L2PS_UID,
        l2psTxHash: null,
        timestamp: NOW + this.messages.length,
        status: "l2ps_pending",
      };
      this.messages.push(stored);
    }
    const payload: DemosL2psRfqIncomingPayload = {
      from,
      encrypted: structuredClone(stored.encrypted),
      messageHash,
    };
    for (const handler of this.handlers.get(to) ?? []) handler(payload);
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error("response lost after durable acceptance");
    }
    return { messageHash, l2psStatus: "submitted" as const };
  }

  private async history(
    localPeer: string,
    otherPeer: string,
    options?: { before?: number; limit?: number },
  ): Promise<DemosL2psRfqHistoryPage> {
    const limit = options?.limit ?? 100;
    const matching = this.messages
      .filter(
        (message) =>
          ((message.from === localPeer && message.to === otherPeer) ||
            (message.from === otherPeer && message.to === localPeer)) &&
          (options?.before === undefined || message.timestamp < options.before),
      )
      .sort((left, right) => right.timestamp - left.timestamp);
    return {
      messages: structuredClone(matching.slice(0, limit)),
      hasMore: matching.length > limit,
    };
  }
}

function clientOptions(
  role: DurableRfqLifecycleRole,
  transport: DurableRfqLifecycleTransport<string>,
  reservation: ReturnType<typeof durableReservation>,
) {
  const claim = role === "buyer" ? BUYER : SELLER;
  return {
    role,
    store: createInMemoryDurableRfqLifecycleStore<string>(),
    transport,
    reserveChannelId: reservation,
    signChannelMessage: (input: { envelopeHash: string }) =>
      `${role}:${input.envelopeHash}`,
    verifyChannelMessage: () => "pass" as const,
    agreementSigner: {
      party: claim,
      algorithm: "ed25519" as const,
      sign: () => new Uint8Array(64).fill(role === "buyer" ? 1 : 2),
    },
    verifyAgreementContribution: () => "valid" as const,
    nowMs: () => NOW,
  };
}

/** A buyer whose first offer reached Demos but whose send response was lost. */
async function buyerWithSentOffer(options: {
  codec?: (base: DemosL2psRfqWireCodec) => DemosL2psRfqWireCodec;
  history?: (base: DemosL2psRfqPeerLike["history"]) => DemosL2psRfqPeerLike["history"];
  operationTimeoutMs?: number;
} = {}) {
  const hub = new FakeL2psHub();
  const sharedKey = randomBytes(32);
  const baseCodec = createDemosL2psRfqAesGcmCodec({ sharedKey });
  const basePeer = hub.peer(BUYER_PEER);
  const transport = createDemosL2psRfqTransport<string>({
    peer: options.history === undefined
      ? basePeer
      : { ...basePeer, history: options.history(basePeer.history) },
    codec: options.codec?.(baseCodec) ?? baseCodec,
    l2psUid: L2PS_UID,
    localClaim: BUYER,
    localPeerKey: BUYER_PEER,
    peerForClaim,
    claimForPeer,
    onError: vi.fn(),
    ...(options.operationTimeoutMs === undefined
      ? {}
      : { operationTimeoutMs: options.operationTimeoutMs }),
  });
  const client = createDurableRfqLifecycleClient(
    clientOptions("buyer", transport, durableReservation()),
  );
  await client.open(openInput());
  hub.loseNextResponse = true;
  await expect(client.sendOffer(JOB_ID, {
    rfqProposalVersion: "1",
    price: { amount: "9", currency: "USDC" },
  })).resolves.toMatchObject({ status: "indeterminate" });
  const status = await client.getStatus(JOB_ID);
  if (status.status !== "ok") throw new Error("record did not load");
  const packet = status.record.outbox[0]?.packet;
  const own = hub.messages[0];
  if (packet === undefined || own === undefined) throw new Error("frame missing");
  return { hub, sharedKey, baseCodec, transport, client, packet, own };
}

async function inboundReceiver(options: {
  open?: (base: DemosL2psRfqWireCodec) => DemosL2psRfqWireCodec["open"];
  operationTimeoutMs?: number;
  consumerTimeoutMs?: number;
} = {}) {
  const sent = await buyerWithSentOffer();
  const errors: Error[] = [];
  const transport = createDemosL2psRfqTransport<string>({
    peer: sent.hub.peer(SELLER_PEER),
    codec: {
      codecId: sent.baseCodec.codecId,
      seal: (plaintext, context) => sent.baseCodec.seal(plaintext, context),
      open: options.open?.(sent.baseCodec) ?? ((encrypted, context) => sent.baseCodec.open(encrypted, context)),
    },
    l2psUid: L2PS_UID,
    localClaim: SELLER,
    localPeerKey: SELLER_PEER,
    peerForClaim,
    claimForPeer,
    onError: (error) => errors.push(error),
    ...(options.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: options.operationTimeoutMs }),
    ...(options.consumerTimeoutMs === undefined ? {} : { consumerTimeoutMs: options.consumerTimeoutMs }),
  });
  const client = createDurableRfqLifecycleClient(clientOptions("seller", transport, durableReservation()));
  await client.open(openInput());
  const receive = vi.fn((packet: unknown) => client.receive(packet));
  transport.start(receive);
  const emit = (payload: DemosL2psRfqIncomingPayload) => {
    for (const handler of sent.hub.handlers.get(SELLER_PEER) ?? []) handler(payload);
  };
  const payload = { from: BUYER_PEER, encrypted: structuredClone(sent.own.encrypted), messageHash: sent.packet.packetId };
  return { ...sent, transport, client, receive, errors, emit, payload };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const OVERFLOW = "Demos L2PS RFQ live queue exceeds its count or byte budget; recover from history";
const CONSUMER_TIMEOUT = "Demos L2PS RFQ consumer timed out";

// Runs pending promise jobs on a macrotask that the fake timers below leave real.
async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Synchronous emits are all charged before any is ingested: exactly 100 fit. */
async function expectFullLiveCapacity(fixture: Awaited<ReturnType<typeof inboundReceiver>>) {
  const before = fixture.errors.length;
  for (let index = 0; index < 100; index += 1) fixture.emit(fixture.payload);
  expect(fixture.errors).toHaveLength(before);
  fixture.emit(fixture.payload);
  expect(fixture.errors.slice(before).map((error) => error.message)).toEqual([OVERFLOW]);
  expect(fixture.errors[before]).toBeInstanceOf(TransientError);
  await fixture.transport.drain();
}

describe("Demos L2PS durable RFQ transport", () => {
  test("round 4: a stuck consumer from a retired generation does not hold back the next one", async () => {
    const fixture = await inboundReceiver();
    // Never advanced: neither the consumer nor any operation timeout can fire.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fixture.transport.stop();
      let retiredSignal: AbortSignal | undefined;
      const stuck = vi.fn((_packet: unknown, options: { signal: AbortSignal }) => {
        retiredSignal = options.signal;
        return new Promise<never>(() => {});
      });
      fixture.transport.start(stuck);
      fixture.emit(fixture.payload);
      await settle();
      expect(stuck).toHaveBeenCalledTimes(1);
      expect(retiredSignal?.aborted).toBe(false);

      fixture.transport.stop();
      expect(retiredSignal?.aborted).toBe(true);
      const current = vi.fn((packet: unknown) => fixture.client.receive(packet));
      fixture.transport.start(current);
      fixture.emit(fixture.payload);
      let drained = false;
      void fixture.transport.drain().then(() => { drained = true; });
      await settle();
      expect(current).toHaveBeenCalledTimes(1);
      await expect(current.mock.results[0]?.value).resolves.toMatchObject({ status: "ready" });
      expect(drained).toBe(true);
      expect(stuck).toHaveBeenCalledTimes(1);
      expect(fixture.errors).toHaveLength(0);
      fixture.transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("round 4: times out a never-settling live consumer and releases its charge", async () => {
    const fixture = await inboundReceiver({ consumerTimeoutMs: 1_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fixture.transport.stop();
      const signals: AbortSignal[] = [];
      const consumer = vi.fn((packet: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return signals.length === 1 ? new Promise<never>(() => {}) : fixture.client.receive(packet);
      });
      fixture.transport.start(consumer);
      fixture.emit(fixture.payload);
      await settle();
      expect(consumer).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(999);
      await settle();
      expect(fixture.errors).toHaveLength(0);
      expect(signals[0]?.aborted).toBe(false);

      vi.advanceTimersByTime(1);
      await settle();
      expect(fixture.errors.map((error) => error.message)).toEqual([CONSUMER_TIMEOUT]);
      expect(fixture.errors[0]).toBeInstanceOf(TransientError);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[0]?.reason).toBe(fixture.errors[0]);
      await fixture.transport.drain();

      // The next event is delivered, and the lane's accounting is back to zero.
      fixture.emit(fixture.payload);
      await fixture.transport.drain();
      expect(consumer).toHaveBeenCalledTimes(2);
      await expect(consumer.mock.results[1]?.value).resolves.toMatchObject({ status: "ready" });
      expect(fixture.errors).toHaveLength(1);
      await expectFullLiveCapacity(fixture);
      expect(fixture.errors).toHaveLength(2);
      fixture.transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(["resolves", "rejects"] as const)("round 4: a live consumer that %s after its timeout has no further effect", async (outcome) => {
    const fixture = await inboundReceiver({ consumerTimeoutMs: 1_000 });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fixture.transport.stop();
      const late = gate();
      let calls = 0;
      const consumer = vi.fn(async (packet: unknown) => {
        calls += 1;
        if (calls > 1) return fixture.client.receive(packet);
        await late.promise;
        if (outcome === "rejects") throw new Error("late consumer failure");
        return fixture.client.receive(packet);
      });
      fixture.transport.start(consumer);
      fixture.emit(fixture.payload);
      await settle();
      vi.advanceTimersByTime(1_000);
      await settle();
      expect(fixture.errors.map((error) => error.message)).toEqual([CONSUMER_TIMEOUT]);

      late.release();
      await settle();
      vi.advanceTimersByTime(60_000);
      await settle();
      await fixture.transport.drain();
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(fixture.errors).toHaveLength(1);
      expect(unhandled).not.toHaveBeenCalled();
      // A second release of the timed-out charge would let a 101st event in.
      await expectFullLiveCapacity(fixture);
      expect(consumer).toHaveBeenCalledTimes(101);
      fixture.transport.stop();
    } finally {
      vi.useRealTimers();
      process.off("unhandledRejection", unhandled);
    }
  });

  test("round 4: resumeInbound returns indeterminate when its consumer never settles", async () => {
    const fixture = await inboundReceiver({ consumerTimeoutMs: 1_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fixture.transport.stop();
      let signal: AbortSignal | undefined;
      const stuck = vi.fn((_packet: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return new Promise<never>(() => {});
      });
      fixture.transport.start(stuck);
      let result: unknown;
      void fixture.transport.resumeInbound(BUYER).then((value) => { result = value; });
      await settle();
      expect(stuck).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined();
      vi.advanceTimersByTime(1_000);
      await settle();
      expect(result).toEqual({ status: "indeterminate", delivered: 0, reason: CONSUMER_TIMEOUT });
      expect(signal?.aborted).toBe(true);
      expect(fixture.errors).toHaveLength(0);
      expect(fixture.hub.sends).toBe(1);
      fixture.transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("round 4: validates consumerTimeoutMs like operationTimeoutMs", () => {
    const hub = new FakeL2psHub();
    const base = {
      peer: hub.peer(SELLER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      localClaim: SELLER,
      localPeerKey: SELLER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    };
    for (const consumerTimeoutMs of [1, 30_000, 600_000]) {
      expect(() => createDemosL2psRfqTransport({ ...base, consumerTimeoutMs })).not.toThrow();
    }
    for (const consumerTimeoutMs of [0, -1, 1.5, 600_001, Number.NaN, "1000"]) {
      expect(() => createDemosL2psRfqTransport({ ...base, consumerTimeoutMs: consumerTimeoutMs as number }))
        .toThrow("consumerTimeoutMs must be a positive safe integer at most 600000");
    }
    const read = vi.fn(() => 1_000);
    const getter = { ...base } as DemosL2psRfqTransportOptions;
    Object.defineProperty(getter, "consumerTimeoutMs", { enumerable: true, get: read });
    expect(() => createDemosL2psRfqTransport(getter))
      .toThrow("Demos L2PS RFQ transport options must use enumerable data properties");
    expect(read).not.toHaveBeenCalled();
  });

  test("round 4: releases live capacity when ingest fails, across three full rounds", async () => {
    let fail = true;
    const fixture = await inboundReceiver({ open: (base) => (encrypted, context) => {
      if (fail) throw new Error("temporary codec outage");
      return base.open(encrypted, context);
    } });
    for (let round = 1; round <= 3; round += 1) {
      for (let index = 0; index < 100; index += 1) fixture.emit(fixture.payload);
      await fixture.transport.drain();
      expect(fixture.errors).toHaveLength(100 * round);
      expect(new Set(fixture.errors.map((error) => error.message))).toEqual(new Set(["temporary codec outage"]));
    }
    fail = false;
    fixture.emit(fixture.payload);
    await fixture.transport.drain();
    expect(fixture.receive).toHaveBeenCalledTimes(1);
    expect(fixture.errors).toHaveLength(300);
    fixture.transport.stop();
  });

  test("round 4: releases live bytes when ingest fails", async () => {
    let opens = 0;
    const fixture = await inboundReceiver({ open: () => () => {
      opens += 1;
      throw new Error("temporary codec outage");
    } });
    // Each event is charged about 24 MiB; a leak would overflow the third.
    const large = {
      ...fixture.payload,
      encrypted: { ...fixture.payload.encrypted, ciphertext: "A".repeat(12 * 1024 * 1024) },
    };
    for (let index = 0; index < 4; index += 1) {
      fixture.emit(large);
      await fixture.transport.drain();
    }
    expect(fixture.errors.map((error) => error.message)).toEqual(Array(4).fill("temporary codec outage"));
    expect(opens).toBe(4);
    fixture.transport.stop();
  }, 120_000);

  test("round 4: an early recovered-frame timer stops recovery while budget remains", async () => {
    let opens = 0;
    const fixture = await inboundReceiver({ operationTimeoutMs: 20, open: () => () => {
      opens += 1;
      return new Promise<Uint8Array>(() => {});
    } });
    for (let index = 1; index < 3; index += 1) {
      fixture.hub.messages.push({ ...structuredClone(fixture.own), id: `inbound-${index}`, timestamp: fixture.own.timestamp + index });
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The shared deadline never passes on this clock, so only the open's own
    // timeout can stop the scan.
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    try {
      let result: unknown;
      void fixture.transport.resumeInbound(BUYER).then((value) => { result = value; });
      await settle();
      expect(opens).toBe(1);
      vi.advanceTimersByTime(20);
      await settle();
      expect(opens).toBe(1);
      expect(result).toMatchObject({ status: "indeterminate", delivered: 0 });
      expect(fixture.receive).not.toHaveBeenCalled();
      fixture.transport.stop();
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  test.each(["live", "recovery"] as const)("round 3: retires an in-flight %s decrypt across stop/start", async (path) => {
    const blocked = gate();
    const entered = gate();
    const opened = gate();
    const fixture = await inboundReceiver({ open: (base) => async (encrypted, context) => {
      entered.release();
      await blocked.promise;
      opened.release();
      return base.open(encrypted, context);
    } });
    const recovering = path === "recovery" ? fixture.transport.resumeInbound(BUYER) : undefined;
    if (path === "live") fixture.emit(fixture.payload);
    await entered.promise;
    fixture.transport.stop();
    const current = vi.fn((packet: unknown) => fixture.client.receive(packet));
    fixture.transport.start(current);
    blocked.release();
    // drain() covers only the new generation, so let the retired work finish.
    await opened.promise;
    await settle();
    await fixture.transport.drain();
    if (recovering !== undefined) {
      await expect(recovering).resolves.toMatchObject({ status: "indeterminate", delivered: 0 });
    }
    expect(fixture.receive).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    // The replacement generation can still recover the retired packet.
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({ status: "complete", delivered: 1 });
    expect(current).toHaveBeenCalledTimes(1);
    fixture.transport.stop();
  });

  test("round 3: retires recovery between asynchronous packet deliveries", async () => {
    const fixture = await inboundReceiver();
    const { packetId: _packetId, ...material } = fixture.packet;
    const otherMaterial = { ...material, jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7F" };
    const otherPacket = { ...otherMaterial, packetId: rfqLifecyclePacketId(otherMaterial) };
    fixture.hub.messages.push({
      ...structuredClone(fixture.own), id: "other-packet", messageHash: otherPacket.packetId,
      timestamp: fixture.own.timestamp + 1,
      encrypted: await fixture.baseCodec.seal(new TextEncoder().encode(canonicalize(otherPacket as unknown as Record<string, unknown>)), {
        messageHash: otherPacket.packetId, fromPeer: BUYER_PEER, toPeer: SELLER_PEER,
      }),
    });
    fixture.transport.stop();
    const blocked = gate();
    const entered = gate();
    const oldHandler = vi.fn(async (_packet: unknown) => {
      entered.release();
      await blocked.promise;
      return fixture.client.receive(fixture.packet);
    });
    fixture.transport.start(oldHandler);
    const recovering = fixture.transport.resumeInbound(BUYER);
    await entered.promise;
    fixture.transport.stop();
    const current = vi.fn();
    fixture.transport.start(current);
    blocked.release();
    await expect(recovering).resolves.toMatchObject({ status: "indeterminate", delivered: 1 });
    expect(oldHandler).toHaveBeenCalledTimes(1);
    expect(current).not.toHaveBeenCalled();
    fixture.transport.stop();
  });

  test("round 3: resumeInbound shares a 20 ms decryption budget across three hanging frames", async () => {
    let hang = true;
    let opens = 0;
    const fixture = await inboundReceiver({
      operationTimeoutMs: 20,
      open: (base) => (encrypted, context) => {
        opens += 1;
        return hang ? new Promise<Uint8Array>(() => {}) : base.open(encrypted, context);
      },
    });
    for (let index = 1; index < 3; index += 1) {
      fixture.hub.messages.push({ ...structuredClone(fixture.own), id: `inbound-${index}`, timestamp: fixture.own.timestamp + index });
    }
    const result = await fixture.transport.resumeInbound(BUYER);
    expect(result).toMatchObject({ status: "indeterminate", delivered: 0 });
    expect(opens).toBe(1);
    expect(fixture.receive).not.toHaveBeenCalled();
    expect(fixture.hub.sends).toBe(1);
    hang = false;
    opens = 0;
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({ status: "complete", delivered: 1 });
    expect(opens).toBe(3);
    fixture.transport.stop();
  });

  test("round 3: recovery deadline persists across pages after a fast codec failure", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    try {
      let opens = 0;
      const fixture = await inboundReceiver({ operationTimeoutMs: 20, open: () => () => {
        opens += 1;
        // First failure is quick enough to leave budget for the next page.
        vi.advanceTimersByTime(15);
        throw new Error("temporary codec outage");
      } });
      // A page boundary, rather than duplicate entries in one page.
      fixture.hub.messages.push({ ...structuredClone(fixture.own), id: "newer", timestamp: fixture.own.timestamp + 1 });
      const history = fixture.hub.peer(SELLER_PEER).history;
      // Simulate each page request costing 10 ms. The second request spends the
      // remaining budget, so its frame must never reach the codec.
      const transport = createDemosL2psRfqTransport<string>({
        peer: { ...fixture.hub.peer(SELLER_PEER), history: async (peer, options) => {
          vi.advanceTimersByTime(10);
          return history(peer, options);
        } },
        codec: { codecId: "deadline-probe", seal: (bytes, context) => fixture.baseCodec.seal(bytes, context), open: () => {
          opens += 1;
          vi.advanceTimersByTime(15);
          throw new Error("temporary codec outage");
        } },
        localClaim: SELLER, localPeerKey: SELLER_PEER, l2psUid: L2PS_UID,
        peerForClaim, claimForPeer, onError: vi.fn(), operationTimeoutMs: 20, historyPageSize: 1,
      });
      transport.start(fixture.receive);
      await expect(transport.resumeInbound(BUYER)).resolves.toMatchObject({ status: "indeterminate", delivered: 0 });
      expect(opens).toBe(1);
      expect(fixture.hub.sends).toBe(1);
      transport.stop();
      fixture.transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("round 3: rejects an oversized live event immediately behind a blocked decrypt", async () => {
    const blocked = gate();
    const entered = gate();
    const fixture = await inboundReceiver({ open: (base) => async (encrypted, context) => {
      entered.release();
      await blocked.promise;
      return base.open(encrypted, context);
    } });
    try {
      fixture.emit(fixture.payload);
      await entered.promise;
      snapshotLabels.length = 0;
      fixture.emit({ ...fixture.payload, encrypted: { ...fixture.payload.encrypted, ciphertext: "A".repeat(MAX_CIPHERTEXT_CHARS + 4) } });
      expect(fixture.errors.map((error) => error.message)).toEqual(["ciphertext exceeds its size limit"]);
      expect(snapshotLabels).not.toContain("Demos L2PS incoming RFQ payload");
    } finally {
      blocked.release();
      await fixture.transport.drain();
      fixture.transport.stop();
    }
  });

  test.each(["count", "bytes"] as const)("round 3: bounds live queue %s and releases capacity after drain", async (limit) => {
    const blocked = gate();
    const entered = gate();
    let opens = 0;
    const fixture = await inboundReceiver({ open: (base) => async (_encrypted, context) => {
      opens += 1;
      entered.release();
      await blocked.promise;
      // Synthetic large live frames still decode to the valid history packet.
      return base.open(fixture.payload.encrypted, context);
    } });
    const payload = limit === "count" ? fixture.payload : {
      ...fixture.payload,
      encrypted: { ...fixture.payload.encrypted, ciphertext: "A".repeat(12 * 1024 * 1024) },
    };
    // Two 24 MiB charges fit in 64 MiB; the third must be dropped.
    const capacity = limit === "count" ? 100 : 2;
    try {
      fixture.emit(payload);
      await entered.promise;
      for (let index = 1; index < capacity; index += 1) fixture.emit(payload);
      expect(fixture.errors).toHaveLength(0);
      snapshotLabels.length = 0;
      fixture.emit(payload);
      expect(fixture.errors).toHaveLength(1);
      expect(fixture.errors[0]?.message).toBe(OVERFLOW);
      expect(fixture.errors[0]).toBeInstanceOf(TransientError);
      expect(snapshotLabels).not.toContain("Demos L2PS incoming RFQ payload");
    } finally {
      blocked.release();
      await fixture.transport.drain();
    }
    expect(opens).toBe(capacity);
    fixture.emit(fixture.payload);
    await fixture.transport.drain();
    expect(opens).toBe(capacity + 1);
    expect(fixture.errors).toHaveLength(1);
    await expect(fixture.transport.resumeInbound(BUYER)).resolves.toEqual({ status: "complete", delivered: 1 });
    expect(fixture.hub.sends).toBe(1);
    fixture.transport.stop();
  }, 60_000);

  test("round 3: owns queued live payloads before the peer can mutate them", async () => {
    const fixture = await inboundReceiver();
    fixture.emit(fixture.payload);
    fixture.payload.encrypted.ciphertext = "AAAA";
    fixture.payload.from = THIRD_PEER;
    await fixture.transport.drain();
    expect(fixture.receive).toHaveBeenCalledTimes(1);
    expect(fixture.errors).toHaveLength(0);
    fixture.transport.stop();
  });
  test("uses fresh AES-GCM nonces and authenticates the exact peer route", async () => {
    const codec = createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) });
    const plaintext = new TextEncoder().encode("private quote");
    const context = {
      messageHash: "c".repeat(64),
      fromPeer: BUYER_PEER,
      toPeer: SELLER_PEER,
    };
    const first = await codec.seal(plaintext, context);
    const second = await codec.seal(plaintext, context);
    expect(first.nonce).not.toBe(second.nonce);
    await expect(Promise.resolve(codec.open(first, context))).resolves.toEqual(
      plaintext,
    );
    await expect(
      Promise.resolve().then(() =>
        codec.open(first, { ...context, toPeer: "d".repeat(64) }),
      ),
    ).rejects.toThrow("authentication failed");

    const tampered: DemosL2psRfqEncryptedMessage = structuredClone(first);
    const bytes = Buffer.from(tampered.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 1;
    tampered.ciphertext = bytes.toString("base64");
    await expect(
      Promise.resolve().then(() => codec.open(tampered, context)),
    ).rejects.toThrow("authentication failed");
  });

  test("completes a two-peer RFQ and reconciles a lost send response without redrive", async () => {
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const buyerErrors = vi.fn();
    const sellerErrors = vi.fn();
    const buyerTransport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: buyerErrors,
    });
    const sellerTransport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(SELLER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      localClaim: SELLER,
      localPeerKey: SELLER_PEER,
      peerForClaim,
      claimForPeer,
      onError: sellerErrors,
    });
    const reservation = durableReservation();
    const buyerClient = createDurableRfqLifecycleClient(
      clientOptions("buyer", buyerTransport, reservation),
    );
    const sellerClient = createDurableRfqLifecycleClient(
      clientOptions("seller", sellerTransport, reservation),
    );
    buyerTransport.start((packet) => buyerClient.receive(packet));
    sellerTransport.start((packet) => sellerClient.receive(packet));
    await expect(buyerClient.open(openInput())).resolves.toMatchObject({
      status: "ready",
    });
    await expect(sellerClient.open(openInput())).resolves.toMatchObject({
      status: "ready",
    });

    hub.loseNextResponse = true;
    await expect(
      buyerClient.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      }),
    ).resolves.toMatchObject({ status: "indeterminate" });
    await sellerTransport.drain();
    expect(hub.sends).toBe(1);
    await expect(buyerClient.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    expect(hub.sends).toBe(1);

    await expect(sellerClient.sendAccept(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    await buyerTransport.drain();
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    await sellerTransport.drain();
    await buyerTransport.drain();

    const buyerStatus = await buyerClient.getStatus(JOB_ID);
    const sellerStatus = await sellerClient.getStatus(JOB_ID);
    expect(buyerStatus.status).toBe("ok");
    expect(sellerStatus.status).toBe("ok");
    if (buyerStatus.status !== "ok" || sellerStatus.status !== "ok") return;
    expect(buyerStatus.record.transcript).toEqual(sellerStatus.record.transcript);
    expect(buyerStatus.record.agreement?.finalized).toEqual(
      sellerStatus.record.agreement?.finalized,
    );
    expect(buyerStatus.record.agreement?.finalized?.signatures).toHaveLength(2);
    expect(hub.messages).toHaveLength(4);
    expect(buyerErrors).not.toHaveBeenCalled();
    expect(sellerErrors).not.toHaveBeenCalled();
    buyerTransport.stop();
    sellerTransport.stop();
  });

  test("replays an inbound packet from Demos history after the receiver restarts", async () => {
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const buyerTransport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const sellerErrors = vi.fn();
    const sellerTransport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(SELLER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      localClaim: SELLER,
      localPeerKey: SELLER_PEER,
      peerForClaim,
      claimForPeer,
      onError: sellerErrors,
    });
    const reservation = durableReservation();
    const buyerClient = createDurableRfqLifecycleClient(
      clientOptions("buyer", buyerTransport, reservation),
    );
    const sellerClient = createDurableRfqLifecycleClient(
      clientOptions("seller", sellerTransport, reservation),
    );
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());

    // No seller handler is registered when the server accepts the packet.
    await expect(
      buyerClient.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      }),
    ).resolves.toMatchObject({ status: "ready" });
    let sellerStatus = await sellerClient.getStatus(JOB_ID);
    expect(
      sellerStatus.status === "ok" && sellerStatus.record.transcript.length,
    ).toBe(0);

    sellerTransport.start((packet) => sellerClient.receive(packet));
    await expect(sellerTransport.resumeInbound(BUYER)).resolves.toEqual({
      status: "complete",
      delivered: 1,
    });
    sellerStatus = await sellerClient.getStatus(JOB_ID);
    expect(
      sellerStatus.status === "ok" && sellerStatus.record.transcript.length,
    ).toBe(1);
    await expect(sellerTransport.resumeInbound(BUYER)).resolves.toEqual({
      status: "complete",
      delivered: 1,
    });
    expect(sellerErrors).not.toHaveBeenCalled();
    sellerTransport.stop();
  });

  test("never redrives when history binds the packet hash to unreadable ciphertext", async () => {
    const hub = new FakeL2psHub();
    const buyerTransport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const buyerClient = createDurableRfqLifecycleClient(
      clientOptions("buyer", buyerTransport, durableReservation()),
    );
    await buyerClient.open(openInput());
    hub.loseNextResponse = true;
    await expect(
      buyerClient.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      }),
    ).resolves.toMatchObject({ status: "indeterminate" });
    const stored = hub.messages[0];
    if (stored === undefined) throw new Error("accepted frame is missing");
    const ciphertext = Buffer.from(stored.encrypted.ciphertext, "base64");
    ciphertext[0] = ciphertext[0]! ^ 1;
    stored.encrypted.ciphertext = ciphertext.toString("base64");

    await expect(buyerClient.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "rejected",
      reason: "Demos L2PS history binds packetId to different bytes or route",
    });
    expect(hub.sends).toBe(1);
    const status = await buyerClient.getStatus(JOB_ID);
    expect(status.status).toBe("ok");
    if (status.status !== "ok") return;
    expect(status.record.failure).toMatchObject({ class: "transport" });
  });

  test("keeps a transient seal failure retryable until authenticated absence", async () => {
    const hub = new FakeL2psHub();
    const baseCodec = createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) });
    let failSeal = true;
    const codec: DemosL2psRfqWireCodec = {
      codecId: baseCodec.codecId,
      seal(plaintext, context) {
        if (failSeal) {
          failSeal = false;
          throw new Error("transient codec outage");
        }
        return baseCodec.seal(plaintext, context);
      },
      open(encrypted, context) {
        return baseCodec.open(encrypted, context);
      },
    };
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec,
      l2psUid: L2PS_UID,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());

    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "indeterminate" });
    expect(hub.sends).toBe(0);
    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    expect(hub.sends).toBe(1);
  });

  test("keeps a transient peer-mapping failure retryable", async () => {
    const hub = new FakeL2psHub();
    let failMapping = true;
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim(claim) {
        if (failMapping) {
          failMapping = false;
          throw new Error("transient mapping outage");
        }
        return peerForClaim(claim);
      },
      claimForPeer,
      onError: vi.fn(),
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());

    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "indeterminate" });
    expect(hub.sends).toBe(0);
    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    expect(hub.sends).toBe(1);
  });

  test("rejects a malformed encrypted frame before peer send", async () => {
    const hub = new FakeL2psHub();
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: {
        codecId: "malformed-frame-test",
        seal: () => ({} as never),
        open: () => new Uint8Array(),
      },
      l2psUid: L2PS_UID,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());

    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "rejected" });
    expect(hub.sends).toBe(0);
  });

  test("captures receiver-bound peer, codec, mapping, and error capabilities once", async () => {
    const hub = new FakeL2psHub();
    const backingPeer = hub.peer(BUYER_PEER);
    let registered: DemosL2psRfqMessageHandler | undefined;
    let removed = false;
    const peer: DemosL2psRfqPeerLike = {
      send(to, encrypted, messageHash) {
        expect(this).toBe(peer);
        return backingPeer.send(to, encrypted, messageHash);
      },
      history(peerKey, historyOptions) {
        expect(this).toBe(peer);
        return backingPeer.history(peerKey, historyOptions);
      },
      onMessage(handler) {
        expect(this).toBe(peer);
        registered = handler;
      },
      removeMessageHandler(handler) {
        expect(this).toBe(peer);
        expect(handler).toBe(registered);
        removed = true;
      },
    };
    const backingCodec = createDemosL2psRfqAesGcmCodec({
      sharedKey: randomBytes(32),
    });
    const codec: DemosL2psRfqWireCodec = {
      codecId: backingCodec.codecId,
      seal(plaintext, context) {
        expect(this).toBe(codec);
        return backingCodec.seal(plaintext, context);
      },
      open(encrypted, context) {
        expect(this).toBe(codec);
        return backingCodec.open(encrypted, context);
      },
    };
    const errors: Error[] = [];
    let options!: DemosL2psRfqTransportOptions;
    options = {
      peer,
      codec,
      l2psUid: L2PS_UID,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim(claim) {
        expect(this).toBe(options);
        return peerForClaim(claim);
      },
      claimForPeer(peerKey) {
        expect(this).toBe(options);
        return claimForPeer(peerKey);
      },
      onError(error) {
        expect(this).toBe(options);
        errors.push(error);
      },
    };
    const transport = createDemosL2psRfqTransport<string>(options);
    peer.send = async () => { throw new Error("swapped send"); };
    peer.history = async () => { throw new Error("swapped history"); };
    peer.onMessage = () => { throw new Error("swapped onMessage"); };
    peer.removeMessageHandler = () => { throw new Error("swapped remove handler"); };
    codec.seal = () => { throw new Error("swapped seal"); };
    codec.open = () => { throw new Error("swapped open"); };
    options.peerForClaim = () => { throw new Error("swapped peer mapping"); };
    options.claimForPeer = () => { throw new Error("swapped claim mapping"); };
    options.onError = () => { throw new Error("swapped error handler"); };

    transport.start(async () => ({ status: "duplicate", record: {} as never }));
    if (registered === undefined) throw new Error("message handler was not registered");
    registered({} as never);
    await transport.drain();
    expect(errors).toHaveLength(1);
    transport.stop();
    expect(removed).toBe(true);

    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());
    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "ready" });
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record did not load");
    const packet = status.record.outbox[0]?.packet;
    if (packet === undefined) throw new Error("outbox packet missing");
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "acknowledged",
    });
  });

  test("keeps a slow or failing history decryption retryable instead of terminal", async () => {
    const hub = new FakeL2psHub();
    const baseCodec = createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) });
    const openFaults: Array<"hang" | "throw"> = ["hang", "throw"];
    const codec: DemosL2psRfqWireCodec = {
      codecId: baseCodec.codecId,
      seal(plaintext, context) {
        return baseCodec.seal(plaintext, context);
      },
      open(encrypted, context) {
        const fault = openFaults.shift();
        if (fault === "hang") return new Promise<Uint8Array>(() => {});
        if (fault === "throw") throw new Error("transient KMS outage");
        return baseCodec.open(encrypted, context);
      },
    };
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec,
      l2psUid: L2PS_UID,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
      operationTimeoutMs: 50,
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());
    hub.loseNextResponse = true;
    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "indeterminate" });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
        status: "indeterminate",
      });
      const status = await client.getStatus(JOB_ID);
      if (status.status !== "ok") throw new Error("record did not load");
      expect(status.record.failure).toBeUndefined();
    }
    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    expect(hub.sends).toBe(1);
  });

  test("ignores a counterparty-authored history entry that reuses the packet hash", async () => {
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());
    hub.loseNextResponse = true;
    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "indeterminate" });
    const own = hub.messages[0];
    if (own === undefined) throw new Error("accepted frame is missing");
    const counterparty: DemosL2psRfqStoredMessage = {
      id: "counterparty-reuse",
      from: SELLER_PEER,
      to: BUYER_PEER,
      messageHash: own.messageHash,
      encrypted: await createDemosL2psRfqAesGcmCodec({ sharedKey }).seal(
        new TextEncoder().encode("{}"),
        { messageHash: own.messageHash, fromPeer: SELLER_PEER, toPeer: BUYER_PEER },
      ),
      l2psUid: L2PS_UID,
      l2psTxHash: null,
      timestamp: NOW + 100,
      status: "delivered",
    };
    hub.messages.push(counterparty);

    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    expect(hub.sends).toBe(1);
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record did not load");
    expect(status.record.failure).toBeUndefined();
    const packet = status.record.outbox[0]?.packet;
    if (packet === undefined) throw new Error("outbox packet missing");

    // Without our own entry the counterparty frame proves nothing either way.
    hub.messages.splice(hub.messages.indexOf(own), 1);
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "absent",
    });
  });

  test("separates a subnet mismatch from a definite packet-hash conflict", async () => {
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(BUYER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());
    await expect(client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "ready" });
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record did not load");
    const packet = status.record.outbox[0]?.packet;
    const own = hub.messages[0];
    if (packet === undefined || own === undefined) throw new Error("frame missing");

    own.l2psUid = "l2ps:another-subnet";
    await expect(transport.reconcile(packet)).resolves.toMatchObject({
      disposition: "indeterminate",
    });

    own.l2psUid = L2PS_UID;
    own.encrypted = await createDemosL2psRfqAesGcmCodec({ sharedKey }).seal(
      new TextEncoder().encode(
        canonicalize({ ...packet, packetId: "f".repeat(64) } as unknown as Record<string, unknown>),
      ),
      { messageHash: packet.packetId, fromPeer: BUYER_PEER, toPeer: SELLER_PEER },
    );
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "rejected",
      reason: "Demos L2PS history binds packetId to different bytes or route",
    });
  });

  test("bounds an unresponsive Demos send and retains an indeterminate outbox", async () => {
    const peer: DemosL2psRfqPeerLike = {
      async send() {
        return new Promise(() => {});
      },
      async history() {
        return { messages: [], hasMore: false };
      },
      onMessage() {},
    };
    const transport = createDemosL2psRfqTransport<string>({
      peer,
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
      operationTimeoutMs: 10,
    });
    const client = createDurableRfqLifecycleClient(
      clientOptions("buyer", transport, durableReservation()),
    );
    await client.open(openInput());
    await expect(
      client.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      }),
    ).resolves.toMatchObject({
      status: "indeterminate",
      reason: "Demos L2PS RFQ send outcome is unknown",
    });
    const status = await client.getStatus(JOB_ID);
    expect(status.status).toBe("ok");
    if (status.status !== "ok") return;
    expect(status.record.outbox[0]).toMatchObject({ state: "indeterminate" });
  });

  test("refuses an oversized live payload before the canonical snapshot", async () => {
    const hub = new FakeL2psHub();
    const errors: Error[] = [];
    const transport = createDemosL2psRfqTransport<string>({
      peer: hub.peer(SELLER_PEER),
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      localClaim: SELLER,
      localPeerKey: SELLER_PEER,
      peerForClaim,
      claimForPeer,
      onError: (error) => errors.push(error),
    });
    const received = vi.fn();
    transport.start(received);
    const deliver = async (ciphertext: string) => {
      const payload: DemosL2psRfqIncomingPayload = {
        from: BUYER_PEER,
        encrypted: { ciphertext, nonce: Buffer.alloc(12).toString("base64") },
        messageHash: "d".repeat(64),
      };
      snapshotLabels.length = 0;
      for (const handler of hub.handlers.get(SELLER_PEER) ?? []) handler(payload);
      await transport.drain();
    };

    await deliver("A".repeat(MAX_CIPHERTEXT_CHARS + 4));
    expect(errors.map((error) => error.message)).toEqual([
      "ciphertext exceeds its size limit",
    ]);
    expect(snapshotLabels).not.toContain("Demos L2PS incoming RFQ payload");
    expect(snapshotLabels).not.toContain("Demos L2PS encrypted RFQ frame");

    // Control: an in-limit frame reaches the snapshot and fails later on.
    await deliver("A".repeat(64));
    expect(snapshotLabels).toContain("Demos L2PS incoming RFQ payload");
    expect(errors).toHaveLength(2);
    expect(received).not.toHaveBeenCalled();
    transport.stop();
  }, 60_000);

  test("refuses an oversized history array before the canonical snapshot", async () => {
    let page: DemosL2psRfqHistoryPage | undefined;
    const { transport, packet, own } = await buyerWithSentOffer({
      history: (base) => async (peerKey, options) => page ?? base(peerKey, options),
    });
    const duplicates = Array.from({ length: 101 }, (_, index) => ({
      ...structuredClone(own),
      id: `duplicate-${index}`,
      timestamp: own.timestamp + index,
    }));

    page = { messages: duplicates, hasMore: false };
    snapshotLabels.length = 0;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "Demos L2PS RFQ history reconciliation failed",
    });
    expect(snapshotLabels).not.toContain("Demos L2PS RFQ history response");

    // Control: the same entries within the page limit are snapshotted and match.
    page = { messages: duplicates.slice(0, 100), hasMore: false };
    snapshotLabels.length = 0;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "acknowledged",
    });
    expect(snapshotLabels).toContain("Demos L2PS RFQ history response");
  });

  test("refuses a history page over the aggregate budget before the canonical snapshot", async () => {
    let page: DemosL2psRfqHistoryPage | undefined;
    const { transport, packet, own } = await buyerWithSentOffer({
      history: (base) => async (peerKey, options) => page ?? base(peerKey, options),
    });
    // Each frame is within the per-frame limit; two together exceed the page budget.
    const bulk = "A".repeat(17_000_000);
    const counterparty = (
      index: number,
      ciphertext = bulk,
    ): DemosL2psRfqStoredMessage => ({
      id: `bulk-${index}`,
      from: SELLER_PEER,
      to: BUYER_PEER,
      messageHash: "d".repeat(64),
      encrypted: { ciphertext, nonce: own.encrypted.nonce },
      l2psUid: L2PS_UID,
      l2psTxHash: null,
      timestamp: own.timestamp + 10 + index,
      status: "delivered",
    });

    page = { messages: [counterparty(0), counterparty(1)], hasMore: false };
    snapshotLabels.length = 0;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "Demos L2PS RFQ history reconciliation failed",
    });
    expect(snapshotLabels).not.toContain("Demos L2PS RFQ history response");

    // Control: an in-budget page is snapshotted; with our frame absent it is an
    // exhaustive absence proof.
    page = {
      messages: [counterparty(0, "A".repeat(1_000_000)), counterparty(1, "A".repeat(1_000_000))],
      hasMore: false,
    };
    snapshotLabels.length = 0;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "absent",
    });
    expect(snapshotLabels).toContain("Demos L2PS RFQ history response");
  }, 60_000);

  test("refuses an oversized send acknowledgement before the canonical snapshot", async () => {
    const { hub, packet } = await buyerWithSentOffer();
    const send = hub.peer(BUYER_PEER).send;
    let bloated = true;
    const bloatedTransport = createDemosL2psRfqTransport<string>({
      peer: {
        ...hub.peer(BUYER_PEER),
        async send(to, encrypted, messageHash) {
          const result = await send(to, encrypted, messageHash);
          return bloated
            ? { ...result, l2psStatus: "s".repeat(1_000_000) as "submitted" }
            : result;
        },
      },
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey: randomBytes(32) }),
      l2psUid: L2PS_UID,
      localClaim: BUYER,
      localPeerKey: BUYER_PEER,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });

    snapshotLabels.length = 0;
    await expect(bloatedTransport.publish(packet)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "Demos L2PS RFQ send acknowledgement is missing or failed",
    });
    expect(snapshotLabels).not.toContain("Demos L2PS RFQ send acknowledgement");

    bloated = false;
    snapshotLabels.length = 0;
    await expect(bloatedTransport.publish(packet)).resolves.toEqual({
      disposition: "acknowledged",
    });
    expect(snapshotLabels).toContain("Demos L2PS RFQ send acknowledgement");
  });

  test("shares one decryption budget across duplicate own frames", async () => {
    let opens = 0;
    let hang = true;
    const { hub, transport, packet, own } = await buyerWithSentOffer({
      operationTimeoutMs: 100,
      codec: (base) => ({
        codecId: base.codecId,
        seal: (plaintext, context) => base.seal(plaintext, context),
        open(encrypted, context) {
          opens += 1;
          return hang ? new Promise<Uint8Array>(() => {}) : base.open(encrypted, context);
        },
      }),
    });
    for (let index = 1; index < 5; index += 1) {
      hub.messages.push({
        ...structuredClone(own),
        id: `duplicate-${index}`,
        timestamp: own.timestamp + index,
      });
    }

    const startedAt = performance.now();
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "Demos L2PS RFQ history decryption failed",
    });
    // Five serial per-frame timeouts would take at least 500 ms.
    expect(performance.now() - startedAt).toBeLessThan(400);
    expect(opens).toBe(1);

    hang = false;
    opens = 0;
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "acknowledged",
    });
    expect(opens).toBe(5);
  });

  test("finds a definite conflict behind an unavailable own frame", async () => {
    let fault: "throw" | "hang" | "none" = "none";
    let faulty: string | undefined;
    const { hub, sharedKey, transport, packet, own } = await buyerWithSentOffer({
      operationTimeoutMs: 100,
      codec: (base) => ({
        codecId: base.codecId,
        seal: (plaintext, context) => base.seal(plaintext, context),
        open(encrypted, context) {
          if (fault === "hang") return new Promise<Uint8Array>(() => {});
          if (fault === "throw" && encrypted.ciphertext === faulty) {
            throw new Error("transient KMS outage");
          }
          return base.open(encrypted, context);
        },
      }),
    });
    // History is newest first: the unavailable frame is opened before the conflict.
    hub.messages.push({
      ...structuredClone(own),
      id: "conflict",
      timestamp: own.timestamp + 10,
      encrypted: await createDemosL2psRfqAesGcmCodec({ sharedKey }).seal(
        new TextEncoder().encode(
          canonicalize({ ...packet, packetId: "f".repeat(64) } as unknown as Record<string, unknown>),
        ),
        { messageHash: packet.packetId, fromPeer: BUYER_PEER, toPeer: SELLER_PEER },
      ),
    });
    hub.messages.push({
      ...structuredClone(own),
      id: "unavailable",
      timestamp: own.timestamp + 20,
    });
    faulty = own.encrypted.ciphertext;
    const conflict = {
      disposition: "rejected",
      reason: "Demos L2PS history binds packetId to different bytes or route",
    };

    // A fast codec failure leaves budget to reach the conflict in the same call.
    fault = "throw";
    await expect(transport.reconcile(packet)).resolves.toEqual(conflict);

    // A hanging codec spends the budget: retryable now, terminal once it answers.
    fault = "hang";
    await expect(transport.reconcile(packet)).resolves.toMatchObject({
      disposition: "indeterminate",
    });
    fault = "none";
    await expect(transport.reconcile(packet)).resolves.toEqual(conflict);
    expect(hub.sends).toBe(1);
  });

  test("keeps an own history entry with a failed submission status indeterminate", async () => {
    const { hub, transport, client, packet, own } = await buyerWithSentOffer();
    own.status = "failed";

    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "Demos L2PS history records a failed submission with unknown delivery",
    });
    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "indeterminate",
    });
    expect(hub.sends).toBe(1);
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record did not load");
    expect(status.record.failure).toBeUndefined();
    expect(status.record.outbox[0]).toMatchObject({ state: "indeterminate" });
  });

  test("ignores our own packet hash sent to a different recipient peer", async () => {
    let page: DemosL2psRfqHistoryPage | undefined;
    const { baseCodec, transport, packet, own } = await buyerWithSentOffer({
      history: (base) => async (peerKey, options) => page ?? base(peerKey, options),
    });
    const elsewhere = { messageHash: packet.packetId, fromPeer: BUYER_PEER, toPeer: THIRD_PEER };
    page = {
      messages: [{
        ...structuredClone(own),
        to: THIRD_PEER,
        encrypted: await baseCodec.seal(
          new TextEncoder().encode(canonicalize(packet as unknown as Record<string, unknown>)),
          elsewhere,
        ),
      }],
      hasMore: false,
    };
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "absent",
    });
  });

  test("ignores another sender's frame to our recipient that reuses the packet hash", async () => {
    let page: DemosL2psRfqHistoryPage | undefined;
    const { baseCodec, transport, packet, own } = await buyerWithSentOffer({
      history: (base) => async (peerKey, options) => page ?? base(peerKey, options),
    });
    const otherSender = { messageHash: packet.packetId, fromPeer: THIRD_PEER, toPeer: SELLER_PEER };
    page = {
      messages: [{
        ...structuredClone(own),
        from: THIRD_PEER,
        encrypted: await baseCodec.seal(new TextEncoder().encode("{}"), otherSender),
      }],
      hasMore: false,
    };
    await expect(transport.reconcile(packet)).resolves.toEqual({
      disposition: "absent",
    });
  });

  test("retires the old handler on stop when the peer cannot remove it", async () => {
    const hub = new FakeL2psHub();
    const sharedKey = randomBytes(32);
    const sellerPeer: DemosL2psRfqPeerLike = { ...hub.peer(SELLER_PEER) };
    delete sellerPeer.removeMessageHandler;
    const options = (localClaim: string, localPeerKey: string, peer: DemosL2psRfqPeerLike) => ({
      peer,
      codec: createDemosL2psRfqAesGcmCodec({ sharedKey }),
      l2psUid: L2PS_UID,
      localClaim,
      localPeerKey,
      peerForClaim,
      claimForPeer,
      onError: vi.fn(),
    });
    const buyerTransport = createDemosL2psRfqTransport<string>(
      options(BUYER, BUYER_PEER, hub.peer(BUYER_PEER)),
    );
    const sellerTransport = createDemosL2psRfqTransport<string>(
      options(SELLER, SELLER_PEER, sellerPeer),
    );
    const reservation = durableReservation();
    const buyerClient = createDurableRfqLifecycleClient(
      clientOptions("buyer", buyerTransport, reservation),
    );
    const sellerClient = createDurableRfqLifecycleClient(
      clientOptions("seller", sellerTransport, reservation),
    );
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());

    const retired = vi.fn();
    sellerTransport.start(retired);
    sellerTransport.stop();
    const current = vi.fn((packet: unknown) => sellerClient.receive(packet));
    sellerTransport.start(current);
    expect(hub.handlers.get(SELLER_PEER)?.size).toBe(2);

    await expect(buyerClient.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    })).resolves.toMatchObject({ status: "ready" });
    await sellerTransport.drain();
    expect(retired).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
    sellerTransport.stop();
  });
});
