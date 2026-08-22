import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compositeVerificationAddress, type ProtocolAnchorReceipt } from
  "@kynesyslabs/dacs";
import type {
  AttestationRef,
  CompositeVerificationRecord,
  IdentityBundle,
  Listing,
  PaymentRailRef,
} from
  "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  type FixedPriceX402OrderInput,
} from "@kynesyslabs/dacs/commerce";
import {
  createFixedPriceAgreementSignatureContribution,
  createFixedPriceAgreementSigningPlan,
  deriveFixedPriceAgreement,
  type FixedPriceAgreementProposal,
  type FixedPriceAgreementTransportIdentity,
} from "@kynesyslabs/dacs/negotiate";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDacsBuyerAgreementTransportRuntimeV1,
  createDacsSellerAgreementTransportRuntimeV1,
} from "../src/agreementTransportRuntime.js";
import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import type {
  DacsLiveRoleInboundOperationContextV1,
  DacsLiveRoleOperationContextV1,
} from "../src/roleRuntime.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import type { DacsHttpAuthenticatedEnvelopeV1 } from "../src/transport/envelope.js";

const NOW = 1_787_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;

const RAIL: PaymentRailRef = {
  railId: "x402:runtime",
  railVersion: 2,
  parameters: { network: "eip155:8453" },
};

function identity(primaryClaim: string): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: primaryClaim,
    presentedAt: NOW - 1_000,
    claims: [{ ref: primaryClaim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: primaryClaim, signature: "identity-proof" }],
    },
  };
}

function vet(role: "buyer" | "seller"): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator: `stor:${role}-vet` },
    contentHash: role === "buyer" ? "a".repeat(64) : "b".repeat(64),
  };
}

function sellerVetProduction(): Readonly<{
  record: CompositeVerificationRecord;
  recordRef: AttestationRef;
  anchorReceipt: ProtocolAnchorReceipt;
}> {
  const record: CompositeVerificationRecord = {
    recordVersion: "1",
    jobId: JOB_ID,
    evaluatedParty: SELLER,
    bundleHash: "6".repeat(64),
    requirementHash: "7".repeat(64),
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision: "pass",
    generatedAt: NOW,
    signature: {
      algorithm: "ed25519",
      signer: BUYER,
      value: Buffer.alloc(64, 6).toString("base64url"),
    },
  };
  const logicalAddress = compositeVerificationAddress(JOB_ID, SELLER);
  const recordRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: logicalAddress },
    contentHash: contentHash(record as unknown as Record<string, unknown>),
    signer: BUYER,
  };
  return Object.freeze({
    record,
    recordRef,
    anchorReceipt: {
      receiptVersion: "1",
      substrate: "demos",
      finalityProfile: "demos-bft-confirmed-native-read",
      logicalAddress,
      nativeAddress: `stor-${"6".repeat(40)}`,
      contentHash: recordRef.contentHash,
      transactionRef: { kind: "demos-storage-program", value: "tx:seller-vet" },
      writer: BUYER,
      state: "finalized",
      observationDisposition: "established",
      observedAt: NOW,
      blockRef: { id: "block:seller-vet", height: "42" },
      evidence: { kind: "demos-bft-write-proof-v1", value: "proof" },
    },
  });
}

function listing(): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 4,
    listingId: "agreement-http-runtime",
    seller: {
      identity: identity(SELLER),
      displayName: "Runtime seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Runtime result",
      description: "Authenticated agreement transport result",
      category: "data.test",
      tags: ["test"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: RAIL.railId } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [RAIL],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 10_000, notAfter: NOW + 1_000_000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.alloc(64, 3).toString("base64url"),
    },
  };
}

function order(role: "buyer" | "seller"): FixedPriceX402OrderInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: {
      commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      phase: "pay-x402",
      orchestratorTopology: "seller-as-phase-orchestrator-v1",
      orchestrator: SELLER,
      rail: {
        registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
        registryIndexHash: "1".repeat(64),
        railDefinitionRef: "dacs4:rail:x402%3Aruntime:2",
        railDefinitionHash: "2".repeat(64),
        railId: "x402:runtime",
        railVersion: 2,
        railType: "x402",
        phaseHandler: "pay-x402",
        network: "eip155:8453",
        availability: "live",
      },
    },
    sdkJobs: role === "buyer"
      ? {
          role,
          agreement: `buyer:agreement:${JOB_ID}`,
          payment: `buyer:payment:${JOB_ID}`,
          paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
          buyerReceived: `buyer:received:${JOB_ID}`,
          audit: `buyer:audit:${JOB_ID}`,
        }
      : {
          role,
          agreement: `seller:agreement:${JOB_ID}`,
          payment: `seller:payment:${JOB_ID}`,
          paymentEvidence: `seller:payment-evidence:${JOB_ID}`,
          fulfilment: `seller:fulfilment:${JOB_ID}`,
          deliveryEvidence: `seller:delivery-evidence:${JOB_ID}`,
          audit: `seller:audit:${JOB_ID}`,
        },
  };
}

async function proposal(): Promise<Readonly<{
  proposal: Readonly<FixedPriceAgreementProposal>;
  transportIdentity: Readonly<FixedPriceAgreementTransportIdentity>;
  plan: ReturnType<typeof createFixedPriceAgreementSigningPlan>;
}>> {
  const exactListing = listing();
  const draft = deriveFixedPriceAgreement({
    jobId: JOB_ID,
    verifiedListing: {
      disposition: "verified",
      listing: exactListing,
      pin: {
        listingId: exactListing.listingId,
        version: exactListing.listingVersion,
        contentHash: contentHash(exactListing as unknown as Record<string, unknown>),
      },
    },
    buyer: { identityBundle: identity(BUYER), vetRecordRef: vet("buyer") },
    seller: { identityBundle: identity(SELLER), vetRecordRef: vet("seller") },
    selectedRail: RAIL,
    generatedAt: NOW,
  });
  const plan = createFixedPriceAgreementSigningPlan(draft);
  const buyerContribution = await createFixedPriceAgreementSignatureContribution(
    plan,
    "buyer",
    {
      party: BUYER,
      algorithm: "ed25519",
      sign: () => Uint8Array.from(Buffer.alloc(64, 4)),
    },
  );
  const material = { proposalVersion: "1" as const, plan, buyerContribution };
  const value: FixedPriceAgreementProposal = {
    ...material,
    proposalHash: sha256Hex(canonicalize(material)),
  };
  return {
    proposal: value,
    transportIdentity: {
      jobId: JOB_ID,
      planHash: plan.planHash,
      agreementHash: plan.agreementHash,
      buyer: BUYER,
      seller: SELLER,
      proposalHash: value.proposalHash,
    },
    plan,
  };
}

function authenticated(
  type: "agreement-proposal" | "agreement-response",
  payload: unknown,
  sender: string,
  audience: string,
): Readonly<DacsHttpAuthenticatedEnvelopeV1> {
  return {
    envelope: {
      version: "1",
      type,
      envelopeId: "9".repeat(64),
      jobId: JOB_ID,
      sender,
      audience,
      keyId: sender,
      algorithm: "ed25519",
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
      nonce: Buffer.alloc(32, 8).toString("base64url"),
      payloadHash: sha256Hex(canonicalize(payload)),
      payload,
      signature: Buffer.alloc(64, 7).toString("base64url"),
    },
    status: "authenticated",
    authenticationHash: "8".repeat(64),
    identityEvidenceHash: "7".repeat(64),
    identityRole: sender === BUYER ? "buyer" : "seller",
    receivedAt: NOW,
  } as unknown as Readonly<DacsHttpAuthenticatedEnvelopeV1>;
}

describe("live agreement HTTP transport runtime", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0).reverse()) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function open(role: "buyer" | "seller"): Promise<DacsNodeSqliteDatabase> {
    const root = mkdtempSync(join(tmpdir(), `dacs-agreement-http-${role}-`));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "actor.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority: role === "buyer" ? BUYER : SELLER,
    });
    databases.push(database);
    return database;
  }

  it("exchanges one exact proposal and response across separate durable stores", async () => {
    const buyerDatabase = await open("buyer");
    const sellerDatabase = await open("seller");
    const buyerOrder = order("buyer");
    const sellerOrder = order("seller");
    await buyerDatabase.createLiveCoordinatorStore("buyer").create({
      role: "buyer",
      order: buyerOrder,
      bindingHash: fixedPriceX402OrderBindingHash(buyerOrder),
      localBindingHash: fixedPriceX402OrderLocalBindingHash(buyerOrder),
    });
    putDacsLiveOrderInputV1({
      database: buyerDatabase,
      order: buyerOrder,
      application: { request: "weather" },
    });

    let buyerRuntime: ReturnType<typeof createDacsBuyerAgreementTransportRuntimeV1>;
    let sellerRuntime: ReturnType<typeof createDacsSellerAgreementTransportRuntimeV1>;
    const sellerCoordinator = {
      startOrder: vi.fn(async (input: Readonly<FixedPriceX402OrderInput>) => {
        const result = await sellerDatabase.createLiveCoordinatorStore("seller").create({
          role: "seller",
          order: input,
          bindingHash: fixedPriceX402OrderBindingHash(input),
          localBindingHash: fixedPriceX402OrderLocalBindingHash(input),
        });
        if (result.status !== "created" && result.status !== "existing") throw new Error();
        return result.record;
      }),
    };
    const buyerContext = {
      role: "buyer",
      authority: BUYER,
      peerAuthority: SELLER,
      database: buyerDatabase,
      sendMessage: async (message: { type: "agreement-proposal"; payload: unknown }) => {
        const handled = await sellerRuntime.handleMessage(
          authenticated(message.type, message.payload, BUYER, SELLER),
          { role: "seller", coordinator: sellerCoordinator } as unknown as
            DacsLiveRoleInboundOperationContextV1,
        );
        return {
          envelope: { type: "acknowledgement", payload: { disposition: handled.disposition } },
        } as unknown as DacsHttpAuthenticatedEnvelopeV1;
      },
    } as unknown as DacsLiveRoleOperationContextV1;
    const sellerContext = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database: sellerDatabase,
      sendMessage: async (message: { type: "agreement-response"; payload: unknown }) => {
        const handled = await buyerRuntime.handleMessage(
          authenticated(message.type, message.payload, SELLER, BUYER),
          { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
        );
        return {
          envelope: { type: "acknowledgement", payload: { disposition: handled.disposition } },
        } as unknown as DacsHttpAuthenticatedEnvelopeV1;
      },
    } as unknown as DacsLiveRoleOperationContextV1;
    const sellerVet = sellerVetProduction();
    buyerRuntime = createDacsBuyerAgreementTransportRuntimeV1({
      context: buyerContext,
      resolveSellerVetProduction: () => sellerVet,
    });
    sellerRuntime = createDacsSellerAgreementTransportRuntimeV1({
      context: sellerContext,
      admitProposal: () => ({ order: sellerOrder, application: { product: "weather" } }),
    });

    const request = await proposal();
    await expect(buyerRuntime.transport.reconcileProposalPublication(
      request.transportIdentity,
      { owner: "buyer", generation: 1, idempotencyKey: "proposal" },
    )).resolves.toMatchObject({ disposition: "absent" });
    await expect(buyerRuntime.transport.publishProposal(
      request.proposal,
      request.transportIdentity,
      { owner: "buyer", generation: 1, idempotencyKey: "proposal" },
    )).resolves.toEqual({ disposition: "submitted" });
    expect(sellerCoordinator.startOrder).toHaveBeenCalledOnce();

    const resolved = await sellerRuntime.resolveProposal({
      operation: {
        order: (await sellerDatabase.createLiveCoordinatorStore("seller")
          .load("seller", JOB_ID) as { status: "ok"; record: never }).record,
        fence: { role: "seller", track: "agreement" },
      } as never,
    });
    expect(canonicalize(resolved)).toBe(canonicalize({
      proposal: request.proposal,
      transportIdentity: request.transportIdentity,
    }));
    await expect(sellerRuntime.resolveSellerVetProduction({
      operation: {
        order: (await sellerDatabase.createLiveCoordinatorStore("seller")
          .load("seller", JOB_ID) as { status: "ok"; record: never }).record,
        fence: { role: "seller", track: "agreement" },
      } as never,
    })).resolves.toEqual(sellerVet);

    const sellerContribution = await createFixedPriceAgreementSignatureContribution(
      request.plan,
      "seller",
      {
        party: SELLER,
        algorithm: "ed25519",
        sign: () => Uint8Array.from(Buffer.alloc(64, 5)),
      },
    );
    await expect(sellerRuntime.transport.publishSellerContribution(
      sellerContribution,
      request.transportIdentity,
      { owner: "seller", generation: 1, idempotencyKey: "response" },
    )).resolves.toEqual({ disposition: "submitted" });
    await expect(sellerRuntime.transport.reconcileSellerContributionPublication(
      request.transportIdentity,
      { owner: "seller", generation: 2, idempotencyKey: "response" },
    )).resolves.toEqual({ disposition: "present", value: sellerContribution });
    await expect(buyerRuntime.transport.resolveSellerContributions(
      request.transportIdentity,
    )).resolves.toEqual({ disposition: "present", value: [sellerContribution] });

    await expect(buyerRuntime.transport.reconcileProposalPublication(
      request.transportIdentity,
      { owner: "buyer", generation: 2, idempotencyKey: "proposal" },
    )).resolves.toEqual({ disposition: "present", value: request.proposal });
    expect(sellerCoordinator.startOrder).toHaveBeenCalledTimes(2);
  });

  it("rejects a proposal whose authenticated sender is rebound", async () => {
    const sellerDatabase = await open("seller");
    const context = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database: sellerDatabase,
      sendMessage: vi.fn(),
    } as unknown as DacsLiveRoleOperationContextV1;
    const runtime = createDacsSellerAgreementTransportRuntimeV1({
      context,
      admitProposal: vi.fn(() => ({ order: order("seller"), application: {} })),
    });
    const request = await proposal();
    expect(await runtime.validatePayload({
      type: "agreement-proposal",
      payload: request,
      jobId: JOB_ID,
      sender: SELLER,
      audience: SELLER,
    })).toMatchObject({ status: "invalid" });
  });
});
