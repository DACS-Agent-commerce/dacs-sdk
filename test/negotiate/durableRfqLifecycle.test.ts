import {
  generateKeyPairSync,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import {
  canonicalize,
  contentHash,
  createDurableRfqLifecycleClient,
  createFixedPriceAgreementSignatureContribution,
  createFixedPriceAgreementSigningPlan,
  createInMemoryDurableRfqLifecycleStore,
  createInMemoryRfqLifecycleNetwork,
  DURABLE_RFQ_LIFECYCLE_HISTORICAL_STORE_VERSION,
  durableRfqLifecycleRecordViolation,
  durableRfqLifecycleTransitionViolation,
  prepareChannelMessageSigningInput,
  rfqLifecyclePacketId,
  type DurableRfqLifecycleRecord,
  type AttestationRef,
  type ChannelMessageSignatureVerificationInput,
  type ChannelMessageSigningInput,
  type ChannelMessageSignatureV1,
  type DurableRfqLifecycleClient,
  type DurableRfqLifecycleStore,
  type DurableRfqLifecycleTransport,
  type IdentityBundle,
  type Listing,
  type RfqChannelReservationInput,
  type RfqLifecyclePacket,
  type RfqLifecycleProfileAdmission,
  type RfqTurnBody,
  type VerifiedListingInput,
} from "../../src/index.js";

import { rfqProfileAdmission } from "./correctiveProfile.js";
import { malformedNestedRecords } from "./malformedRecords.js";

const NOW = 1_780_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const BUYER = "did:demos:buyer-durable-rfq";
const SELLER = "did:demos:seller-durable-rfq";

/** Verifier-owned CORE §11.1.2(3) profile admission for each requested session. */
const grantProfile: RfqLifecycleProfileAdmission = ({ channelId, participantIdentities }) =>
  rfqProfileAdmission(channelId, participantIdentities);

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

function channelSigner(signer: string, privateKey: KeyObject) {
  return (input: Readonly<ChannelMessageSigningInput<RfqTurnBody>>): ChannelMessageSignatureV1 => ({
    signatureVersion: "1",
    signer,
    algorithm: "ed25519",
    value: ed25519Sign(null, Buffer.from(input.signedBytes), privateKey).toString("base64url"),
  });
}

function verifyChannel(
  input: Readonly<ChannelMessageSignatureVerificationInput<RfqTurnBody, ChannelMessageSignatureV1>>,
) {
  const key = publicKeys.get(input.message.sender);
  return key !== undefined &&
    input.operation === "current-read" &&
    input.message.signature.signer === input.message.sender &&
    ed25519Verify(
      null,
      Buffer.from(input.signedBytes),
      key,
      Buffer.from(input.message.signature.value, "base64url"),
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
  transport: DurableRfqLifecycleTransport<ChannelMessageSignatureV1>,
  reservation = durableReservation(),
  nowMs = () => NOW,
) {
  const buyerClient = createDurableRfqLifecycleClient({
    role: "buyer",
    store: createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>(),
    transport,
    reserveChannelId: reservation,
    signChannelMessage: channelSigner(BUYER, buyerKeys.privateKey),
    verifyChannelMessage: verifyChannel,
    profileAdmission: grantProfile,
    agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
    verifyAgreementContribution: verifyAgreement,
    nowMs,
  });
  const sellerClient = createDurableRfqLifecycleClient({
    role: "seller",
    store: createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>(),
    transport,
    reserveChannelId: reservation,
    signChannelMessage: channelSigner(SELLER, sellerKeys.privateKey),
    verifyChannelMessage: verifyChannel,
    profileAdmission: grantProfile,
    agreementSigner: agreementSigner(SELLER, sellerKeys.privateKey),
    verifyAgreementContribution: verifyAgreement,
    nowMs,
  });
  return { buyerClient, sellerClient };
}

async function deliver(
  network: ReturnType<typeof createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>>,
  recipient: string,
  client: DurableRfqLifecycleClient<ChannelMessageSignatureV1>,
) {
  const packet = network.take(recipient);
  if (packet === undefined) throw new Error(`no packet for ${recipient}`);
  const result = await client.receive(packet);
  expect(result.status).toBe("ready");
  return { packet, result };
}

describe("durable two-agent RFQ lifecycle", () => {
  test("fails closed as indeterminate when its durable store is unavailable", async () => {
    const unavailableStore: DurableRfqLifecycleStore<ChannelMessageSignatureV1> = {
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
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
    const client = createDurableRfqLifecycleClient({
      role: "buyer",
      store: unavailableStore,
      transport: network.transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: channelSigner(BUYER, buyerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      profileAdmission: grantProfile,
      agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => NOW,
    });

    // Open loads the job first, so an unavailable store fails before any reservation.
    await expect(client.open(openInput())).resolves.toEqual({
      status: "indeterminate",
      reason: "RFQ lifecycle store load failed",
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
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
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
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
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
    const accepted = new Map<string, RfqLifecyclePacket<ChannelMessageSignatureV1>>();
    let first = true;
    const publish = vi.fn(async (packet: Readonly<RfqLifecyclePacket<ChannelMessageSignatureV1>>) => {
      if (first) {
        first = false;
        return { disposition: "indeterminate" as const, reason: "lost response" };
      }
      accepted.set(packet.packetId, structuredClone(packet));
      return { disposition: "acknowledged" as const };
    });
    const transport: DurableRfqLifecycleTransport<ChannelMessageSignatureV1> = {
      publish,
      async reconcile(packet) {
        return accepted.has(packet.packetId)
          ? { disposition: "acknowledged" as const }
          : { disposition: "absent" as const };
      },
    };
    const sign = vi.fn(channelSigner(BUYER, buyerKeys.privateKey));
    const store = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
    const clientOptions = {
      role: "buyer",
      store,
      transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: sign,
      verifyChannelMessage: verifyChannel,
      profileAdmission: grantProfile,
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
      const transport: DurableRfqLifecycleTransport<ChannelMessageSignatureV1> = {
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
      const store = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
      const client = createDurableRfqLifecycleClient({
        role: "buyer",
        store,
        transport,
        reserveChannelId: durableReservation(),
        signChannelMessage: channelSigner(BUYER, buyerKeys.privateKey),
        verifyChannelMessage: verifyChannel,
        profileAdmission: grantProfile,
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
      const base = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
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
        signChannelMessage: channelSigner(BUYER, buyerKeys.privateKey),
        verifyChannelMessage: verifyChannel,
        profileAdmission: grantProfile,
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
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
    const { buyerClient, sellerClient } = clients(
      network.transport,
      durableReservation(),
      () => now,
    );
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
    const status = await sellerClient.getStatus(JOB_ID);
    expect(status.status).toBe("ok");
    if (status.status !== "ok") return;
    expect(status.record.session.status).toBe("timed-out");
    expect(status.record.session.turnCount).toBe(1);
    expect(status.record.transcript).toHaveLength(1);
    expect(status.record.failure).toMatchObject({ class: "timeout" });
  });

  test("persists permanent transport rejection as a terminal channel failure", async () => {
    const sign = vi.fn(channelSigner(BUYER, buyerKeys.privateKey));
    const transport: DurableRfqLifecycleTransport<ChannelMessageSignatureV1> = {
      async publish() {
        return { disposition: "rejected", reason: "member transport refused packet" };
      },
      async reconcile() {
        return { disposition: "rejected", reason: "member transport refused packet" };
      },
    };
    const client = createDurableRfqLifecycleClient({
      role: "buyer",
      store: createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>(),
      transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: sign,
      verifyChannelMessage: verifyChannel,
      profileAdmission: grantProfile,
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
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
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
    });
    const status = await sellerClient.getStatus(JOB_ID);
    expect(status.status === "ok" && status.record.agreement).toBeUndefined();
  });

  test("owns a proposal before the first asynchronous store read", async () => {
    const base = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
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
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
    const client = createDurableRfqLifecycleClient({
      role: "buyer",
      store,
      transport: network.transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: channelSigner(BUYER, buyerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      profileAdmission: grantProfile,
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
    const baseStore = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
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
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
    const options = {
      role: "buyer" as const,
      store,
      transport: network.transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: channelSigner(BUYER, buyerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      profileAdmission: grantProfile,
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
    const base = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
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
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
    const client = createDurableRfqLifecycleClient({
      role: "buyer",
      store,
      transport: network.transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: channelSigner(BUYER, buyerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      profileAdmission: grantProfile,
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

/** Store-version-1 records written by SDK main before the v0.6 channel wire. */
const STORE_V1 = JSON.parse(
  readFileSync(new URL("../fixtures/durable-rfq-store-v1.json", import.meta.url), "utf8"),
) as {
  jobId: string;
  buyerMidNegotiation: DurableRfqLifecycleRecord<string>;
  buyerFinalized: DurableRfqLifecycleRecord<string>;
  sellerFinalized: DurableRfqLifecycleRecord<string>;
};
const ARCHIVAL = "RFQ lifecycle record predates the DACS-3 v0.6 channel wire; it is read-only";

describe("durable RFQ records written before the v0.6 channel wire", () => {
  function archivalClient(record: DurableRfqLifecycleRecord<string>) {
    const store = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
    const sign = vi.fn(channelSigner(BUYER, buyerKeys.privateKey));
    const publish = vi.fn(async () => ({ disposition: "acknowledged" as const }));
    const reconcile = vi.fn(async () => ({ disposition: "absent" as const }));
    const profileAdmission = vi.fn(grantProfile);
    const client = createDurableRfqLifecycleClient({
      role: record.role,
      store,
      transport: { publish, reconcile },
      reserveChannelId: () => "pass",
      signChannelMessage: sign,
      verifyChannelMessage: verifyChannel,
      profileAdmission,
      agreementSigner: record.role === "buyer"
        ? agreementSigner(BUYER, buyerKeys.privateKey)
        : agreementSigner(SELLER, sellerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => NOW,
    });
    return { store, client, sign, publish, reconcile, profileAdmission };
  }

  test("load, validate and keep a finalized agreement readable", async () => {
    for (const record of [STORE_V1.buyerMidNegotiation, STORE_V1.buyerFinalized, STORE_V1.sellerFinalized]) {
      expect(record.storeVersion).toBe(1);
      expect(durableRfqLifecycleRecordViolation(record)).toBeNull();
    }
    expect(DURABLE_RFQ_LIFECYCLE_HISTORICAL_STORE_VERSION).toBe(1);
    const { store, client, profileAdmission } = archivalClient(STORE_V1.buyerFinalized);
    await expect(store.create(STORE_V1.buyerFinalized as never)).toMatchObject({ status: "created" });
    const status = await client.getStatus(STORE_V1.jobId);
    // The archival read admits nothing and performs no current lookup.
    expect(profileAdmission).not.toHaveBeenCalled();
    expect(status.status).toBe("ok");
    if (status.status !== "ok") return;
    expect(status.record.storeVersion).toBe(1);
    expect(status.record.agreement?.finalized).toEqual(STORE_V1.buyerFinalized.agreement?.finalized);
    expect(status.record.agreement?.finalized).toEqual(STORE_V1.sellerFinalized.agreement?.finalized);
  });

  test("refuse every live operation without signing, publishing or admitting", async () => {
    const finalized = archivalClient(STORE_V1.buyerFinalized);
    await finalized.store.create(STORE_V1.buyerFinalized as never);
    const sellerPacket = STORE_V1.sellerFinalized.outbox.at(-1)!.packet;
    const refused = { status: "rejected", reason: ARCHIVAL };
    await expect(finalized.client.open(openInput())).resolves.toMatchObject(refused);
    await expect(finalized.client.startAgreement(STORE_V1.jobId)).resolves.toMatchObject(refused);
    await expect(finalized.client.resumeOutbox(STORE_V1.jobId)).resolves.toMatchObject(refused);
    await expect(finalized.client.sendAbort(STORE_V1.jobId, "late")).resolves.toMatchObject(refused);
    await expect(finalized.client.receive(sellerPacket)).resolves.toMatchObject(refused);

    const open = archivalClient(STORE_V1.buyerMidNegotiation);
    await open.store.create(STORE_V1.buyerMidNegotiation as never);
    const policy = vi.fn(() => ({ action: "abort" as const }));
    await expect(open.client.respond(STORE_V1.jobId, policy)).resolves.toMatchObject(refused);
    expect(policy).not.toHaveBeenCalled();

    for (const harness of [finalized, open]) {
      expect(harness.sign).not.toHaveBeenCalled();
      expect(harness.publish).not.toHaveBeenCalled();
      expect(harness.reconcile).not.toHaveBeenCalled();
      expect(harness.profileAdmission).not.toHaveBeenCalled();
    }
  });

  test("store transitions never write a store-version-1 record", async () => {
    const store = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
    await store.create(STORE_V1.buyerFinalized as never);
    const next = {
      ...structuredClone(STORE_V1.buyerFinalized),
      revision: STORE_V1.buyerFinalized.revision + 1,
      updatedAt: STORE_V1.buyerFinalized.updatedAt + 1,
    };
    expect(durableRfqLifecycleTransitionViolation(STORE_V1.buyerFinalized, next)).toBe(
      "historical store-version-1 records are read-only",
    );
    await expect(
      store.compareAndSwap("buyer", STORE_V1.jobId, STORE_V1.buyerFinalized.revision, next as never),
    ).toMatchObject({ status: "corrupt", reason: "historical store-version-1 records are read-only" });
  });

  test("a current record whose turn is not current is a violation, not an exception", async () => {
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
    const { buyerClient, sellerClient } = clients(network.transport);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    const sent = await buyerClient.sendOffer(JOB_ID, {
      rfqProposalVersion: "1",
      price: { amount: "9", currency: "USDC" },
    });
    if (sent.status !== "ready") throw new Error(JSON.stringify(sent));
    const record = structuredClone(sent.record) as DurableRfqLifecycleRecord<ChannelMessageSignatureV1>;
    delete (record.transcript[0] as { canonicalChannelMessageVersion?: string }).canonicalChannelMessageVersion;
    expect(() => durableRfqLifecycleRecordViolation(record)).not.toThrow();
    expect(durableRfqLifecycleRecordViolation(record)).toBe(
      "transcript turn is not of the record's store version",
    );

    // The same turn on the wire is refused with the packet's own violation.
    const packet = structuredClone(network.take(SELLER)!) as RfqLifecyclePacket<ChannelMessageSignatureV1>;
    if (packet.kind !== "turn") throw new Error("expected a turn packet");
    delete (packet.message as { canonicalChannelMessageVersion?: string }).canonicalChannelMessageVersion;
    const { packetId: _packetId, ...unsigned } = packet;
    packet.packetId = rfqLifecyclePacketId(unsigned);
    await expect(sellerClient.receive(packet)).resolves.toEqual({
      status: "rejected",
      reason: "RFQ turn packet does not bind its routing envelope",
    });
  });
});

describe("durable RFQ with CH-7-qualified sender spellings", () => {
  const QUALIFIED_BUYER = `${BUYER}?role=buyer`;
  const identityOf = (claim: string) => claim.split("?")[0]!;
  function verifyQualified(
    input: Readonly<ChannelMessageSignatureVerificationInput<RfqTurnBody, ChannelMessageSignatureV1>>,
  ) {
    const key = publicKeys.get(identityOf(input.message.sender));
    return key !== undefined &&
      identityOf(input.message.signature.signer) === identityOf(input.message.sender) &&
      ed25519Verify(null, Buffer.from(input.signedBytes), key, Buffer.from(input.message.signature.value, "base64url"))
      ? ("pass" as const)
      : ("fail" as const);
  }
  function qualifiedOffer(packetSender: string, recipient = SELLER) {
    const signing = prepareChannelMessageSigningInput<RfqTurnBody>({
      canonicalChannelMessageVersion: "1",
      channelId: openInput().channelId,
      sequence: 1,
      sender: QUALIFIED_BUYER,
      sentAt: NOW,
      type: "offer",
      body: { rfqBodyVersion: "1", proposal: { rfqProposalVersion: "1", price: { amount: "9", currency: "USDC" } } },
    });
    const message = {
      ...structuredClone(signing.unsignedEnvelope),
      signature: channelSigner(QUALIFIED_BUYER, buyerKeys.privateKey)(signing),
    };
    const unsigned = {
      packetVersion: "1" as const,
      jobId: JOB_ID,
      channelId: openInput().channelId,
      sender: packetSender,
      recipient,
      kind: "turn" as const,
      message,
    };
    return { message, packet: { ...unsigned, packetId: rfqLifecyclePacketId(unsigned) } };
  }
  function sellerClient(store = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>()) {
    return createDurableRfqLifecycleClient({
      role: "seller",
      store,
      transport: createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>().transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: channelSigner(SELLER, sellerKeys.privateKey),
      verifyChannelMessage: verifyQualified,
      profileAdmission: grantProfile,
      agreementSigner: agreementSigner(SELLER, sellerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => NOW,
    });
  }

  test.each([
    ["the primary claim", BUYER],
    ["the qualified spelling", QUALIFIED_BUYER],
  ])("a session advanced by a qualified sender stays consistent when the packet routes by %s", async (_label, packetSender) => {
    const client = sellerClient();
    await client.open(openInput());
    const { message, packet } = qualifiedOffer(packetSender);
    const received = await client.receive(packet);
    expect(received, JSON.stringify(received)).toMatchObject({ status: "ready" });
    const countered = await client.respond(JOB_ID, () => ({
      action: "counter",
      proposal: { rfqProposalVersion: "1", price: { amount: "9.5", currency: "USDC" } },
    }));
    expect(countered, JSON.stringify(countered)).toMatchObject({ status: "ready" });
    const status = await client.getStatus(JOB_ID);
    expect(status.status).toBe("ok");
    if (status.status !== "ok") return;
    // The exact signed bytes are kept; the session state holds the primary claim.
    expect(status.record.transcript[0]).toEqual(message);
    expect(status.record.session.standingProposal?.proposer).toBe(SELLER);
    expect(status.record.session.expectedSender).toBe(BUYER);
    expect(durableRfqLifecycleRecordViolation(status.record)).toBeNull();

    // An outbox packet routed by a qualified spelling of the local member is
    // the same party.
    const record = structuredClone(status.record);
    const outbound = record.outbox[0]!.packet;
    outbound.sender = `${SELLER}?role=seller`;
    const { packetId: _packetId, ...unsigned } = outbound;
    outbound.packetId = rfqLifecyclePacketId(unsigned);
    expect(durableRfqLifecycleRecordViolation(record)).toBeNull();
  });

  test("a packet addressed from a party to itself is malformed", async () => {
    const client = sellerClient();
    await client.open(openInput());
    const { packet } = qualifiedOffer(BUYER, QUALIFIED_BUYER);
    await expect(client.receive(packet)).resolves.toEqual({
      status: "rejected",
      reason: "RFQ lifecycle packet is malformed",
    });
  });
});

describe("durable RFQ corrective-profile admission", () => {
  /** A client whose resolver grants only while `access.granted` is set, and otherwise behaves as `refuse`. */
  function harness(refuse: RfqLifecycleProfileAdmission, role: "buyer" | "seller" = "buyer") {
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
    const access = { granted: false };
    const clock = { now: NOW };
    const reserve = vi.fn(durableReservation());
    const sign = vi.fn(role === "buyer"
      ? channelSigner(BUYER, buyerKeys.privateKey)
      : channelSigner(SELLER, sellerKeys.privateKey));
    const client = createDurableRfqLifecycleClient({
      role,
      store: createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>(),
      transport: network.transport,
      reserveChannelId: reserve,
      signChannelMessage: sign,
      verifyChannelMessage: verifyChannel,
      profileAdmission: (request) => (access.granted ? grantProfile(request) : refuse(request)),
      agreementSigner: role === "buyer"
        ? agreementSigner(BUYER, buyerKeys.privateKey)
        : agreementSigner(SELLER, sellerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => clock.now,
    });
    return { network, access, clock, reserve, sign, client };
  }
  const offer = { rfqProposalVersion: "1" as const, price: { amount: "9", currency: "USDC" } };

  test.each([
    ["no authority", () => undefined],
    ["a throwing resolver", () => {
      throw new Error("authority service offline");
    }],
    ["a rejecting resolver", () => Promise.reject(new Error("authority service offline"))],
  ])("refuses to open, sign or admit with %s", async (_label, refuse) => {
    const { network, access, reserve, sign, client } = harness(refuse);
    // Without authority nothing is reserved, stored or issued.
    await expect(client.open(openInput())).resolves.toMatchObject({ status: "indeterminate" });
    expect(reserve).not.toHaveBeenCalled();
    await expect(client.getStatus(JOB_ID)).resolves.toEqual({ status: "missing" });
    access.granted = true;
    await expect(client.open(openInput())).resolves.toMatchObject({ status: "ready" });
    // Reopening an existing current record reserves nothing more, and is
    // refused once the authority is gone. The reopen is `duplicate` only with
    // the same `startedAt` (this clock is fixed); `startedAt` is part of the
    // binding hash, so a later clock reading makes it `conflict`.
    await expect(client.open(openInput())).resolves.toMatchObject({ status: "duplicate" });
    expect(reserve).toHaveBeenCalledOnce();
    access.granted = false;
    await expect(client.open(openInput())).resolves.toMatchObject({ status: "indeterminate" });
    // A session opened under authority signs nothing once the authority is gone.
    await expect(client.sendOffer(JOB_ID, offer)).resolves.toMatchObject({ status: "indeterminate" });
    expect(sign).not.toHaveBeenCalled();
    expect(network.pending(SELLER)).toBe(0);
  });

  test("refuses to open, and refuses an inbound turn, when the authority binds another session", async () => {
    const seller = harness(({ participantIdentities }) =>
      rfqProfileAdmission("another-private-channel", participantIdentities), "seller");
    await expect(seller.client.open(openInput())).resolves.toMatchObject({
      status: "rejected",
      reason: "corrective-profile authority binds another session",
    });
    expect(seller.reserve).not.toHaveBeenCalled();
    seller.access.granted = true;
    await expect(seller.client.open(openInput())).resolves.toMatchObject({ status: "ready" });
    const { buyerClient } = clients(seller.network.transport);
    await buyerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, offer);
    seller.access.granted = false;
    await expect(seller.client.receive(seller.network.take(SELLER))).resolves.toMatchObject({
      status: "rejected",
      reason: "corrective-profile authority binds another session",
    });
  });

  test("an expired inbound turn without authority persists no timeout", async () => {
    const seller = harness(() => undefined, "seller");
    seller.access.granted = true;
    await seller.client.open(openInput());
    const { buyerClient } = clients(seller.network.transport);
    await buyerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, offer);
    const before = await seller.client.getStatus(JOB_ID);
    seller.access.granted = false;
    seller.clock.now = NOW + 10_001;
    await expect(seller.client.receive(seller.network.take(SELLER))).resolves.toMatchObject({
      status: "indeterminate",
    });
    seller.access.granted = true;
    await expect(seller.client.getStatus(JOB_ID)).resolves.toEqual(before);
  });

  test("a resolver that returns only the profile signs nothing when Object.prototype carries an authority", async () => {
    const profileOnly: RfqLifecycleProfileAdmission = ({ channelId, participantIdentities }) => ({
      profile: rfqProfileAdmission(channelId, participantIdentities).profile,
    });
    const opened = harness(profileOnly);
    opened.access.granted = true;
    await opened.client.open(openInput());
    opened.access.granted = false;
    const fresh = harness(profileOnly);
    Object.defineProperty(Object.prototype, "authority", {
      value: rfqProfileAdmission(openInput().channelId, [BUYER, SELLER]).authority,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    try {
      await expect(opened.client.sendOffer(JOB_ID, offer)).resolves.toMatchObject({ status: "indeterminate" });
      await expect(fresh.client.open(openInput())).resolves.toMatchObject({ status: "indeterminate" });
    } finally {
      delete (Object.prototype as Record<string, unknown>).authority;
    }
    expect(opened.sign).not.toHaveBeenCalled();
    expect(opened.network.pending(SELLER)).toBe(0);
    expect(fresh.reserve).not.toHaveBeenCalled();
  });
});

describe("durable RFQ agreement and outbox admission", () => {
  type Network = ReturnType<typeof createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>>;
  const offer = { rfqProposalVersion: "1" as const, price: { amount: "9", currency: "USDC" } };
  const refusals: Array<[string, RfqLifecycleProfileAdmission, "indeterminate" | "rejected"]> = [
    ["no authority", () => undefined, "indeterminate"],
    ["a throwing resolver", () => {
      throw new Error("authority service offline");
    }, "indeterminate"],
    ["a rejecting resolver", () => Promise.reject(new Error("authority service offline")), "indeterminate"],
    ["an authority for another session", ({ participantIdentities }) =>
      rfqProfileAdmission("another-private-channel", participantIdentities), "rejected"],
  ];

  /**
   * One party whose resolver grants while `access.granted` is set and otherwise
   * behaves as `refuse`. Its agreement signer, publisher, reconciler and store
   * CAS are counted.
   */
  function party(
    role: "buyer" | "seller",
    refuse: RfqLifecycleProfileAdmission,
    network: Network,
    reservation = durableReservation(),
  ) {
    const access = { granted: true };
    const inner = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
    const cas = vi.fn((...args: Parameters<typeof inner.compareAndSwap>) => inner.compareAndSwap(...args));
    const publish = vi.fn((packet: Readonly<RfqLifecyclePacket<ChannelMessageSignatureV1>>) =>
      network.transport.publish(packet));
    const reconcile = vi.fn((packet: Readonly<RfqLifecyclePacket<ChannelMessageSignatureV1>>) =>
      network.transport.reconcile(packet));
    const claim = role === "buyer" ? BUYER : SELLER;
    const keys = role === "buyer" ? buyerKeys : sellerKeys;
    const agreementSign = vi.fn((bytes: Uint8Array) => ed25519Sign(null, bytes, keys.privateKey));
    const channelSign = vi.fn(channelSigner(claim, keys.privateKey));
    const profileAdmission = vi.fn((request: Parameters<RfqLifecycleProfileAdmission>[0]) =>
      (access.granted ? grantProfile(request) : refuse(request)));
    const client = createDurableRfqLifecycleClient({
      role,
      store: {
        load: (...args) => inner.load(...args),
        create: (candidate) => inner.create(candidate),
        compareAndSwap: cas,
      },
      transport: { publish, reconcile },
      reserveChannelId: reservation,
      signChannelMessage: channelSign,
      verifyChannelMessage: verifyChannel,
      profileAdmission,
      agreementSigner: { party: claim, algorithm: "ed25519", sign: agreementSign },
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => NOW,
    });
    return { access, cas, publish, reconcile, agreementSign, channelSign, profileAdmission, client };
  }

  /**
   * Withdraws `side`'s authority for `run`, which must refuse with `status`
   * after one resolver call, return no record and change nothing.
   */
  async function refusedWithoutEffects(
    side: ReturnType<typeof party>,
    status: "indeterminate" | "rejected",
    run: () => Promise<{ status: string }>,
  ) {
    const effects = () =>
      [side.channelSign, side.agreementSign, side.publish, side.reconcile, side.cas]
        .map((spy) => spy.mock.calls.length);
    const before = await side.client.getStatus(JOB_ID);
    expect(before.status).toBe("ok");
    const counted = effects();
    const resolved = side.profileAdmission.mock.calls.length;
    side.access.granted = false;
    let result: { status: string };
    try {
      result = await run();
    } finally {
      side.access.granted = true;
    }
    expect(result.status).toBe(status);
    expect(result).not.toHaveProperty("record");
    expect(side.profileAdmission).toHaveBeenCalledTimes(resolved + 1);
    expect(effects()).toEqual(counted);
    await expect(side.client.getStatus(JOB_ID)).resolves.toEqual(before);
  }

  test.each(refusals)(
    "refuses each agreement step with %s, and each proceeds once admitted",
    async (_label, refuse, status) => {
      const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
      const reservation = durableReservation();
      const buyerSide = party("buyer", refuse, network, reservation);
      const sellerSide = party("seller", refuse, network, reservation);
      await buyerSide.client.open(openInput());
      await sellerSide.client.open(openInput());
      await buyerSide.client.sendOffer(JOB_ID, offer);
      await deliver(network, SELLER, sellerSide.client);
      await sellerSide.client.sendAccept(JOB_ID);
      await deliver(network, BUYER, buyerSide.client);

      await refusedWithoutEffects(buyerSide, status, () => buyerSide.client.startAgreement(JOB_ID));
      expect(network.pending(SELLER)).toBe(0);
      await expect(buyerSide.client.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "ready" });

      const proposal = network.take(SELLER)!;
      await refusedWithoutEffects(sellerSide, status, () => sellerSide.client.receive(proposal));
      expect(network.pending(BUYER)).toBe(0);
      await expect(sellerSide.client.receive(proposal)).resolves.toMatchObject({ status: "ready" });

      const contribution = network.take(BUYER)!;
      await refusedWithoutEffects(buyerSide, status, () => buyerSide.client.receive(contribution));
      await expect(buyerSide.client.receive(contribution)).resolves.toMatchObject({
        status: "ready",
        record: { agreement: { finalized: expect.anything() } },
      });
      expect(buyerSide.agreementSign).toHaveBeenCalledOnce();
      expect(sellerSide.agreementSign).toHaveBeenCalledOnce();
    },
  );

  test.each(refusals)(
    "resumeOutbox with %s leaves the pending packet in place, and republishes once admitted",
    async (_label, refuse, status) => {
      const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
      const buyerSide = party("buyer", refuse, network);
      buyerSide.publish.mockImplementationOnce(async () => ({
        disposition: "indeterminate" as const,
        reason: "lost response",
      }));
      await buyerSide.client.open(openInput());
      await expect(buyerSide.client.sendOffer(JOB_ID, offer)).resolves.toMatchObject({ status: "indeterminate" });

      await refusedWithoutEffects(buyerSide, status, () => buyerSide.client.resumeOutbox(JOB_ID));
      await expect(buyerSide.client.getStatus(JOB_ID)).resolves.toMatchObject({
        status: "ok",
        record: { outbox: [{ state: "indeterminate", attempts: 1 }] },
      });
      expect(network.pending(SELLER)).toBe(0);

      await expect(buyerSide.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({
        status: "ready",
        record: { outbox: [{ state: "acknowledged" }] },
      });
      expect(network.pending(SELLER)).toBe(1);
    },
  );

  test.each(refusals)(
    "with %s, status, duplicate, nothing-pending and locally refused paths return no record",
    async (_label, refuse, status) => {
      const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
      const reservation = durableReservation();
      const buyerSide = party("buyer", refuse, network, reservation);
      const sellerSide = party("seller", refuse, network, reservation);
      await buyerSide.client.open(openInput());
      await sellerSide.client.open(openInput());
      await buyerSide.client.sendOffer(JOB_ID, offer);
      const { packet: offerPacket } = await deliver(network, SELLER, sellerSide.client);
      await sellerSide.client.sendAccept(JOB_ID);
      const { packet: acceptPacket } = await deliver(network, BUYER, buyerSide.client);
      await buyerSide.client.startAgreement(JOB_ID);
      const { packet: proposal } = await deliver(network, SELLER, sellerSide.client);
      const { packet: contribution } = await deliver(network, BUYER, buyerSide.client);
      const policy = vi.fn(() => ({ action: "abort" as const }));

      // Every outbox entry is acknowledged, every packet is already received and
      // the session is terminal: each of these used to return the stored signed
      // record before consulting the resolver.
      await refusedWithoutEffects(buyerSide, status, () => buyerSide.client.getStatus(JOB_ID));
      await refusedWithoutEffects(buyerSide, status, () => buyerSide.client.resumeOutbox(JOB_ID));
      await refusedWithoutEffects(buyerSide, status, () => buyerSide.client.startAgreement(JOB_ID));
      await refusedWithoutEffects(buyerSide, status, () => buyerSide.client.receive(acceptPacket));
      await refusedWithoutEffects(buyerSide, status, () => buyerSide.client.receive(contribution));
      await refusedWithoutEffects(sellerSide, status, () => sellerSide.client.receive(offerPacket));
      await refusedWithoutEffects(sellerSide, status, () => sellerSide.client.receive(proposal));
      await refusedWithoutEffects(sellerSide, status, () => sellerSide.client.sendAccept(JOB_ID));
      await refusedWithoutEffects(sellerSide, status, () => sellerSide.client.sendOffer(JOB_ID, offer));
      await refusedWithoutEffects(sellerSide, status, () => sellerSide.client.respond(JOB_ID, policy));
      expect(policy).not.toHaveBeenCalled();

      // Once admitted, the same paths return the record as before.
      await expect(buyerSide.client.getStatus(JOB_ID)).resolves.toMatchObject({
        status: "ok",
        record: { agreement: { finalized: expect.anything() } },
      });
      await expect(buyerSide.client.resumeOutbox(JOB_ID)).resolves.toMatchObject({ status: "ready" });
      await expect(buyerSide.client.startAgreement(JOB_ID)).resolves.toMatchObject({ status: "duplicate" });
      await expect(sellerSide.client.receive(proposal)).resolves.toMatchObject({ status: "duplicate" });
    },
  );

  test("a policy response checks its admission again against the job as reloaded", async () => {
    const opened = async (channelId: string) => {
      const store = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
      const result = await createDurableRfqLifecycleClient({
        role: "buyer",
        store,
        transport: createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>().transport,
        reserveChannelId: durableReservation(),
        signChannelMessage: channelSigner(BUYER, buyerKeys.privateKey),
        verifyChannelMessage: verifyChannel,
        profileAdmission: grantProfile,
        agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
        verifyAgreementContribution: verifyAgreement,
        nowMs: () => NOW,
      }).open({ ...openInput(), channelId });
      expect(result.status).toBe("ready");
      return store;
    };
    const admittedStore = await opened(openInput().channelId);
    const otherStore = await opened("durable-private-channel-02");
    // The first load returns the admitted job; every later load returns a job
    // with the same jobId on another channel.
    let loads = 0;
    const sign = vi.fn(channelSigner(BUYER, buyerKeys.privateKey));
    const profileAdmission = vi.fn(grantProfile);
    const client = createDurableRfqLifecycleClient({
      role: "buyer",
      store: {
        load: (...args) => ((loads += 1) === 1 ? admittedStore : otherStore).load(...args),
        create: (candidate) => otherStore.create(candidate),
        compareAndSwap: (...args) => otherStore.compareAndSwap(...args),
      },
      transport: createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>().transport,
      reserveChannelId: durableReservation(),
      signChannelMessage: sign,
      verifyChannelMessage: verifyChannel,
      profileAdmission,
      agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => NOW,
    });
    const policy = vi.fn(() => ({ action: "abort" as const }));
    await expect(client.respond(JOB_ID, policy)).resolves.toEqual({
      status: "rejected",
      reason: "corrective-profile authority binds another session",
    });
    expect(policy).toHaveBeenCalledOnce();
    expect(profileAdmission).toHaveBeenCalledTimes(2);
    expect(sign).not.toHaveBeenCalled();
  });

  test.each([
    ["counter", { action: "counter" as const, proposal: { rfqProposalVersion: "1" as const, price: { amount: "9.5", currency: "USDC" } } }],
    ["accept", { action: "accept" as const }],
    ["reject", { action: "reject" as const }],
    ["abort", { action: "abort" as const }],
  ])("authority withdrawn while the policy runs refuses its %s before signing", async (_label, decision) => {
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
    const reservation = durableReservation();
    const buyerSide = party("buyer", () => undefined, network, reservation);
    const sellerSide = party("seller", () => undefined, network, reservation);
    await buyerSide.client.open(openInput());
    await sellerSide.client.open(openInput());
    await buyerSide.client.sendOffer(JOB_ID, offer);
    await deliver(network, SELLER, sellerSide.client);
    const before = await sellerSide.client.getStatus(JOB_ID);
    const effects = () =>
      [sellerSide.channelSign, sellerSide.publish, sellerSide.cas].map((spy) => spy.mock.calls.length);
    const counted = effects();
    sellerSide.profileAdmission.mockClear();
    let result: { status: string };
    try {
      result = await sellerSide.client.respond(JOB_ID, async () => {
        // The policy awaits a person or a model; the authority is withdrawn meanwhile.
        sellerSide.access.granted = false;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return decision;
      });
    } finally {
      sellerSide.access.granted = true;
    }
    expect(result.status).toBe("indeterminate");
    expect(result).not.toHaveProperty("record");
    expect(sellerSide.profileAdmission).toHaveBeenCalledTimes(2);
    expect(effects()).toEqual(counted);
    expect(network.pending(BUYER)).toBe(0);
    await expect(sellerSide.client.getStatus(JOB_ID)).resolves.toEqual(before);
  });

  test("a status read for a job without a record consults no resolver", async () => {
    const side = party("buyer", () => undefined, createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>());
    side.access.granted = false;
    await expect(side.client.getStatus(JOB_ID)).resolves.toEqual({ status: "missing" });
    expect(side.profileAdmission).not.toHaveBeenCalled();
  });

  test.each([
    ["sendAccept", (client: DurableRfqLifecycleClient<ChannelMessageSignatureV1>) => client.sendAccept(JOB_ID)],
    ["a policy accept", (client: DurableRfqLifecycleClient<ChannelMessageSignatureV1>) =>
      client.respond(JOB_ID, () => ({ action: "accept" }))],
  ])("each operation resolves the profile once per load, accepting with %s", async (label, accept) => {
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
    const reservation = durableReservation();
    const buyerSide = party("buyer", () => undefined, network, reservation);
    const sellerSide = party("seller", () => undefined, network, reservation);
    /** Grants the next `calls` resolver calls only; any further call in the same operation is refused. */
    const admits = async (side: typeof buyerSide, calls: number, run: () => Promise<{ status: string }>) => {
      side.access.granted = false;
      side.profileAdmission.mockClear();
      for (let call = 0; call < calls; call += 1) side.profileAdmission.mockImplementationOnce(grantProfile);
      try {
        await expect(run()).resolves.toMatchObject({ status: "ready" });
      } finally {
        side.access.granted = true;
      }
      expect(side.profileAdmission).toHaveBeenCalledTimes(calls);
    };
    await buyerSide.client.open(openInput());
    await sellerSide.client.open(openInput());
    await admits(buyerSide, 1, () => buyerSide.client.sendOffer(JOB_ID, offer));
    await admits(sellerSide, 1, () => sellerSide.client.receive(network.take(SELLER)));
    // A policy response loads the job before the policy and again before signing.
    await admits(sellerSide, 2, () => sellerSide.client.respond(JOB_ID, () => ({
      action: "counter",
      proposal: { rfqProposalVersion: "1", price: { amount: "9.5", currency: "USDC" } },
    })));
    await admits(buyerSide, 1, () => buyerSide.client.receive(network.take(BUYER)));
    await admits(buyerSide, label === "sendAccept" ? 1 : 2, () => accept(buyerSide.client));
    await admits(sellerSide, 1, () => sellerSide.client.receive(network.take(SELLER)));
    await admits(buyerSide, 1, () => buyerSide.client.startAgreement(JOB_ID));
    await admits(buyerSide, 1, () => buyerSide.client.getStatus(JOB_ID).then((loaded) => ({
      status: loaded.status === "ok" ? "ready" : loaded.status,
    })));
  });

  test("a receive retried after a stale write admits again before it acts", async () => {
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
    const reservation = durableReservation();
    const buyerSide = party("buyer", () => undefined, network, reservation);
    const sellerSide = party("seller", () => undefined, network, reservation);
    await buyerSide.client.open(openInput());
    await sellerSide.client.open(openInput());
    await buyerSide.client.sendOffer(JOB_ID, offer);
    sellerSide.cas.mockImplementationOnce(async () => ({ status: "stale" as const }));
    sellerSide.profileAdmission.mockClear();
    await expect(sellerSide.client.receive(network.take(SELLER))).resolves.toMatchObject({ status: "ready" });
    expect(sellerSide.cas).toHaveBeenCalledTimes(2);
    expect(sellerSide.profileAdmission).toHaveBeenCalledTimes(2);
  });

  test("an Agreement proposal retried after a stale write is refused once authority is withdrawn", async () => {
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
    const reservation = durableReservation();
    const buyerSide = party("buyer", () => undefined, network, reservation);
    const sellerSide = party("seller", () => undefined, network, reservation);
    await buyerSide.client.open(openInput());
    await sellerSide.client.open(openInput());
    await buyerSide.client.sendOffer(JOB_ID, offer);
    await deliver(network, SELLER, sellerSide.client);
    await sellerSide.client.sendAccept(JOB_ID);
    await deliver(network, BUYER, buyerSide.client);
    await buyerSide.client.startAgreement(JOB_ID);
    const proposal = network.take(SELLER)!;
    const before = await sellerSide.client.getStatus(JOB_ID);
    for (const spy of [sellerSide.profileAdmission, sellerSide.agreementSign, sellerSide.publish, sellerSide.cas]) {
      spy.mockClear();
    }
    // The first write is stale, and the authority is withdrawn during that attempt.
    sellerSide.cas.mockImplementationOnce(async () => {
      sellerSide.access.granted = false;
      return { status: "stale" as const };
    });
    let result: { status: string };
    try {
      result = await sellerSide.client.receive(proposal);
    } finally {
      sellerSide.access.granted = true;
    }
    expect(result.status).toBe("indeterminate");
    expect(result).not.toHaveProperty("record");
    expect(sellerSide.profileAdmission).toHaveBeenCalledTimes(2);
    expect(sellerSide.cas).toHaveBeenCalledOnce();
    // Only the first attempt, made while admitted, signed; nothing was published.
    expect(sellerSide.agreementSign).toHaveBeenCalledOnce();
    expect(sellerSide.publish).not.toHaveBeenCalled();
    expect(network.pending(BUYER)).toBe(0);
    await expect(sellerSide.client.getStatus(JOB_ID)).resolves.toEqual(before);

    await expect(sellerSide.client.receive(proposal)).resolves.toMatchObject({ status: "ready" });
    expect(network.pending(BUYER)).toBe(1);
  });
});

describe("durable RFQ record validation", () => {
  test("opening a job whose record is store version 1 reserves nothing", async () => {
    const record = STORE_V1.buyerMidNegotiation;
    const store = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
    await store.create(record as never);
    const reserve = vi.fn(() => "pass" as const);
    const profileAdmission = vi.fn(grantProfile);
    const client = createDurableRfqLifecycleClient({
      role: "buyer",
      store,
      transport: createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>().transport,
      reserveChannelId: reserve,
      signChannelMessage: channelSigner(BUYER, buyerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      profileAdmission,
      agreementSigner: agreementSigner(record.session.buyer.primaryClaim, buyerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs: () => record.createdAt,
    });
    await expect(client.open({
      jobId: record.jobId,
      verifiedListing: record.authority.verifiedListing,
      buyer: record.authority.buyer,
      seller: record.authority.seller,
      channelId: record.channelId,
    })).resolves.toMatchObject({ status: "rejected", reason: ARCHIVAL, record: { storeVersion: 1 } });
    expect(reserve).not.toHaveBeenCalled();
    expect(profileAdmission).not.toHaveBeenCalled();
  });

  function racingClient(store: DurableRfqLifecycleStore<ChannelMessageSignatureV1>, nowMs = () => NOW) {
    const reserve = vi.fn(() => "pass" as const);
    const profileAdmission = vi.fn(grantProfile);
    const client = createDurableRfqLifecycleClient({
      role: "buyer",
      store,
      transport: createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>().transport,
      reserveChannelId: reserve,
      signChannelMessage: channelSigner(BUYER, buyerKeys.privateKey),
      verifyChannelMessage: verifyChannel,
      profileAdmission,
      agreementSigner: agreementSigner(BUYER, buyerKeys.privateKey),
      verifyAgreementContribution: verifyAgreement,
      nowMs,
    });
    return { reserve, profileAdmission, client };
  }

  test("a version-1 record created after the first load of open() reserves nothing", async () => {
    const record = STORE_V1.buyerMidNegotiation;
    const inner = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
    let imported = false;
    const load = vi.fn(async (...args: Parameters<typeof inner.load>) => {
      const loaded = await inner.load(...args);
      if (!imported) {
        // Another process imports the archival record right after this load.
        imported = true;
        await inner.create(structuredClone(record) as never);
      }
      return loaded;
    });
    const { reserve, profileAdmission, client } = racingClient({
      load,
      create: (candidate) => inner.create(candidate),
      compareAndSwap: (...args) => inner.compareAndSwap(...args),
    }, () => record.createdAt);
    await expect(client.open({ ...openInput(), jobId: record.jobId, channelId: record.channelId }))
      .resolves.toMatchObject({ status: "rejected", reason: ARCHIVAL, record: { storeVersion: 1 } });
    expect(load).toHaveBeenCalledTimes(2);
    expect(profileAdmission).toHaveBeenCalledOnce();
    expect(reserve).not.toHaveBeenCalled();
  });

  test("a failed second load of open() reserves nothing", async () => {
    const inner = createInMemoryDurableRfqLifecycleStore<ChannelMessageSignatureV1>();
    let loads = 0;
    const create = vi.fn((candidate: DurableRfqLifecycleRecord<ChannelMessageSignatureV1>) => inner.create(candidate));
    const { reserve, client } = racingClient({
      load: async (...args) => {
        loads += 1;
        if (loads > 1) throw new Error("store offline");
        return inner.load(...args);
      },
      create,
      compareAndSwap: (...args) => inner.compareAndSwap(...args),
    });
    await expect(client.open(openInput())).resolves.toEqual({
      status: "indeterminate",
      reason: "RFQ lifecycle store load failed",
    });
    expect(loads).toBe(2);
    expect(reserve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test("a version-1 record created after the last load of open() is refused after one reservation (documented window)", async () => {
    const load = vi.fn(async () => ({ status: "missing" as const }));
    const create = vi.fn(async (candidate: DurableRfqLifecycleRecord<ChannelMessageSignatureV1>) => ({
      status: "existing" as const,
      record: { ...structuredClone(candidate), storeVersion: DURABLE_RFQ_LIFECYCLE_HISTORICAL_STORE_VERSION },
    }));
    const { reserve, profileAdmission, client } = racingClient({
      load,
      create,
      compareAndSwap: vi.fn(),
    } as unknown as DurableRfqLifecycleStore<ChannelMessageSignatureV1>);
    await expect(client.open(openInput())).resolves.toMatchObject({
      status: "rejected",
      reason: ARCHIVAL,
      record: { storeVersion: 1 },
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(profileAdmission).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });

  test("the record validator returns a violation for primitive and null nested values", () => {
    for (const [label, candidate] of malformedNestedRecords(STORE_V1.buyerFinalized)) {
      let violation: unknown;
      expect(() => {
        violation = durableRfqLifecycleRecordViolation(candidate);
      }, label).not.toThrow();
      expect(typeof violation, label).toBe("string");
    }
    const base = STORE_V1.buyerFinalized;
    expect(durableRfqLifecycleRecordViolation({ ...structuredClone(base), session: null }))
      .toBe("record session or authority is malformed");
    expect(durableRfqLifecycleRecordViolation({ ...structuredClone(base), transcript: [null, ...base.transcript.slice(1)] }))
      .toBe("transcript turn is malformed");
    // A defect no named check covers is still a violation.
    expect(durableRfqLifecycleRecordViolation({ ...structuredClone(base), session: { ...structuredClone(base.session), buyer: {} } }))
      .toBe("record cannot be validated");
  });

  test("every transcript turn is hashed under its record's store version", async () => {
    const network = createInMemoryRfqLifecycleNetwork<ChannelMessageSignatureV1>();
    const { buyerClient, sellerClient } = clients(network.transport);
    await buyerClient.open(openInput());
    await sellerClient.open(openInput());
    await buyerClient.sendOffer(JOB_ID, { rfqProposalVersion: "1", price: { amount: "9", currency: "USDC" } });
    await deliver(network, SELLER, sellerClient);
    await sellerClient.respond(JOB_ID, () => ({
      action: "counter",
      proposal: { rfqProposalVersion: "1", price: { amount: "9.5", currency: "USDC" } },
    }));
    await deliver(network, BUYER, buyerClient);
    const status = await buyerClient.getStatus(JOB_ID);
    if (status.status !== "ok") throw new Error(status.status);
    expect(status.record.transcript).toHaveLength(2);
    expect(durableRfqLifecycleRecordViolation(status.record)).toBeNull();
    const reason = "transcript turn is not of the record's store version";

    const undiscriminated = structuredClone(status.record);
    delete (undiscriminated.transcript[0] as { canonicalChannelMessageVersion?: string }).canonicalChannelMessageVersion;
    expect(durableRfqLifecycleRecordViolation(undiscriminated)).toBe(reason);
    const junk = structuredClone(status.record);
    (junk.transcript as unknown[])[0] = { channelId: junk.channelId, sender: BUYER, sequence: 1 };
    expect(durableRfqLifecycleRecordViolation(junk)).toBe(reason);

    const historical = structuredClone(STORE_V1.buyerFinalized);
    expect(historical.transcript.length).toBeGreaterThan(1);
    (historical.transcript[0] as unknown as Record<string, unknown>).canonicalChannelMessageVersion = "1";
    expect(durableRfqLifecycleRecordViolation(historical)).toBe(reason);
  });
});
