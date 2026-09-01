import { randomBytes } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
  canonicalize,
  contentHash,
  createDemosL2psRfqAesGcmCodec,
  createDemosL2psRfqTransport,
  createDurableRfqLifecycleClient,
  createInMemoryDurableRfqLifecycleStore,
  type AttestationRef,
  type DemosL2psRfqEncryptedMessage,
  type DemosL2psRfqHistoryPage,
  type DemosL2psRfqIncomingPayload,
  type DemosL2psRfqMessageHandler,
  type DemosL2psRfqPeerLike,
  type DemosL2psRfqStoredMessage,
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

describe("Demos L2PS durable RFQ transport", () => {
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
});
