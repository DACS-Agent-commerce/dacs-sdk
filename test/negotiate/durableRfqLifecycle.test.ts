import {
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
  rfqLifecyclePacketId,
  type AttestationRef,
  type ChannelMessageSignatureVerificationInput,
  type DurableRfqLifecycleClient,
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

  test("uses its trusted clock to persist timeout without signing or publishing a late turn", async () => {
    let now = NOW;
    const network = createInMemoryRfqLifecycleNetwork<string>();
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
    });
    const status = await sellerClient.getStatus(JOB_ID);
    expect(status.status === "ok" && status.record.agreement).toBeUndefined();
  });
});
