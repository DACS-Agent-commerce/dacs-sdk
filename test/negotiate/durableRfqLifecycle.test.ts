import {
  createHash,
  generateKeyPairSync,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
  canonicalize,
  contentHash,
  createDurableRfqLifecycleClient,
  createFixedPriceAgreementSignatureContribution,
  createFixedPriceAgreementSigningPlan,
  createInMemoryDurableRfqLifecycleStore,
  createInMemoryRfqLifecycleNetwork,
  parseRfqLifecyclePacket,
  rfqLifecyclePacketId,
  type AttestationRef,
  type ChannelMessageSignatureVerificationInput,
  type DurableRfqLifecycleClient,
  type DurableRfqLifecycleRecord,
  type DurableRfqLifecycleStore,
  type DurableRfqLifecycleTransport,
  type IdentityBundle,
  type Listing,
  type RfqChannelReservationInput,
  type RfqLifecyclePacket,
  type RfqTurnBody,
  type VerifiedListingInput,
} from "../../src/index.js";

const NOW = 1_780_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const BUYER = "did:demos:buyer-durable-rfq";
const SELLER = "did:demos:seller-durable-rfq";

const buyerKeys = generateKeyPairSync("ed25519");
const sellerKeys = generateKeyPairSync("ed25519");
const publicKeys = new Map<string, KeyObject>([
  [BUYER, buyerKeys.publicKey],
  [SELLER, sellerKeys.publicKey],
]);

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
  vetRecordRef: vetRef("stor:buyer-durable-rfq-vet"),
};
const seller = {
  identityBundle: identity(SELLER),
  vetRecordRef: vetRef("stor:seller-durable-rfq-vet"),
};

function listing(): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 3,
    listingId: "durable-rfq-listing",
    requiredCapabilities: ["SR-2", "SR-4"],
    seller: {
      identity: identity(SELLER),
      displayName: "Durable RFQ seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Durable private quote",
      description: "A restart-safe private RFQ",
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
      {
        kind: "negotiate-rfq",
        parameters: { maxTurns: 5, timeoutSec: 10 },
      },
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

function verified(value = listing()): VerifiedListingInput {
  return {
    disposition: "verified",
    listing: value,
    pin: {
      listingId: value.listingId,
      version: value.listingVersion,
      contentHash: contentHash(value as unknown as Record<string, unknown>),
    },
  };
}

function channelSigner(privateKey: KeyObject) {
  return (input: { envelopeHash: string }) =>
    ed25519Sign(null, Buffer.from(input.envelopeHash, "utf8"), privateKey).toString(
      "base64url",
    );
}

function verifyChannel(
  input: Readonly<ChannelMessageSignatureVerificationInput<RfqTurnBody, string>>,
) {
  const key = publicKeys.get(input.message.sender);
  return key !== undefined &&
    ed25519Verify(
      null,
      Buffer.from(input.envelopeHash, "utf8"),
      key,
      Buffer.from(input.message.signature, "base64url"),
    )
    ? ("pass" as const)
    : ("fail" as const);
}

function agreementSigner(party: string, privateKey: KeyObject) {
  return {
    party,
    algorithm: "ed25519" as const,
    sign: (bytes: Uint8Array) => ed25519Sign(null, bytes, privateKey),
  };
}

function verifyAgreement(input: {
  party: string;
  value: string;
  signedBytes: Uint8Array;
}) {
  const key = publicKeys.get(input.party);
  return key !== undefined &&
    ed25519Verify(
      null,
      input.signedBytes,
      key,
      Buffer.from(input.value, "base64url"),
    )
    ? ("valid" as const)
    : ("invalid" as const);
}

function durableReservation() {
  const reservations = new Map<string, string>();
  return (input: Readonly<RfqChannelReservationInput>) => {
    const exact = canonicalize(input);
    const prior = reservations.get(input.channelId);
    if (prior !== undefined && prior !== exact) return "fail" as const;
    reservations.set(input.channelId, exact);
    return "pass" as const;
  };
}

function openInput() {
  return {
    jobId: JOB_ID,
    verifiedListing: verified(),
    buyer,
    seller,
    channelId: "durable-private-channel-01",
  };
}

function clients(
  transport: DurableRfqLifecycleTransport<string>,
  reservation = durableReservation(),
  nowMs = () => NOW,
) {
  const buyerClient = createDurableRfqLifecycleClient({
    role: "buyer",
    store: createInMemoryDurableRfqLifecycleStore<string>(),
    transport,
    reserveChannelId: reservation,
    signChannelMessage: channelSigner(buyerKeys.privateKey),
    verifyChannelMessage: verifyChannel,
    agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
    verifyAgreementContribution: verifyAgreement,
    nowMs,
  });
  const sellerClient = createDurableRfqLifecycleClient({
    role: "seller",
    store: createInMemoryDurableRfqLifecycleStore<string>(),
    transport,
    reserveChannelId: reservation,
    signChannelMessage: channelSigner(sellerKeys.privateKey),
    verifyChannelMessage: verifyChannel,
    agreementSigner: agreementSigner(SELLER, sellerKeys.privateKey),
    verifyAgreementContribution: verifyAgreement,
    nowMs,
  });
  return { buyerClient, sellerClient };
}

async function deliver(
  network: ReturnType<typeof createInMemoryRfqLifecycleNetwork<string>>,
  recipient: string,
  client: DurableRfqLifecycleClient<string>,
) {
  const packet = network.take(recipient);
  if (packet === undefined) throw new Error(`no packet for ${recipient}`);
  const result = await client.receive(packet);
  expect(result.status).toBe("ready");
  return { packet, result };
}

describe("durable two-agent RFQ lifecycle", () => {
  test("fails closed as indeterminate when its durable store is unavailable", async () => {
    const unavailableStore: DurableRfqLifecycleStore<string> = {
      load() {
        throw new Error("database offline");
      },
      create() {
        throw new Error("database offline");
      },
      compareAndSwap() {
        throw new Error("database offline");
      },
    };
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const client = createDurableRfqLifecycleClient({
      role: "buyer",
      store: unavailableStore,
      transport: network.transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: channelSigner(buyerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => NOW,
    });

    await expect(client.open(openInput())).resolves.toEqual({
      status: "indeterminate",
      reason: "RFQ lifecycle store create failed",
    });
    await expect(
      client.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      }),
    ).resolves.toEqual({
      status: "indeterminate",
      reason: "RFQ lifecycle store load failed",
    });
    await expect(client.getStatus(JOB_ID)).resolves.toEqual({
      status: "unavailable",
      reason: "RFQ lifecycle store load failed",
    });
    expect(network.pending(SELLER)).toBe(0);
  });

  test("negotiates, replays safely, and produces the same dual-signed agreement", async () => {
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient, sellerClient } = clients(network.transport);
    const buyerOpened = await buyerClient.open(openInput());
    const sellerOpened = await sellerClient.open(openInput());
    expect(buyerOpened, JSON.stringify(buyerOpened)).toMatchObject({ status: "ready" });
    expect(sellerOpened, JSON.stringify(sellerOpened)).toMatchObject({ status: "ready" });

    await expect(
      buyerClient.sendOffer(
        JOB_ID,
        {
          rfqProposalVersion: "1",
          price: { amount: "9", currency: "USDC" },
        },
      ),
    ).resolves.toMatchObject({ status: "ready" });
    const first = await deliver(network, SELLER, sellerClient);
    await expect(sellerClient.receive(first.packet)).resolves.toMatchObject({
      status: "duplicate",
    });

    const countered = await sellerClient.respond(JOB_ID, () => ({
        action: "counter",
        proposal: {
          rfqProposalVersion: "1",
          price: { amount: "9.5", currency: "USDC" },
        },
      }));
    expect(countered, JSON.stringify(countered)).toMatchObject({ status: "ready" });
    await deliver(network, BUYER, buyerClient);

    await expect(buyerClient.sendAccept(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    await deliver(network, SELLER, sellerClient);

    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({
      status: "ready",
    });
    await deliver(network, SELLER, sellerClient);
    await deliver(network, BUYER, buyerClient);

    const buyerStatus = await buyerClient.getStatus(JOB_ID);
    const sellerStatus = await sellerClient.getStatus(JOB_ID);
    expect(buyerStatus.status).toBe("ok");
    expect(sellerStatus.status).toBe("ok");
    if (buyerStatus.status !== "ok" || sellerStatus.status !== "ok") return;
    expect(buyerStatus.record.session.status).toBe("accepted");
    expect(sellerStatus.record.session.status).toBe("accepted");
    expect(buyerStatus.record.transcript).toHaveLength(3);
    expect(sellerStatus.record.transcript).toEqual(buyerStatus.record.transcript);
    expect(buyerStatus.record.agreement?.finalized).toBeDefined();
    expect(sellerStatus.record.agreement?.finalized).toEqual(
      buyerStatus.record.agreement?.finalized,
    );
    expect(buyerStatus.record.agreement?.finalized?.signatures).toHaveLength(2);
    expect(network.pending(BUYER)).toBe(0);
    expect(network.pending(SELLER)).toBe(0);
  });

  test("policy hooks cannot bypass the Listing price band", async () => {
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient, sellerClient } = clients(network.transport);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(
      JOB_ID,
      {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      },
    );
    await deliver(network, SELLER, sellerClient);
    await expect(
      sellerClient.respond(JOB_ID, () => ({
        action: "counter",
        proposal: {
          rfqProposalVersion: "1",
          price: { amount: "100", currency: "USDC" },
        },
      })),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(network.pending(BUYER)).toBe(0);
    const status = await sellerClient.getStatus(JOB_ID);
    expect(status.status === "ok" && status.record.session.turnCount).toBe(1);
  });

  test("reconciles an ambiguous publish before redriving the exact packet", async () => {
    const accepted = new Map<string, RfqLifecyclePacket<string>>();
    let first = true;
    const publish = vi.fn(async (packet: Readonly<RfqLifecyclePacket<string>>) => {
      if (first) {
        first = false;
        return { disposition: "indeterminate" as const, reason: "lost response" };
      }
      accepted.set(packet.packetId, structuredClone(packet));
      return { disposition: "acknowledged" as const };
    });
    const transport: DurableRfqLifecycleTransport<string> = {
      publish,
      async reconcile(packet) {
        return accepted.has(packet.packetId)
          ? { disposition: "acknowledged" as const }
          : { disposition: "absent" as const };
      },
    };
    const sign = vi.fn(channelSigner(buyerKeys.privateKey));
    const store = createInMemoryDurableRfqLifecycleStore<string>();
    const clientOptions = {
      role: "buyer",
      store,
      transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: sign,
      verifyChannelMessage: verifyChannel,
      agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => NOW,
    } as const;
    const client = createDurableRfqLifecycleClient(clientOptions);
    await client.open(openInput());
    await expect(
      client.sendOffer(
        JOB_ID,
        {
          rfqProposalVersion: "1",
          price: { amount: "9", currency: "USDC" },
        },
      ),
    ).resolves.toMatchObject({ status: "indeterminate" });
    const restarted = createDurableRfqLifecycleClient(clientOptions);
    await expect(restarted.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]![0]).toEqual(publish.mock.calls[0]![0]);
    expect(accepted.size).toBe(1);
  });

  test.each([
    ["acknowledged", undefined, "ready"],
    ["rejected", "member transport refused packet", "rejected"],
  ] as const)(
    "preserves a concurrently terminal %s outbox entry over a late publish response",
    async (reconciledDisposition, reconciledReason, expectedStatus) => {
      let releasePublish!: () => void;
      const publishGate = new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
      let publishStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        publishStarted = resolve;
      });
      const transport: DurableRfqLifecycleTransport<string> = {
        async publish() {
          publishStarted();
          await publishGate;
          return { disposition: "indeterminate", reason: "late lost response" };
        },
        async reconcile() {
          return reconciledDisposition === "acknowledged"
            ? { disposition: "acknowledged" }
            : { disposition: "rejected", reason: reconciledReason! };
        },
      };
      const store = createInMemoryDurableRfqLifecycleStore<string>();
      const client = createDurableRfqLifecycleClient({
        role: "buyer",
        store,
        transport,
        reserveChannelId: durableReservation(),
        signChannelMessage: channelSigner(buyerKeys.privateKey),
        verifyChannelMessage: verifyChannel,
        agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
        verifyAgreementContribution: verifyAgreement,
        nowMs: () => NOW,
      });

      const sending = client.open(openInput()).then(() => client.sendOffer(
        JOB_ID,
        {
          rfqProposalVersion: "1",
          price: { amount: "9", currency: "USDC" },
        },
      ));
      await started;
      await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
        status: expectedStatus,
      });
      releasePublish();
      await expect(sending).resolves.toMatchObject({ status: expectedStatus });
      const loaded = await store.load("buyer", JOB_ID);
      if (loaded.status !== "ok") throw new Error("record did not load");
      expect(loaded.record.outbox[0]).toMatchObject({
        state: reconciledDisposition,
        ...(reconciledReason === undefined ? {} : { reason: reconciledReason }),
      });
      if (reconciledDisposition === "rejected") {
        expect(loaded.record.failure).toMatchObject({
          class: "transport",
          packetId: loaded.record.outbox[0]!.packet.packetId,
          reason: reconciledReason,
        });
      } else {
        expect(loaded.record.failure).toBeUndefined();
      }
    },
  );

  test.each(["jobId", "channelId"] as const)(
    "rejects an outbox packet with a foreign %s before reconciliation",
    async (field) => {
      const base = createInMemoryDurableRfqLifecycleStore<string>();
      let tamper = false;
      const store = {
        async load(role: "buyer" | "seller", jobId: string) {
          const loaded = await base.load(role, jobId);
          if (!tamper || loaded.status !== "ok") return loaded;
          const record = structuredClone(loaded.record);
          const packet = record.outbox[0]?.packet;
          if (!packet) throw new Error("outbox packet missing");
          if (field === "jobId") {
            packet.jobId = "01J8ME0SXKQ4T9V2RC5HJ6WX7F";
          } else {
            packet.channelId = "foreign-private-channel";
            if (packet.kind === "turn") {
              packet.message.channelId = packet.channelId;
            }
          }
          const { packetId: _packetId, ...unsigned } = packet;
          packet.packetId = rfqLifecyclePacketId(unsigned);
          return { status: "ok" as const, record };
        },
        create: base.create.bind(base),
        compareAndSwap: base.compareAndSwap.bind(base),
      };
      const reconcile = vi.fn(async () => ({ disposition: "absent" as const }));
      const client = createDurableRfqLifecycleClient({
        role: "buyer",
        store,
        transport: {
          async publish() {
            return { disposition: "indeterminate", reason: "lost response" };
          },
          reconcile,
        },
        reserveChannelId: durableReservation(),
        signChannelMessage: channelSigner(buyerKeys.privateKey),
        verifyChannelMessage: verifyChannel,
        agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
        verifyAgreementContribution: verifyAgreement,
        nowMs: () => NOW,
      });
      await client.open(openInput());
      await client.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      });
      tamper = true;

      await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
        status: "rejected",
        reason: expect.stringContaining("outbox routing"),
      });
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  test("uses its trusted clock to persist timeout without signing or publishing a late turn", async () => {
    let now = NOW;
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const reservation = durableReservation();
    const { buyerClient } = clients(network.transport, reservation, () => now);
    const sign = vi.fn(channelSigner(sellerKeys.privateKey));
    const sellerClient = createDurableRfqLifecycleClient({
      role: "seller",
      store: createInMemoryDurableRfqLifecycleStore<string>(),
      transport: network.transport,
      reserveChannelId: reservation,
      signChannelMessage: sign,
      verifyChannelMessage: verifyChannel,
      agreementSigner: agreementSigner(SELLER, sellerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => now,
    });
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    });
    await deliver(network, SELLER, sellerClient);
    now = NOW + 10_001;
    await expect(
      sellerClient.respond(JOB_ID, () => ({
        action: "counter",
        proposal: {
          rfqProposalVersion: "1",
          price: { amount: "9.5", currency: "USDC" },
        },
      })),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(network.pending(BUYER)).toBe(0);
    // The overdue turn never reaches the channel signer.
    expect(sign).not.toHaveBeenCalled();
    const status = await sellerClient.getStatus(JOB_ID);
    expect(status.status).toBe("ok");
    if (status.status !== "ok") return;
    expect(status.record.session.status).toBe("timed-out");
    expect(status.record.session.turnCount).toBe(1);
    expect(status.record.transcript).toHaveLength(1);
    expect(status.record.failure).toMatchObject({ class: "timeout" });
  });

  test("persists permanent transport rejection as a terminal channel failure", async () => {
    const sign = vi.fn(channelSigner(buyerKeys.privateKey));
    const transport: DurableRfqLifecycleTransport<string> = {
      async publish() {
        return { disposition: "rejected", reason: "member transport refused packet" };
      },
      async reconcile() {
        return { disposition: "rejected", reason: "member transport refused packet" };
      },
    };
    const client = createDurableRfqLifecycleClient({
      role: "buyer",
      store: createInMemoryDurableRfqLifecycleStore<string>(),
      transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: sign,
      verifyChannelMessage: verifyChannel,
      agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => NOW,
    });
    await client.open(openInput());
    await expect(
      client.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    await expect(client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "rejected",
    });
    await expect(client.sendAbort(JOB_ID, "retry anyway")).resolves.toMatchObject({
      status: "rejected",
    });
    expect(sign).toHaveBeenCalledTimes(1);
    const status = await client.getStatus(JOB_ID);
    expect(status.status).toBe("ok");
    if (status.status !== "ok") return;
    expect(status.record.failure).toMatchObject({
      class: "transport",
      reason: "member transport refused packet",
    });
    expect(status.record.outbox[0]).toMatchObject({ state: "rejected" });
  });

  test("rejects a cryptographically valid agreement plan that changes accepted terms", async () => {
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient, sellerClient } = clients(network.transport);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    });
    await deliver(network, SELLER, sellerClient);
    await sellerClient.sendAccept(JOB_ID);
    await deliver(network, BUYER, buyerClient);
    await buyerClient.startAgreement(JOB_ID);
    const original = network.take(SELLER);
    if (original?.kind !== "agreement-proposal") {
      throw new Error("expected agreement proposal");
    }
    const substitutedDraft = structuredClone(original.plan.draft);
    substitutedDraft.terms.price.amount = "9.5";
    const plan = createFixedPriceAgreementSigningPlan(substitutedDraft);
    const buyerContribution = await createFixedPriceAgreementSignatureContribution(
      plan,
      "buyer",
      agreementSigner(BUYER, buyerKeys.privateKey),
    );
    const withoutId = {
      packetVersion: "1" as const,
      jobId: original.jobId,
      channelId: original.channelId,
      sender: original.sender,
      recipient: original.recipient,
      kind: "agreement-proposal" as const,
      plan,
      buyerContribution,
    };
    const substituted = {
      ...withoutId,
      packetId: rfqLifecyclePacketId(withoutId),
    };
    await expect(sellerClient.receive(substituted)).resolves.toMatchObject({
      status: "rejected",
      reason: "buyer substituted the RFQ agreement signing plan",
    });
    const status = await sellerClient.getStatus(JOB_ID);
    expect(status.status === "ok" && status.record.agreement).toBeUndefined();
  });

  test("owns a proposal before the first asynchronous store read", async () => {
    const base = createInMemoryDurableRfqLifecycleStore<string>();
    let pauseLoads = false;
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const store = {
      async load(role: "buyer" | "seller", jobId: string) {
        if (pauseLoads) await loadGate;
        return base.load(role, jobId);
      },
      create: base.create.bind(base),
      compareAndSwap: base.compareAndSwap.bind(base),
    };
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const client = createDurableRfqLifecycleClient({
      role: "buyer",
      store,
      transport: network.transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: channelSigner(buyerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => NOW,
    });
    await client.open(openInput());
    pauseLoads = true;
    const proposal = {
      rfqProposalVersion: "1" as const,
      price: { amount: "9", currency: "USDC" },
    };
    const pending = client.sendOffer(JOB_ID, proposal);
    proposal.price.amount = "50";
    releaseLoad();
    await expect(pending).resolves.toMatchObject({ status: "ready" });
    const status = await client.getStatus(JOB_ID);
    expect(
      status.status === "ok" &&
        status.record.session.standingProposal?.price.amount,
    ).toBe("9");
  });

  test("captures receiver-bound dependencies once at client construction", async () => {
    const baseStore = createInMemoryDurableRfqLifecycleStore<string>();
    const store = {
      backing: baseStore,
      load(role: "buyer" | "seller", jobId: string) {
        return this.backing.load(role, jobId);
      },
      create(record: Parameters<typeof baseStore.create>[0]) {
        return this.backing.create(record);
      },
      compareAndSwap(
        role: "buyer" | "seller",
        jobId: string,
        revision: number,
        record: Parameters<typeof baseStore.compareAndSwap>[3],
      ) {
        return this.backing.compareAndSwap(role, jobId, revision, record);
      },
    };
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const options = {
      role: "buyer" as const,
      store,
      transport: network.transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: channelSigner(buyerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => NOW,
    };
    const client = createDurableRfqLifecycleClient(options);
    store.load = () => {
      throw new Error("swapped load");
    };
    options.signChannelMessage = () => {
      throw new Error("swapped signer");
    };
    options.nowMs = () => Number.NaN;
    network.transport.publish = async () => ({
      disposition: "rejected",
      reason: "swapped transport",
    });
    await expect(client.open(openInput())).resolves.toMatchObject({
      status: "ready",
    });
    await expect(
      client.sendOffer(JOB_ID, {
        rfqProposalVersion: "1",
        price: { amount: "9", currency: "USDC" },
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(network.pending(SELLER)).toBe(1);
  });

  test("rejects malformed store success and distinct reopen authority", async () => {
    const base = createInMemoryDurableRfqLifecycleStore<string>();
    let malformedLoad = false;
    const store = {
      load(role: "buyer" | "seller", jobId: string) {
        return malformedLoad
          ? ({ status: "ok", record: {} } as never)
          : base.load(role, jobId);
      },
      create: base.create.bind(base),
      compareAndSwap: base.compareAndSwap.bind(base),
    };
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const client = createDurableRfqLifecycleClient({
      role: "buyer",
      store,
      transport: network.transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: channelSigner(buyerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => NOW,
    });
    await expect(client.open(openInput())).resolves.toMatchObject({
      status: "ready",
    });
    await expect(
      client.open({
        ...openInput(),
        selectedRail: {
          railId: "future-authority",
          railVersion: 1,
        },
      }),
    ).resolves.toMatchObject({ status: "conflict" });
    malformedLoad = true;
    await expect(client.getStatus(JOB_ID)).resolves.toMatchObject({
      status: "corrupt",
    });
  });
});

describe("durable RFQ receive keeps local failures retryable", () => {
  type Fault = "throw" | "error" | "indeterminate" | "fail" | "invalid" | "malformed" | undefined;
  type LoadFault = "throw" | "unavailable" | "corrupt" | "unsupported" | undefined;
  const staleKeys = generateKeyPairSync("ed25519");

  /** A client whose store, clock, verifiers and agreement signer can be made to fail. */
  function flakyClient(
    role: "buyer" | "seller",
    transport: DurableRfqLifecycleTransport<string>,
  ) {
    const claim = role === "buyer" ? BUYER : SELLER;
    const keys = role === "buyer" ? buyerKeys : sellerKeys;
    const faults = {
      load: undefined as LoadFault,
      clock: false,
      // The clock reads earlier than the session's awaitingSince.
      behind: false,
      sign: false,
      // The agreement signer returns a well-formed signature made by another key.
      staleKey: false,
      channel: undefined as Fault,
      agreement: undefined as Fault,
      // When set, the agreement fault answers only for this role's contribution.
      agreementRole: undefined as "buyer" | "seller" | undefined,
    };
    const memory = createInMemoryDurableRfqLifecycleStore<string>();
    const store: DurableRfqLifecycleStore<string> = {
      load: (storeRole, jobId) => {
        if (faults.load === "throw") throw new Error("store offline");
        if (faults.load === "unavailable") return { status: "unavailable", reason: "store offline" };
        if (faults.load === "corrupt") return { status: "corrupt", reason: "stored record is corrupt" };
        if (faults.load === "unsupported") return { status: "unsupported", version: 99 };
        return memory.load(storeRole, jobId);
      },
      create: (record) => memory.create(record),
      compareAndSwap: (storeRole, jobId, revision, next) =>
        memory.compareAndSwap(storeRole, jobId, revision, next),
    };
    const client = createDurableRfqLifecycleClient({
      role,
      store,
      transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: channelSigner(keys.privateKey),
      verifyChannelMessage: (input) => {
        if (faults.channel === "throw") throw new Error("channel verifier offline");
        return faults.channel === undefined
          ? verifyChannel(input)
          : (faults.channel as "error" | "indeterminate" | "fail");
      },
      agreementSigner: {
        party: claim,
        algorithm: "ed25519" as const,
        sign: (bytes: Uint8Array) => {
          if (faults.sign) throw new Error("remote agreement signer offline");
          return ed25519Sign(null, bytes, faults.staleKey ? staleKeys.privateKey : keys.privateKey);
        },
      },
      verifyAgreementContribution: (input) => {
        const fault = faults.agreementRole === undefined || faults.agreementRole === input.role
          ? faults.agreement
          : undefined;
        if (fault === "throw") throw new Error("agreement verifier offline");
        return fault === undefined
          ? verifyAgreement(input)
          : (fault as "error" | "indeterminate" | "invalid");
      },
      nowMs: () => (faults.clock ? Number.NaN : faults.behind ? NOW - 5_000 : NOW),
    });
    return { client, faults };
  }

  /** A normal buyer and a flaky seller, both open, with the buyer's offer sent. */
  async function offered() {
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient } = clients(network.transport);
    const seller = flakyClient("seller", network.transport);
    await buyerClient.open(openInput());
    await seller.client.open(openInput());
    await buyerClient.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    });
    const offer = network.take(SELLER);
    if (offer === undefined) throw new Error("no offer");
    return { network, buyerClient, seller, offer };
  }

  test("a failing clock leaves a turn indeterminate, and the same packet is received later", async () => {
    const { seller, offer } = await offered();
    seller.faults.clock = true;
    await expect(seller.client.receive(offer)).resolves.toEqual({
      status: "indeterminate",
      reason: "durable RFQ clock returned an invalid unix-ms value",
    });
    seller.faults.clock = false;
    await expect(seller.client.receive(offer)).resolves.toMatchObject({ status: "ready" });
  });

  test("a clock behind the session leaves a turn indeterminate until it catches up", async () => {
    const { seller, offer } = await offered();
    seller.faults.behind = true;
    await expect(seller.client.receive(offer)).resolves.toMatchObject({
      status: "indeterminate",
      reason: "RFQ session state or trusted receipt time is inconsistent",
      record: { inboxPacketIds: [] },
    });
    seller.faults.behind = false;
    await expect(seller.client.receive(offer)).resolves.toMatchObject({ status: "ready" });
  });

  test.each([
    { load: "throw", status: "indeterminate", reason: "RFQ lifecycle store load failed" },
    { load: "unavailable", status: "indeterminate", reason: "store offline" },
    { load: "corrupt", status: "rejected", reason: "stored record is corrupt" },
    { load: "unsupported", status: "rejected", reason: "RFQ lifecycle store version 99 is unsupported" },
  ] as const)("a store load answering $load leaves a turn $status", async ({ load, status, reason }) => {
    const { seller, offer } = await offered();
    seller.faults.load = load;
    await expect(seller.client.receive(offer)).resolves.toEqual({ status, reason });
    seller.faults.load = undefined;
    await expect(seller.client.receive(offer)).resolves.toMatchObject({ status: "ready" });
  });

  test.each([
    { fault: "throw", status: "indeterminate", reason: "channel signature verifier failed" },
    { fault: "error", status: "indeterminate", reason: "channel signature verification returned error" },
    { fault: "indeterminate", status: "indeterminate", reason: "channel signature verification returned indeterminate" },
    { fault: "malformed", status: "indeterminate", reason: "channel signature verifier returned a malformed decision" },
    { fault: "fail", status: "rejected", reason: "channel signature verification returned fail" },
  ] as const)("a channel verifier answering $fault leaves a turn $status", async ({ fault, status, reason }) => {
    const { seller, offer } = await offered();
    seller.faults.channel = fault;
    await expect(seller.client.receive(offer)).resolves.toMatchObject({
      status,
      reason,
      record: { inboxPacketIds: [] },
    });
    // Neither answer stores the packet, so it is received once the verifier passes.
    seller.faults.channel = undefined;
    await expect(seller.client.receive(offer)).resolves.toMatchObject({ status: "ready" });
  });

  /** Negotiate to acceptance and return the buyer's agreement proposal. */
  async function proposed() {
    const fixture = await offered();
    await expect(fixture.seller.client.receive(fixture.offer)).resolves.toMatchObject({
      status: "ready",
    });
    await fixture.seller.client.sendAccept(JOB_ID);
    await deliver(fixture.network, BUYER, fixture.buyerClient);
    await fixture.buyerClient.startAgreement(JOB_ID);
    const proposal = fixture.network.take(SELLER);
    if (proposal?.kind !== "agreement-proposal") throw new Error("expected agreement proposal");
    return { ...fixture, proposal };
  }

  test("a failing agreement signer leaves a proposal indeterminate, and it is received later", async () => {
    const { network, seller, proposal } = await proposed();
    seller.faults.sign = true;
    await expect(seller.client.receive(proposal)).resolves.toMatchObject({
      status: "indeterminate",
      reason: "remote agreement signer offline",
    });
    const status = await seller.client.getStatus(JOB_ID);
    expect(status).toMatchObject({ status: "ok", record: {
      agreement: { plan: proposal.plan, contributions: [proposal.buyerContribution] },
    } });
    expect(network.pending(BUYER)).toBe(0);
    seller.faults.sign = false;
    await expect(seller.client.receive(proposal)).resolves.toMatchObject({ status: "ready" });
    expect(network.pending(BUYER)).toBe(1);
  });

  test("an agreement signer using a stale key leaves a proposal indeterminate, and it is received later", async () => {
    const { network, seller, proposal } = await proposed();
    seller.faults.staleKey = true;
    // The signature is well formed; only verifying our own contribution finds the wrong key.
    await expect(seller.client.receive(proposal)).resolves.toMatchObject({
      status: "indeterminate",
      reason: "seller agreement contribution is not cryptographically valid (invalid)",
    });
    await expect(seller.client.getStatus(JOB_ID)).resolves.toMatchObject({ status: "ok", record: {
      agreement: { plan: proposal.plan, contributions: [proposal.buyerContribution] },
    } });
    expect(network.pending(BUYER)).toBe(0);
    seller.faults.staleKey = false;
    await expect(seller.client.receive(proposal)).resolves.toMatchObject({ status: "ready" });
    const after = await seller.client.getStatus(JOB_ID);
    expect(after.status === "ok" && after.record.agreement?.finalized?.signatures).toHaveLength(2);
    expect(network.pending(BUYER)).toBe(1);
  });

  test("a buyer contribution made with a stale key is still rejected by the seller", async () => {
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { sellerClient } = clients(network.transport);
    const buyer = flakyClient("buyer", network.transport);
    await buyer.client.open(openInput());
    await sellerClient.open(openInput());
    await buyer.client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    });
    await deliver(network, SELLER, sellerClient);
    await sellerClient.sendAccept(JOB_ID);
    await deliver(network, BUYER, buyer.client);
    buyer.faults.staleKey = true;
    await buyer.client.startAgreement(JOB_ID);
    const proposal = network.take(SELLER);
    if (proposal === undefined) throw new Error("no agreement proposal");
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({
      status: "rejected",
      reason: "buyer agreement contribution is not cryptographically valid (invalid)",
    });
  });

  test.each([
    { fault: "throw", status: "indeterminate" },
    { fault: "error", status: "indeterminate" },
    { fault: "indeterminate", status: "indeterminate" },
    { fault: "malformed", status: "indeterminate" },
    { fault: "invalid", status: "rejected" },
  ] as const)("a contribution verifier answering $fault leaves a proposal $status", async ({ fault, status }) => {
    const { network, seller, proposal } = await proposed();
    seller.faults.agreement = fault;
    // Finalizing reports a throw or a malformed answer as "error".
    const reported = fault === "throw" || fault === "malformed" ? "error" : fault;
    await expect(seller.client.receive(proposal)).resolves.toMatchObject({
      status,
      reason: `buyer agreement contribution is not cryptographically valid (${reported})`,
    });
    const loaded = await seller.client.getStatus(JOB_ID);
    expect(loaded.status === "ok" && loaded.record.agreement).toBeUndefined();
    expect(network.pending(BUYER)).toBe(0);
    seller.faults.agreement = undefined;
    await expect(seller.client.receive(proposal)).resolves.toMatchObject({ status: "ready" });
  });

  test.each([
    { fault: "throw", whose: "every", role: undefined, status: "indeterminate" },
    { fault: "invalid", whose: "the seller's", role: "seller", status: "rejected" },
    { fault: "invalid", whose: "its own", role: "buyer", status: "indeterminate" },
  ] as const)("a buyer's contribution verifier answering $fault for $whose contribution leaves the seller contribution $status", async ({ fault, role, status }) => {
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { sellerClient } = clients(network.transport);
    const buyer = flakyClient("buyer", network.transport);
    await buyer.client.open(openInput());
    await sellerClient.open(openInput());
    await buyer.client.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    });
    await deliver(network, SELLER, sellerClient);
    await sellerClient.sendAccept(JOB_ID);
    await deliver(network, BUYER, buyer.client);
    await buyer.client.startAgreement(JOB_ID);
    await deliver(network, SELLER, sellerClient);
    const contribution = network.take(BUYER);
    if (contribution === undefined) throw new Error("no seller contribution");
    buyer.faults.agreement = fault;
    buyer.faults.agreementRole = role;
    await expect(buyer.client.receive(contribution)).resolves.toMatchObject({ status });
    const loaded = await buyer.client.getStatus(JOB_ID);
    expect(loaded.status === "ok" && loaded.record.agreement?.finalized).toBeUndefined();
    buyer.faults.agreement = undefined;
    await expect(buyer.client.receive(contribution)).resolves.toMatchObject({ status: "ready" });
  });
});

describe("durable RFQ turn timeout for the waiting member", () => {
  const OFFER = { rfqProposalVersion: "1" as const, price: { amount: "9", currency: "USDC" } };
  const TIMEOUT_REASON = "RFQ turn timeout elapsed (RFQ-4)";

  async function offeredPair(nowMs: () => number) {
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient, sellerClient } = clients(network.transport, durableReservation(), nowMs);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await expect(buyerClient.sendOffer(JOB_ID, OFFER)).resolves.toMatchObject({ status: "ready" });
    return { network, buyerClient, sellerClient };
  }

  async function expectTimedOut(client: DurableRfqLifecycleClient<string>) {
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record missing");
    expect(status.record.session.status).toBe("timed-out");
    expect(status.record.failure).toMatchObject({ class: "timeout", reason: TIMEOUT_REASON });
    return status.record;
  }

  test("the buyer waiting on a silent seller records the timeout once it elapses", async () => {
    let now = NOW;
    const { network, buyerClient } = await offeredPair(() => now);
    // At the 10 s boundary the seller still owns the turn.
    now = NOW + 10_000;
    await expect(buyerClient.sendAbort(JOB_ID, "seller silent")).resolves.toMatchObject({
      status: "rejected", reason: "counterparty owns the next RFQ turn",
    });
    const open = await buyerClient.getStatus(JOB_ID);
    if (open.status !== "ok") throw new Error("record missing");
    expect(open.record.session.status).toBe("open");
    expect(open.record.failure).toBeUndefined();

    now = NOW + 10_001;
    await expect(buyerClient.sendAbort(JOB_ID, "seller silent")).resolves.toMatchObject({
      status: "rejected", reason: TIMEOUT_REASON,
    });
    const record = await expectTimedOut(buyerClient);
    // Nothing was signed or published for the abort.
    expect(record.transcript).toHaveLength(1);
    expect(record.outbox).toHaveLength(1);
    expect(network.pending(SELLER)).toBe(1);
    await expect(buyerClient.respond(JOB_ID, () => ({ action: "abort" }))).resolves.toMatchObject({
      status: "rejected", reason: TIMEOUT_REASON,
    });
  });

  test("the seller waiting on a silent buyer records the timeout, and a late turn is refused", async () => {
    let now = NOW;
    const { network, buyerClient, sellerClient } = await offeredPair(() => now);
    await deliver(network, SELLER, sellerClient);
    await expect(sellerClient.respond(JOB_ID, () => ({
      action: "counter",
      proposal: { rfqProposalVersion: "1", price: { amount: "9.5", currency: "USDC" } },
    }))).resolves.toMatchObject({ status: "ready" });
    await deliver(network, BUYER, buyerClient);

    now = NOW + 10_001;
    await expect(sellerClient.sendAbort(JOB_ID)).resolves.toMatchObject({
      status: "rejected", reason: TIMEOUT_REASON,
    });
    await expectTimedOut(sellerClient);
    // The buyer's accept, sent in time by its own clock, reaches a failed job.
    now = NOW + 5_000;
    await expect(buyerClient.sendAccept(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    const late = network.take(SELLER);
    if (late === undefined) throw new Error("no accept");
    await expect(sellerClient.receive(late)).resolves.toMatchObject({
      status: "rejected", reason: TIMEOUT_REASON,
    });
  });

  test("a turn received after the timeout records it on the receiver", async () => {
    let now = NOW;
    const { network, sellerClient } = await offeredPair(() => now);
    const offer = network.take(SELLER);
    if (offer === undefined) throw new Error("no offer");
    now = NOW + 10_001;
    await expect(sellerClient.receive(offer)).resolves.toMatchObject({
      status: "rejected", reason: TIMEOUT_REASON,
    });
    const record = await expectTimedOut(sellerClient);
    expect(record.transcript).toHaveLength(0);
    expect(record.inboxPacketIds).toEqual([]);
    // The failure is final for every later packet.
    now = NOW + 20_000;
    await expect(sellerClient.receive(offer)).resolves.toMatchObject({
      status: "rejected", reason: TIMEOUT_REASON, record: { failure: { class: "timeout" } },
    });
  });

});

describe("durable RFQ agreement timeout for the waiting member", () => {
  const OFFER = { rfqProposalVersion: "1" as const, price: { amount: "9", currency: "USDC" } };
  const AGREEMENT_TIMEOUT = "RFQ agreement timeout elapsed (RFQ-4)";
  const TERMINAL = "RFQ session is already terminal";

  /** The buyer offers at NOW; the seller receives and accepts at `acceptAt`. */
  async function acceptedPair(clock: { now: number }, acceptAt = NOW) {
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient, sellerClient } = clients(network.transport, durableReservation(), () => clock.now);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await expect(buyerClient.sendOffer(JOB_ID, OFFER)).resolves.toMatchObject({ status: "ready" });
    clock.now = acceptAt;
    await deliver(network, SELLER, sellerClient);
    await expect(sellerClient.respond(JOB_ID, () => ({ action: "accept" }))).resolves.toMatchObject({ status: "ready" });
    return { network, buyerClient, sellerClient };
  }

  async function record(client: DurableRfqLifecycleClient<string>) {
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record missing");
    return status.record;
  }

  test("the seller whose accept is never answered records the timeout once it elapses", async () => {
    const clock = { now: NOW };
    const { network, sellerClient } = await acceptedPair(clock, NOW + 2_000);
    // The buyer never starts the agreement. Acceptance was at NOW + 2,000.
    clock.now = NOW + 12_000;
    await expect(sellerClient.sendAbort(JOB_ID, "buyer silent")).resolves.toMatchObject({
      status: "rejected", reason: TERMINAL,
    });
    expect((await record(sellerClient)).failure).toBeUndefined();

    clock.now = NOW + 12_001;
    await expect(sellerClient.sendAbort(JOB_ID, "buyer silent")).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    const failed = await record(sellerClient);
    expect(failed.session.status).toBe("accepted");
    expect(failed.failure).toEqual({
      failureVersion: "1", class: "timeout", reason: AGREEMENT_TIMEOUT, recordedAt: NOW + 12_001,
    });
    expect(failed.agreement).toBeUndefined();
    // Nothing was signed or published: the accept is the only packet.
    expect(failed.transcript).toHaveLength(2);
    expect(failed.outbox).toHaveLength(1);
    expect(network.pending(BUYER)).toBe(1);
    await expect(sellerClient.resumeOutbox(JOB_ID)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
  });

  test.each([
    [10_000, "ready"],
    [10_001, "rejected"],
  ] as const)("a proposal the seller receives %i ms after acceptance is %s", async (delay, expected) => {
    const clock = { now: NOW };
    const { network, buyerClient, sellerClient } = await acceptedPair(clock);
    clock.now = NOW + 1_000;
    await deliver(network, BUYER, buyerClient);
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    const proposal = network.take(SELLER);
    if (proposal === undefined) throw new Error("no proposal");
    clock.now = NOW + delay;
    const received = await sellerClient.receive(proposal);
    const stored = await record(sellerClient);
    if (expected === "ready") {
      expect(received.status).toBe("ready");
      expect(stored.agreement?.finalized).toBeDefined();
      expect(network.pending(BUYER)).toBe(1);
      return;
    }
    // Refused before the seller signs anything.
    expect(received).toMatchObject({ status: "rejected", reason: AGREEMENT_TIMEOUT });
    expect(stored.failure).toMatchObject({ class: "timeout", reason: AGREEMENT_TIMEOUT });
    expect(stored.agreement).toBeUndefined();
    expect(stored.inboxPacketIds).toHaveLength(1);
    expect(stored.outbox).toHaveLength(1);
    expect(network.pending(BUYER)).toBe(0);
  });

  test("the buyer whose proposal is never countersigned records the timeout once it elapses", async () => {
    const clock = { now: NOW };
    const { network, buyerClient } = await acceptedPair(clock);
    clock.now = NOW + 1_000;
    await deliver(network, BUYER, buyerClient);
    clock.now = NOW + 2_000;
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    // The seller never countersigns. The plan was generated at NOW + 2,000.
    clock.now = NOW + 12_000;
    await expect(buyerClient.sendAbort(JOB_ID)).resolves.toMatchObject({ status: "rejected", reason: TERMINAL });
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "duplicate" });
    expect((await record(buyerClient)).failure).toBeUndefined();

    clock.now = NOW + 12_001;
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    const failed = await record(buyerClient);
    expect(failed.session.status).toBe("accepted");
    expect(failed.failure).toMatchObject({ class: "timeout", reason: AGREEMENT_TIMEOUT, recordedAt: NOW + 12_001 });
    expect(failed.agreement?.finalized).toBeUndefined();
    expect(failed.outbox).toHaveLength(2);
    expect(network.pending(SELLER)).toBe(1);
    await expect(buyerClient.sendAbort(JOB_ID)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
  });

  test("sendAbort records the buyer's timeout while it waits on the contribution", async () => {
    const clock = { now: NOW };
    const { network, buyerClient } = await acceptedPair(clock);
    await deliver(network, BUYER, buyerClient);
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    clock.now = NOW + 10_001;
    await expect(buyerClient.sendAbort(JOB_ID, "seller silent")).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    expect((await record(buyerClient)).failure).toMatchObject({ class: "timeout" });
  });

  test("a buyer that starts the agreement after the acceptance deadline records the timeout instead", async () => {
    const clock = { now: NOW };
    const { network, buyerClient } = await acceptedPair(clock);
    // The buyer's acceptance deadline runs from its own receipt of the accept.
    clock.now = NOW + 1_000;
    await deliver(network, BUYER, buyerClient);
    clock.now = NOW + 11_001;
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    const failed = await record(buyerClient);
    expect(failed.agreement).toBeUndefined();
    expect(failed.outbox).toHaveLength(1);
    expect(network.pending(SELLER)).toBe(0);
  });

  test("a late contribution still finalizes while the buyer has recorded no timeout; after one it is refused", async () => {
    for (const recordFirst of [false, true]) {
      const clock = { now: NOW };
      const { network, buyerClient, sellerClient } = await acceptedPair(clock);
      await deliver(network, BUYER, buyerClient);
      await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
      clock.now = NOW + 5_000;
      await deliver(network, SELLER, sellerClient);
      clock.now = NOW + 20_000;
      if (recordFirst) {
        await expect(buyerClient.sendAbort(JOB_ID)).resolves.toMatchObject({ reason: AGREEMENT_TIMEOUT });
      }
      const contribution = network.take(BUYER);
      if (contribution === undefined) throw new Error("no contribution");
      const received = await buyerClient.receive(contribution);
      if (recordFirst) {
        // The seller holds a finalized agreement; this record holds the timeout.
        expect(received).toMatchObject({ status: "rejected", reason: AGREEMENT_TIMEOUT });
        expect((await record(sellerClient)).agreement?.finalized).toBeDefined();
      } else {
        expect(received.status).toBe("ready");
        expect((await record(buyerClient)).agreement?.finalized).toBeDefined();
      }
    }
  });

  test("acceptance moves awaitingSince to the trusted acceptance time on both members", async () => {
    const clock = { now: NOW };
    const { network, buyerClient, sellerClient } = await acceptedPair(clock, NOW + 2_000);
    expect((await record(sellerClient)).session.awaitingSince).toBe(NOW + 2_000);
    clock.now = NOW + 3_000;
    await deliver(network, BUYER, buyerClient);
    expect((await record(buyerClient)).session.awaitingSince).toBe(NOW + 3_000);
  });
});

describe("durable RFQ timeout whose write the store refuses", () => {
  const OFFER = { rfqProposalVersion: "1" as const, price: { amount: "9", currency: "USDC" } };

  /** A client whose store answers `refusal` to any write that records a failure. */
  function refusingClient(
    role: "buyer" | "seller",
    transport: DurableRfqLifecycleTransport<string>,
    clock: { now: number },
    refusal: { status: "stale" } | { status: "unavailable"; reason: string },
  ) {
    const memory = createInMemoryDurableRfqLifecycleStore<string>();
    const keys = role === "buyer" ? buyerKeys : sellerKeys;
    const claim = role === "buyer" ? BUYER : SELLER;
    return createDurableRfqLifecycleClient({
      role,
      store: {
        load: (storeRole, jobId) => memory.load(storeRole, jobId),
        create: (stored) => memory.create(stored),
        compareAndSwap: (storeRole, jobId, revision, next) =>
          next.failure !== undefined ? refusal : memory.compareAndSwap(storeRole, jobId, revision, next),
      },
      transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: channelSigner(keys.privateKey),
      verifyChannelMessage: verifyChannel,
      agreementSigner: agreementSigner(claim, keys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => clock.now,
    });
  }

  const refusals = [
    [{ status: "stale" } as const, { status: "conflict", reason: "RFQ lifecycle state changed concurrently" }],
    [{ status: "unavailable", reason: "store offline" } as const, { status: "indeterminate", reason: "store offline" }],
  ] as const;

  test.each(refusals)("the waiting member's timeout answers the store's %o", async (refusal, expected) => {
    const clock = { now: NOW };
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const buyerClient = refusingClient("buyer", network.transport, clock, refusal);
    await buyerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, OFFER);
    clock.now = NOW + 10_001;
    await expect(buyerClient.sendAbort(JOB_ID)).resolves.toEqual(expected);
    const stored = await buyerClient.getStatus(JOB_ID);
    expect(stored.status === "ok" && stored.record.failure).toBeUndefined();
  });

  test.each(refusals)("a late turn's timeout on receipt answers the store's %o", async (refusal, expected) => {
    const clock = { now: NOW };
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient } = clients(network.transport, durableReservation(), () => clock.now);
    const sellerClient = refusingClient("seller", network.transport, clock, refusal);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, OFFER);
    const offer = network.take(SELLER);
    clock.now = NOW + 10_001;
    // receive() retries a stale write before it answers conflict.
    await expect(sellerClient.receive(offer)).resolves.toEqual(
      expected.status === "conflict"
        ? { status: "conflict", reason: "RFQ receive CAS retry limit reached" }
        : expected,
    );
    const stored = await sellerClient.getStatus(JOB_ID);
    expect(stored.status === "ok" && stored.record.failure).toBeUndefined();
  });

  test.each(refusals)("the agreement timeout answers the store's %o", async (refusal, expected) => {
    const clock = { now: NOW };
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient } = clients(network.transport, durableReservation(), () => clock.now);
    const sellerClient = refusingClient("seller", network.transport, clock, refusal);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, OFFER);
    await deliver(network, SELLER, sellerClient);
    await sellerClient.sendAccept(JOB_ID);
    clock.now = NOW + 10_001;
    await expect(sellerClient.sendAbort(JOB_ID)).resolves.toEqual(expected);
    const stored = await sellerClient.getStatus(JOB_ID);
    expect(stored.status === "ok" && stored.record.failure).toBeUndefined();
  });
});

describe("durable RFQ receive() rejections and packet parsing", () => {
  const OFFER = { rfqProposalVersion: "1" as const, price: { amount: "9", currency: "USDC" } };

  async function finalizedPair() {
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient, sellerClient } = clients(network.transport);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, OFFER);
    const offer = await deliver(network, SELLER, sellerClient);
    await sellerClient.respond(JOB_ID, () => ({ action: "accept" }));
    await deliver(network, BUYER, buyerClient);
    await buyerClient.startAgreement(JOB_ID);
    const proposal = await deliver(network, SELLER, sellerClient);
    await deliver(network, BUYER, buyerClient);
    return { sellerClient, offer: offer.packet, proposal: proposal.packet };
  }

  /** The packet with its packetId recomputed over its exact bytes. */
  function withId(unsigned: Record<string, unknown>): RfqLifecyclePacket<string> {
    return {
      ...unsigned,
      packetId: rfqLifecyclePacketId(unsigned as unknown as Omit<RfqLifecyclePacket<string>, "packetId">),
    } as unknown as RfqLifecyclePacket<string>;
  }

  function unsignedOf(packet: Readonly<RfqLifecyclePacket<string>>): Record<string, unknown> {
    const { packetId: _packetId, ...unsigned } = structuredClone(packet) as RfqLifecyclePacket<string>;
    return unsigned as unknown as Record<string, unknown>;
  }

  test("a malformed packet is rejected without a record", async () => {
    const { sellerClient, offer } = await finalizedPair();
    await expect(sellerClient.receive({ ...offer, packetId: "b".repeat(64) })).resolves.toEqual({
      status: "rejected", reason: "RFQ lifecycle packetId does not match exact bytes",
    });
  });

  test.each([
    { name: "another channel", channelId: "durable-private-channel-02" },
    { name: "swapped members", swap: true },
  ])("a packet routed to $name is rejected", async ({ channelId, swap }) => {
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient, sellerClient } = clients(network.transport);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, OFFER);
    const offer = network.take(SELLER);
    if (offer === undefined) throw new Error("no offer");
    const unsigned = unsignedOf(offer);
    const message = unsigned.message as Record<string, unknown>;
    if (channelId !== undefined) {
      unsigned.channelId = channelId;
      message.channelId = channelId;
    }
    if (swap) {
      unsigned.sender = SELLER;
      unsigned.recipient = BUYER;
      message.sender = SELLER;
    }
    await expect(sellerClient.receive(withId(unsigned))).resolves.toMatchObject({
      status: "rejected", reason: "RFQ packet routing does not bind this session",
    });
  });

  test("parseRfqLifecyclePacket refuses a packetId that does not hash its exact bytes", async () => {
    const { offer } = await finalizedPair();
    expect(() => parseRfqLifecyclePacket(offer)).not.toThrow();
    expect(() => parseRfqLifecyclePacket({ ...offer, packetId: "c".repeat(64) }))
      .toThrow("RFQ lifecycle packetId does not match exact bytes");
  });

  test.each([
    { name: "packetVersion 2", edit: (packet: Record<string, unknown>) => { packet.packetVersion = "2"; } },
    { name: "a missing key", edit: (packet: Record<string, unknown>) => { delete packet.recipient; } },
    { name: "an extra key", edit: (packet: Record<string, unknown>) => { packet.extra = true; } },
    { name: "sender equal to recipient", edit: (packet: Record<string, unknown>) => { packet.recipient = packet.sender; } },
    { name: "an unknown kind", edit: (packet: Record<string, unknown>) => { packet.kind = "receipt"; } },
    { name: "an empty jobId", edit: (packet: Record<string, unknown>) => { packet.jobId = ""; } },
  ])("parseRfqLifecyclePacket refuses $name under a matching packetId", async ({ edit }) => {
    const { offer } = await finalizedPair();
    const unsigned = unsignedOf(offer);
    edit(unsigned);
    expect(() => parseRfqLifecyclePacket(withId(unsigned))).toThrow("RFQ lifecycle packet is malformed");
  });

  test("parseRfqLifecyclePacket refuses contributionVersion 2 under matching hashes", async () => {
    const { proposal } = await finalizedPair();
    if (proposal.kind !== "agreement-proposal") throw new Error("not a proposal");
    expect(() => parseRfqLifecyclePacket(proposal)).not.toThrow();
    const contribution = { ...structuredClone(proposal.buyerContribution), contributionVersion: "2" };
    const contributionHash = createHash("sha256").update(canonicalize({
      contributionVersion: contribution.contributionVersion,
      planHash: contribution.planHash,
      role: contribution.role,
      party: contribution.party,
      signature: contribution.signature,
    }), "utf8").digest("hex");
    const changed = withId({ ...unsignedOf(proposal), buyerContribution: { ...contribution, contributionHash } });
    expect(() => parseRfqLifecyclePacket(changed)).toThrow("RFQ agreement proposal packet is inconsistent");
  });
});

describe("durable RFQ agreement deadline uses one trusted clock reading", () => {
  const OFFER = { rfqProposalVersion: "1" as const, price: { amount: "9", currency: "USDC" } };
  const AGREEMENT_TIMEOUT = "RFQ agreement timeout elapsed (RFQ-4)";
  const TERMINAL = "RFQ session is already terminal";
  const FUTURE_PLAN = "buyer dated the RFQ agreement plan after the seller's deadline";
  // The buyer receives the seller's accept at NOW, so its proposal is due by NOW + 10,000.
  const DEADLINE = NOW + 10_000;

  /** A clock that answers its script in order, then `now`. */
  function scriptedClock() {
    const clock = { now: NOW, script: [] as Array<number | "throw">, reads: 0 };
    const nowMs = () => {
      clock.reads += 1;
      const next = clock.script.shift();
      if (next === "throw") throw new Error("trusted clock unavailable");
      return next ?? clock.now;
    };
    return { clock, nowMs };
  }

  async function record(client: DurableRfqLifecycleClient<string>) {
    const status = await client.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error("record missing");
    return status.record;
  }

  /**
   * The buyer offers and the seller accepts at NOW; the buyer receives the
   * accept at `buyerReceivesAt`.
   */
  async function sellerAccepted(buyerReceivesAt = NOW) {
    const { clock, nowMs } = scriptedClock();
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient, sellerClient } = clients(network.transport, durableReservation(), nowMs);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await expect(buyerClient.sendOffer(JOB_ID, OFFER)).resolves.toMatchObject({ status: "ready" });
    await deliver(network, SELLER, sellerClient);
    await expect(sellerClient.sendAccept(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    clock.now = buyerReceivesAt;
    await deliver(network, BUYER, buyerClient);
    return { clock, network, buyerClient, sellerClient };
  }

  test("a consistently overdue clock records the timeout and signs nothing", async () => {
    const { clock, network, buyerClient } = await sellerAccepted();
    clock.now = DEADLINE + 1;
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    const failed = await record(buyerClient);
    expect(failed.failure).toMatchObject({ class: "timeout", recordedAt: DEADLINE + 1 });
    expect(failed.agreement).toBeUndefined();
    expect(network.pending(SELLER)).toBe(0);
  });

  test("a clock fault is indeterminate and signs nothing; the next overdue reading records the timeout", async () => {
    const { clock, network, buyerClient } = await sellerAccepted();
    clock.script = ["throw", DEADLINE + 1];
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({
      status: "indeterminate", reason: "trusted clock unavailable",
    });
    const unchanged = await record(buyerClient);
    expect(unchanged.agreement).toBeUndefined();
    expect(unchanged.failure).toBeUndefined();
    expect(network.pending(SELLER)).toBe(0);

    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    expect((await record(buyerClient)).agreement).toBeUndefined();
    expect(network.pending(SELLER)).toBe(0);
  });

  test("the one reading that decides the deadline also dates the plan", async () => {
    const { clock, network, buyerClient } = await sellerAccepted();
    // A second reading past the deadline would date the plan after it. The
    // next reading only records the publication.
    clock.script = [DEADLINE, DEADLINE + 1];
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    expect(clock.script).toEqual([]);
    const started = await record(buyerClient);
    expect(started.agreement?.plan.draft.generatedAt).toBe(DEADLINE);
    expect(started.outbox.at(-1)).toMatchObject({ state: "acknowledged", updatedAt: DEADLINE + 1 });
    const proposal = network.take(SELLER);
    expect(proposal?.kind === "agreement-proposal" && proposal.plan.draft.generatedAt).toBe(DEADLINE);
  });

  test("with a clock fault the buyer-accepted RFQ never finalizes after the buyer's deadline", async () => {
    const { clock, nowMs } = scriptedClock();
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient, sellerClient } = clients(network.transport, durableReservation(), nowMs);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, OFFER);
    await deliver(network, SELLER, sellerClient);
    await sellerClient.sendCounter(JOB_ID, { rfqProposalVersion: "1", price: { amount: "10", currency: "USDC" } });
    await deliver(network, BUYER, buyerClient);
    await expect(buyerClient.sendAccept(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    // The accept reaches the seller 5 s later, so the seller's window runs to NOW + 15,000.
    clock.now = NOW + 5_000;
    await deliver(network, SELLER, sellerClient);
    clock.script = ["throw"];
    clock.now = DEADLINE + 1;
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "indeterminate" });
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ reason: AGREEMENT_TIMEOUT });
    expect(network.pending(SELLER)).toBe(0);
    expect((await record(buyerClient)).agreement).toBeUndefined();
    expect((await record(sellerClient)).agreement).toBeUndefined();
  });

  test("the seller refuses, before signing, a plan the buyer dated after the seller's deadline, and records no timeout", async () => {
    // The seller's window runs to NOW + 10,000; the buyer's from its receipt at NOW + 5,000.
    const { clock, network, buyerClient, sellerClient } = await sellerAccepted(NOW + 5_000);
    clock.now = DEADLINE + 1;
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    // The seller's own clock still reads inside its window.
    clock.now = NOW + 9_000;
    const proposal = network.take(SELLER);
    if (proposal === undefined) throw new Error("no proposal");
    const before = await record(sellerClient);
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({
      status: "rejected", reason: FUTURE_PLAN,
    });
    expect(await record(sellerClient)).toEqual(before);
    expect(network.pending(BUYER)).toBe(0);
    // Only the seller's own deadline ends the job.
    clock.now = DEADLINE;
    await expect(sellerClient.sendAbort(JOB_ID)).resolves.toMatchObject({ status: "rejected", reason: TERMINAL });
    expect(await record(sellerClient)).toEqual(before);
    clock.now = DEADLINE + 1;
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    const failed = await record(sellerClient);
    expect(failed.failure).toMatchObject({ class: "timeout", recordedAt: DEADLINE + 1 });
    expect(failed.agreement).toBeUndefined();
    expect(network.pending(BUYER)).toBe(0);
  });

  test("a buyer clock 20,000 ms ahead never ends the seller's job before the seller's deadline", async () => {
    // The buyer's valid proposal reaches the seller at NOW, inside its window.
    const clock = { now: NOW };
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const reservation = durableReservation();
    const { sellerClient } = clients(network.transport, reservation, () => clock.now);
    const { buyerClient } = clients(network.transport, reservation, () => clock.now + 20_000);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, OFFER);
    await deliver(network, SELLER, sellerClient);
    await sellerClient.sendAccept(JOB_ID);
    await deliver(network, BUYER, buyerClient);
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    const proposal = network.take(SELLER);
    if (proposal?.kind !== "agreement-proposal") throw new Error("no proposal");
    expect(proposal.plan.draft.generatedAt).toBe(NOW + 20_000);
    const before = await record(sellerClient);
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({
      status: "rejected", reason: FUTURE_PLAN,
    });
    expect(await record(sellerClient)).toEqual(before);
    clock.now = DEADLINE;
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({
      status: "rejected", reason: FUTURE_PLAN,
    });
    await expect(sellerClient.sendAbort(JOB_ID)).resolves.toMatchObject({ status: "rejected", reason: TERMINAL });
    expect(await record(sellerClient)).toEqual(before);
    expect(network.pending(BUYER)).toBe(0);
    // The seller's own deadline still ends the job, on its own clock.
    clock.now = DEADLINE + 1;
    await expect(sellerClient.sendAbort(JOB_ID)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    expect((await record(sellerClient)).failure).toMatchObject({ class: "timeout", recordedAt: DEADLINE + 1 });
    expect(network.pending(BUYER)).toBe(0);
  });

  test("the seller countersigns a plan dated exactly at its deadline", async () => {
    const { clock, network, buyerClient, sellerClient } = await sellerAccepted(NOW + 5_000);
    clock.now = DEADLINE;
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    clock.now = NOW + 9_000;
    await deliver(network, SELLER, sellerClient);
    expect((await record(sellerClient)).agreement?.finalized).toBeDefined();
  });

  // The buyer's plan in slowSeller() is dated NOW + 1,000, so the seller's
  // contribution is due by NOW + 11,000.
  const CONTRIBUTION_DEADLINE = NOW + 11_000;

  /**
   * The seller accepts at NOW, so the buyer's proposal is due by DEADLINE;
   * the buyer dates its plan `planAt`, and the seller's contribution is due
   * `timeoutMs` after that. The seller's agreement signer and verifier are
   * the caller's, so a test can make them slow.
   */
  async function slowSeller(seller: {
    sign?: (bytes: Uint8Array) => Promise<Uint8Array>;
    verify?: (
      input: Parameters<typeof verifyAgreement>[0],
    ) => Promise<ReturnType<typeof verifyAgreement>>;
  }, planAt = NOW + 1_000) {
    const { clock, nowMs } = scriptedClock();
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const reservation = durableReservation();
    const { buyerClient } = clients(network.transport, reservation, nowMs);
    const signer = agreementSigner(SELLER, sellerKeys.privateKey);
    const sellerClient = createDurableRfqLifecycleClient({
      role: "seller",
      store: createInMemoryDurableRfqLifecycleStore<string>(),
      transport: network.transport,
      reserveChannelId: reservation,
      signChannelMessage: channelSigner(sellerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      agreementSigner: seller.sign === undefined ? signer : { ...signer, sign: seller.sign },
      verifyAgreementContribution: seller.verify ?? verifyAgreement,
      nowMs,
    });
    // A plan is never dated before the session started.
    clock.now = Math.min(NOW, planAt);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    clock.now = NOW;
    await buyerClient.sendOffer(JOB_ID, OFFER);
    await deliver(network, SELLER, sellerClient);
    await sellerClient.sendAccept(JOB_ID);
    await deliver(network, BUYER, buyerClient);
    clock.now = planAt;
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    const proposal = network.take(SELLER);
    if (proposal?.kind !== "agreement-proposal") throw new Error("no proposal");
    expect(proposal.plan.draft.generatedAt).toBe(planAt);
    return { clock, network, buyerClient, sellerClient, proposal };
  }

  test("a seller signer that settles after the contribution deadline records the timeout instead of finalizing", async () => {
    let slow = true;
    const { clock, network, sellerClient, proposal } = await slowSeller({
      sign: async (bytes) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (slow) clock.now = CONTRIBUTION_DEADLINE + 1;
        return ed25519Sign(null, bytes, sellerKeys.privateKey);
      },
    });
    // The proposal arrives exactly at its deadline, inside the window.
    clock.now = DEADLINE;
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    const failed = await record(sellerClient);
    expect(failed.failure).toMatchObject({ class: "timeout", recordedAt: CONTRIBUTION_DEADLINE + 1 });
    expect(failed.agreement?.contributions).toEqual([proposal.buyerContribution]);
    expect(failed.agreement?.finalized).toBeUndefined();
    expect(failed.inboxPacketIds).not.toContain(proposal.packetId);
    expect(network.pending(BUYER)).toBe(0);
    // The timeout is terminal: a faster signer does not revive the job.
    slow = false;
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    expect(await record(sellerClient)).toEqual(failed);
    expect(network.pending(BUYER)).toBe(0);
  });

  test("a seller verifier that settles after the contribution deadline records the timeout instead of finalizing", async () => {
    let slow = false;
    const verify = vi.fn(async (input: Parameters<typeof verifyAgreement>[0]) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (slow) clock.now = CONTRIBUTION_DEADLINE + 1;
      return verifyAgreement(input);
    });
    const { clock, network, sellerClient, proposal } = await slowSeller({ verify });
    slow = true;
    clock.now = DEADLINE;
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    expect(verify).toHaveBeenCalled();
    const failed = await record(sellerClient);
    expect(failed.failure).toMatchObject({ class: "timeout", recordedAt: CONTRIBUTION_DEADLINE + 1 });
    expect(failed.agreement?.finalized).toBeUndefined();
    expect(network.pending(BUYER)).toBe(0);
  });

  test.each([
    ["just after the proposal deadline", DEADLINE + 1],
    ["exactly at the contribution deadline", CONTRIBUTION_DEADLINE],
  ])("a seller signer that settles %s, inside the contribution window, finalizes on both members", async (_, settledAt) => {
    const { clock, network, buyerClient, sellerClient, proposal } = await slowSeller({
      sign: async (bytes) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        clock.now = settledAt;
        return ed25519Sign(null, bytes, sellerKeys.privateKey);
      },
    });
    clock.now = DEADLINE;
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({ status: "ready" });
    const finalized = await record(sellerClient);
    expect(finalized.failure).toBeUndefined();
    expect(finalized.agreement?.finalized).toBeDefined();
    expect(finalized.outbox.at(-1)).toMatchObject({
      packet: { kind: "agreement-contribution" }, updatedAt: settledAt,
    });
    // The buyer is still inside the same window and finalizes the same agreement.
    await deliver(network, BUYER, buyerClient);
    const buyer = await record(buyerClient);
    expect(buyer.failure).toBeUndefined();
    expect(buyer.agreement?.finalized).toEqual(finalized.agreement?.finalized);
  });

  test("a plan dated before the seller's acceptance makes the contribution due before the seller's own window ends", async () => {
    // A buyer clock 2,000 ms behind dates the plan NOW - 2,000, so the
    // contribution is due by NOW + 8,000, before the proposal deadline.
    const { clock, network, sellerClient, proposal } = await slowSeller({
      sign: async (bytes) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        clock.now = NOW + 8_001;
        return ed25519Sign(null, bytes, sellerKeys.privateKey);
      },
    }, NOW - 2_000);
    clock.now = NOW + 5_000;
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    const failed = await record(sellerClient);
    expect(failed.failure).toMatchObject({ class: "timeout", recordedAt: NOW + 8_001 });
    expect(failed.agreement?.finalized).toBeUndefined();
    expect(network.pending(BUYER)).toBe(0);
  });

  test("a clock fault after the seller signs preserves the verified proposal for retry", async () => {
    const { clock, network, buyerClient, sellerClient, proposal } = await slowSeller({});
    const before = await record(sellerClient);
    // The receipt reading is in the window; the reading after signing fails.
    clock.script = [NOW + 9_000, "throw"];
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({
      status: "indeterminate", reason: "trusted clock unavailable",
    });
    expect(clock.script).toEqual([]);
    const staged = await record(sellerClient);
    expect(staged.agreement).toMatchObject({ plan: proposal.plan, contributions: [proposal.buyerContribution] });
    expect(staged.inboxPacketIds).toEqual(before.inboxPacketIds);
    expect(network.pending(BUYER)).toBe(0);
    clock.now = NOW + 9_500;
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({ status: "ready" });
    const finalized = await record(sellerClient);
    expect(finalized.agreement?.finalized).toBeDefined();
    expect(finalized.outbox.at(-1)).toMatchObject({ packet: { kind: "agreement-contribution" } });
    expect(finalized.updatedAt).toBeGreaterThanOrEqual(NOW + 9_500);
    await deliver(network, BUYER, buyerClient);
    expect((await record(buyerClient)).agreement?.finalized).toEqual(finalized.agreement?.finalized);
  });

  test("a future-dated proposal the buyer did not sign is refused without a timeout", async () => {
    const { clock, nowMs } = scriptedClock();
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const reservation = durableReservation();
    const { sellerClient } = clients(network.transport, reservation, nowMs);
    // Signs with a key the seller's verifier does not hold for the buyer.
    const forger = createDurableRfqLifecycleClient({
      role: "buyer",
      store: createInMemoryDurableRfqLifecycleStore<string>(),
      transport: network.transport,
      reserveChannelId: reservation,
      signChannelMessage: channelSigner(buyerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      agreementSigner: agreementSigner(BUYER, generateKeyPairSync("ed25519").privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs,
    });
    await forger.open(openInput());
    await sellerClient.open(openInput());
    await forger.sendOffer(JOB_ID, OFFER);
    await deliver(network, SELLER, sellerClient);
    await sellerClient.sendAccept(JOB_ID);
    clock.now = NOW + 5_000;
    await deliver(network, BUYER, forger);
    clock.now = DEADLINE + 1;
    await expect(forger.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    const proposal = network.take(SELLER);
    if (proposal?.kind !== "agreement-proposal") throw new Error("no proposal");
    expect(proposal.plan.draft.generatedAt).toBe(DEADLINE + 1);
    expect(() => parseRfqLifecyclePacket(proposal)).not.toThrow();

    // The seller's clock is inside its window: the unsigned date decides nothing.
    clock.now = NOW + 9_000;
    const before = await record(sellerClient);
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({
      status: "rejected", reason: FUTURE_PLAN,
    });
    expect(await record(sellerClient)).toEqual(before);
    expect(network.pending(BUYER)).toBe(0);
    // Only the seller's own deadline ends the job.
    clock.now = DEADLINE + 1;
    await expect(sellerClient.receive(proposal)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    expect((await record(sellerClient)).failure).toMatchObject({ class: "timeout", recordedAt: DEADLINE + 1 });
  });

  test("a future-dated proposal is refused without calling the verifier", async () => {
    const { clock, nowMs } = scriptedClock();
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const reservation = durableReservation();
    const { buyerClient } = clients(network.transport, reservation, nowMs);
    const undecided = vi.fn(() => "indeterminate" as const);
    const sellerClient = createDurableRfqLifecycleClient({
      role: "seller",
      store: createInMemoryDurableRfqLifecycleStore<string>(),
      transport: network.transport,
      reserveChannelId: reservation,
      signChannelMessage: channelSigner(sellerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      agreementSigner: agreementSigner(SELLER, sellerKeys.privateKey),
      verifyAgreementContribution: undecided,
      nowMs,
    });
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, OFFER);
    await deliver(network, SELLER, sellerClient);
    await sellerClient.sendAccept(JOB_ID);
    clock.now = NOW + 5_000;
    await deliver(network, BUYER, buyerClient);
    clock.now = DEADLINE + 1;
    await buyerClient.startAgreement(JOB_ID);
    clock.now = NOW + 9_000;
    const before = await record(sellerClient);
    await expect(sellerClient.receive(network.take(SELLER)!)).resolves.toMatchObject({
      status: "rejected", reason: FUTURE_PLAN,
    });
    expect(undecided).not.toHaveBeenCalled();
    expect(await record(sellerClient)).toEqual(before);
    expect(network.pending(BUYER)).toBe(0);
  });

  test("a clock fault while the agreement is pending is indeterminate; once finalized the session is terminal", async () => {
    const { clock, network, buyerClient, sellerClient } = await sellerAccepted();
    const before = await record(buyerClient);
    clock.script = ["throw"];
    await expect(buyerClient.sendAbort(JOB_ID)).resolves.toMatchObject({
      status: "indeterminate", reason: "trusted clock unavailable",
    });
    expect(await record(buyerClient)).toEqual(before);
    await buyerClient.startAgreement(JOB_ID);
    await deliver(network, SELLER, sellerClient);
    await deliver(network, BUYER, buyerClient);
    for (const client of [buyerClient, sellerClient]) {
      clock.script = ["throw"];
      await expect(client.sendAbort(JOB_ID)).resolves.toMatchObject({ status: "rejected", reason: TERMINAL });
    }
  });

  for (const skew of [5_000, 500_000]) {
    test(`a buyer clock ${skew} ms ahead never extends the seller's agreement window`, async () => {
      // The counterparty's signed accept.sentAt is not our clock (RFQ-4).
      const clock = { now: NOW };
      const network = createInMemoryRfqLifecycleNetwork<string>();
      const reservation = durableReservation();
      const { sellerClient } = clients(network.transport, reservation, () => clock.now);
      const { buyerClient } = clients(network.transport, reservation, () => clock.now + skew);
      await buyerClient.open(openInput());
      await sellerClient.open(openInput());
      await buyerClient.sendOffer(JOB_ID, OFFER);
      await deliver(network, SELLER, sellerClient);
      await sellerClient.sendCounter(JOB_ID, { rfqProposalVersion: "1", price: { amount: "10", currency: "USDC" } });
      await deliver(network, BUYER, buyerClient);
      await expect(buyerClient.sendAccept(JOB_ID)).resolves.toMatchObject({ status: "ready" });
      await deliver(network, SELLER, sellerClient);
      const accepted = await record(sellerClient);
      expect(accepted.session).toMatchObject({ status: "accepted", awaitingSince: NOW });
      expect(accepted.transcript.at(-1)).toMatchObject({ type: "accept", sender: BUYER, sentAt: NOW + skew });
      clock.now = DEADLINE;
      await expect(sellerClient.sendAbort(JOB_ID)).resolves.toMatchObject({ status: "rejected", reason: TERMINAL });
      clock.now = DEADLINE + 1;
      await expect(sellerClient.sendAbort(JOB_ID)).resolves.toMatchObject({
        status: "rejected", reason: AGREEMENT_TIMEOUT,
      });
      expect((await record(sellerClient)).failure).toMatchObject({ class: "timeout", recordedAt: DEADLINE + 1 });
    });
  }

  test("a finalized agreement never acquires a timeout failure", async () => {
    const { clock, network, buyerClient, sellerClient } = await sellerAccepted();
    await buyerClient.startAgreement(JOB_ID);
    await deliver(network, SELLER, sellerClient);
    await deliver(network, BUYER, buyerClient);
    const before = await buyerClient.getStatus(JOB_ID);
    expect(before).toMatchObject({ status: "ok", record: { agreement: { finalized: { signatures: expect.any(Array) } } } });
    clock.now = NOW + 60_000;
    await expect(buyerClient.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "duplicate" });
    for (const client of [buyerClient, sellerClient]) {
      const prior = await client.getStatus(JOB_ID);
      await expect(client.sendAbort(JOB_ID)).resolves.toMatchObject({ status: "rejected", reason: TERMINAL });
      expect(await client.getStatus(JOB_ID)).toEqual(prior);
    }
    expect(await buyerClient.getStatus(JOB_ID)).toEqual(before);
  });

  test("a rejected RFQ never acquires an agreement timeout", async () => {
    const { clock, nowMs } = scriptedClock();
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const { buyerClient, sellerClient } = clients(network.transport, durableReservation(), nowMs);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, OFFER);
    await deliver(network, SELLER, sellerClient);
    await sellerClient.sendReject(JOB_ID);
    await deliver(network, BUYER, buyerClient);
    clock.now = NOW + 60_000;
    for (const client of [buyerClient, sellerClient]) {
      const prior = await client.getStatus(JOB_ID);
      expect(prior).toMatchObject({ status: "ok", record: { session: { status: "rejected" } } });
      await expect(client.sendAbort(JOB_ID)).resolves.toMatchObject({ status: "rejected", reason: TERMINAL });
      expect(await client.getStatus(JOB_ID)).toEqual(prior);
    }
  });

  test("a record accepted before awaitingSince moved keeps the accepter's full agreement window", async () => {
    // A plain revision-checked store, so the test can write the earlier SDK's record shape.
    const records = new Map<string, DurableRfqLifecycleRecord<string>>();
    const legacyStore: DurableRfqLifecycleStore<string> = {
      load: (role, jobId) => {
        const found = records.get(`${role}:${jobId}`);
        return found === undefined
          ? { status: "missing" }
          : { status: "ok", record: structuredClone(found) };
      },
      create: (created) => {
        records.set(`${created.role}:${created.jobId}`, structuredClone(created));
        return { status: "created", record: structuredClone(created) };
      },
      compareAndSwap: (role, jobId, revision, next) => {
        const found = records.get(`${role}:${jobId}`);
        if (found === undefined) return { status: "missing" };
        if (found.revision !== revision) return { status: "stale" };
        records.set(`${role}:${jobId}`, structuredClone(next));
        return { status: "written", record: structuredClone(next) };
      },
    };
    const clock = { now: NOW };
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const reservation = durableReservation();
    const { buyerClient } = clients(network.transport, reservation, () => clock.now);
    const sellerClient = createDurableRfqLifecycleClient({
      role: "seller",
      store: legacyStore,
      transport: network.transport,
      reserveChannelId: reservation,
      signChannelMessage: channelSigner(sellerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      agreementSigner: agreementSigner(SELLER, sellerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => clock.now,
    });
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, OFFER);
    clock.now = NOW + 1_000;
    await deliver(network, SELLER, sellerClient);
    clock.now = NOW + 4_000;
    await expect(sellerClient.sendAccept(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    // The earlier SDK left awaitingSince at the offer's receipt.
    const key = `seller:${JOB_ID}`;
    const accepted = records.get(key)!;
    expect(accepted.session.awaitingSince).toBe(NOW + 4_000);
    const legacy = { ...accepted, session: { ...accepted.session, awaitingSince: NOW + 1_000 } };
    delete legacy.agreementTimeout;
    records.set(key, legacy);

    clock.now = NOW + 14_000;
    await expect(sellerClient.sendAbort(JOB_ID)).resolves.toMatchObject({ status: "rejected", reason: TERMINAL });
    expect(records.get(key)!.failure).toBeUndefined();
    clock.now = NOW + 14_001;
    await expect(sellerClient.sendAbort(JOB_ID)).resolves.toMatchObject({
      status: "rejected", reason: AGREEMENT_TIMEOUT,
    });
    expect(records.get(key)!.failure).toMatchObject({ class: "timeout", recordedAt: NOW + 14_001 });
  });
});


describe("cold review: durable agreement steps", () => {
  async function pair(sign: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>) {
    const clock = { now: NOW };
    const network = createInMemoryRfqLifecycleNetwork<string>();
    const reserve = durableReservation();
    const { buyerClient } = clients(network.transport, reserve, () => clock.now);
    const options = {
      role: "seller" as const, store: createInMemoryDurableRfqLifecycleStore<string>(),
      transport: network.transport, reserveChannelId: reserve,
      signChannelMessage: channelSigner(sellerKeys.privateKey), verifyChannelMessage: verifyChannel,
      agreementSigner: { ...agreementSigner(SELLER, sellerKeys.privateKey), sign },
      verifyAgreementContribution: verifyAgreement, nowMs: () => clock.now,
    };
    const sellerClient = createDurableRfqLifecycleClient(options);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, { rfqProposalVersion: "1", price: { amount: "9", currency: "USDC" } });
    await deliver(network, SELLER, sellerClient);
    await sellerClient.sendAccept(JOB_ID);
    await deliver(network, BUYER, buyerClient);
    clock.now = NOW + 9_000;
    await buyerClient.startAgreement(JOB_ID);
    const proposal = network.take(SELLER)!;
    return { clock, network, buyerClient, sellerClient, options, proposal };
  }

  test("a verified proposal survives signer outage and restart past its arrival deadline", async () => {
    let offline = true;
    const f = await pair((bytes) => {
      if (offline) throw new Error("signer offline");
      return ed25519Sign(null, bytes, sellerKeys.privateKey);
    });
    await expect(f.sellerClient.receive(f.proposal)).resolves.toMatchObject({ status: "indeterminate" });
    const staged = await f.sellerClient.getStatus(JOB_ID);
    expect(staged).toMatchObject({ status: "ok", record: { agreement: { contributions: [{ role: "buyer" }] } } });
    if (f.proposal.kind !== "agreement-proposal") throw new Error("not a proposal");
    const plan = createFixedPriceAgreementSigningPlan({ ...structuredClone(f.proposal.plan.draft), generatedAt: NOW + 9_001 });
    const buyerContribution = await createFixedPriceAgreementSignatureContribution(
      plan, "buyer", agreementSigner(BUYER, buyerKeys.privateKey));
    const { packetId: _, ...replacement } = { ...f.proposal, plan, buyerContribution };
    await expect(f.sellerClient.receive({ ...replacement, packetId: rfqLifecyclePacketId(replacement) })).resolves.toMatchObject({
      status: "rejected", reason: "buyer replaced the stored RFQ agreement proposal",
    });
    expect(await f.sellerClient.getStatus(JOB_ID)).toEqual(staged);
    f.clock.now = NOW + 10_001;
    offline = false;
    const restarted = createDurableRfqLifecycleClient(f.options);
    await expect(restarted.receive(f.proposal)).resolves.toMatchObject({ status: "ready" });
    await deliver(f.network, BUYER, f.buyerClient);
    const seller = await restarted.getStatus(JOB_ID);
    const buyer = await f.buyerClient.getStatus(JOB_ID);
    expect(seller.status === "ok" && seller.record.agreement?.finalized).toEqual(
      buyer.status === "ok" && buyer.record.agreement?.finalized);
    expect(seller.status === "ok" && seller.record.failure).toBeUndefined();
  });

  test("a concurrent timeout driver respects the staged contribution window", async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await pair(async (bytes) => {
      enter();
      await gate;
      return ed25519Sign(null, bytes, sellerKeys.privateKey);
    });
    const receiving = f.sellerClient.receive(f.proposal);
    await entered;
    f.clock.now = NOW + 10_001;
    try {
      await expect(f.sellerClient.sendAbort(JOB_ID)).resolves.toMatchObject({
        status: "rejected", reason: "RFQ session is already terminal",
      });
    } finally { release(); }
    await expect(receiving).resolves.toMatchObject({ status: "ready" });
  });

  test("a staged proposal still expires at its contribution deadline", async () => {
    const sign = vi.fn(() => { throw new Error("offline"); });
    const f = await pair(sign);
    await expect(f.sellerClient.receive(f.proposal)).resolves.toMatchObject({ status: "indeterminate" });
    f.clock.now = NOW + 19_001;
    await expect(f.sellerClient.receive(f.proposal)).resolves.toMatchObject({
      status: "rejected", reason: "RFQ agreement timeout elapsed (RFQ-4)",
    });
    expect(sign).toHaveBeenCalledTimes(1);
  });

  test("an invalid buyer signature is refused before staging or calling the seller signer", async () => {
    const sign = vi.fn((bytes: Uint8Array) => ed25519Sign(null, bytes, sellerKeys.privateKey));
    const f = await pair(sign);
    if (f.proposal.kind !== "agreement-proposal") throw new Error("not a proposal");
    const wrong = generateKeyPairSync("ed25519");
    const buyerContribution = await createFixedPriceAgreementSignatureContribution(
      f.proposal.plan, "buyer", agreementSigner(BUYER, wrong.privateKey));
    const { packetId: _, ...material } = { ...f.proposal, buyerContribution };
    const invalid = { ...material, packetId: rfqLifecyclePacketId(material) };
    const before = await f.sellerClient.getStatus(JOB_ID);
    await expect(f.sellerClient.receive(invalid)).resolves.toMatchObject({ status: "rejected" });
    expect(sign).not.toHaveBeenCalled();
    expect(await f.sellerClient.getStatus(JOB_ID)).toEqual(before);
    await expect(f.sellerClient.receive(f.proposal)).resolves.toMatchObject({ status: "ready" });
  });

  test("a legacy receiver acceptance gets a stable local timeout window on upgrade", async () => {
    const f = await pair((bytes) => ed25519Sign(null, bytes, sellerKeys.privateKey));
    const accepted = await f.buyerClient.getStatus(JOB_ID);
    if (accepted.status !== "ok") throw new Error("no record");
    // Recreate the old stored checkpoint: acceptance was received at 9.001s,
    // but awaitingSince still contains the offer time and no timeout marker exists.
    const legacy = structuredClone(accepted.record) as DurableRfqLifecycleRecord<string>;
    delete legacy.agreementTimeout;
    delete legacy.agreement;
    legacy.outbox = legacy.outbox.filter((entry) => entry.packet.kind === "turn");
    legacy.session.awaitingSince = NOW;
    legacy.updatedAt = NOW + 9_001;
    const store = createInMemoryDurableRfqLifecycleStore<string>();
    expect(await store.create(legacy)).toMatchObject({ status: "created" });
    const options = {
      ...f.options, role: "buyer" as const, store,
      signChannelMessage: channelSigner(buyerKeys.privateKey),
      agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
    };
    f.clock.now = NOW + 10_001;
    const upgraded = createDurableRfqLifecycleClient(options);
    await expect(upgraded.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });
    expect(await upgraded.getStatus(JOB_ID)).toMatchObject({ status: "ok", record: {
      agreementTimeout: { version: "1", acceptedAt: NOW + 9_001 },
    } });
    f.clock.now = NOW + 20_002;
    await expect(createDurableRfqLifecycleClient(options).sendAbort(JOB_ID)).resolves.toMatchObject({
      status: "rejected", reason: "RFQ agreement timeout elapsed (RFQ-4)",
    });
    expect(await upgraded.getStatus(JOB_ID)).toMatchObject({ status: "ok", record: {
      agreementTimeout: { version: "1", acceptedAt: NOW + 9_001 },
    } });
  });
});
