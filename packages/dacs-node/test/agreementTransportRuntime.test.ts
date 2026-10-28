import { trustedSessionProfile } from "./helpers/sessionProfile.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isFinalizedVetAnchorReceipt, createInMemoryFencedSessionStore, createTerminalBundlePlan, prepareVetTerminalBundle, compositeVerificationAddress, type ProtocolAnchorReceipt } from
  "@kynesyslabs/dacs";
import type {
  AttestationRef,
  CompositeVerificationRecord,
  IdentityBundle,
  Listing,
  PaymentRailRef,
} from
  "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, listingAddress, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  fixedPricePayDemOrderBindingHash,
  fixedPricePayDemOrderLocalBindingHash,
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
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { produceDacsEmptyRequirementSessionVetV1 } from "../src/sessionIdentityVetRuntime.js";
import { retainDacsFixedPricePurchaseDemosBudgetGrantV1 } from "../src/purchaseDemosBudget.js";
import { createDacsVetTerminalBundleTransportRuntimeV1 } from "../src/terminalBundleTransportRuntime.js";
import { claimDacsPreAgreementPhaseV1, claimDacsSellerVetOutcomeV1, loadDacsPreAgreementPhaseV1, loadDacsSellerVetOutcomeV1 } from "../src/preAgreementPhase.js";
import { advanceDacsVetTerminalTrackV1, createDacsBuyerSessionBootstrapAgreementTrackV1, createDacsSellerSessionBootstrapAgreementTrackV1 } from "../src/sessionBootstrapAgreementRuntime.js";
import { loadDacsAgreementTerminalBoundaryForOrderV1 } from "../src/agreementTransportRuntime.js";
import { identityBundleHash } from "@kynesyslabs/dacs/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

// Explicitly non-live harness: the live paths here run against a released
// profile record; the real record at the pin refuses every admission.
vi.mock("../../../src/discovery/standardProfileRelease.js", () => ({ DACS_STANDARD_PROFILE_STATUS: "released" }));

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
const BUYER_SEED = new Uint8Array(32).fill(91);
const SELLER_SEED = new Uint8Array(32).fill(92);
const claim = (seed: Uint8Array) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);

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
    anchor: { kind: "storage-program", locator: `stor-${"6".repeat(40)}` },
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

async function proposal(exactListing = listing(), sellerRef = vet("seller")): Promise<Readonly<{
  proposal: Readonly<FixedPriceAgreementProposal>;
  transportIdentity: Readonly<FixedPriceAgreementTransportIdentity>;
  plan: ReturnType<typeof createFixedPriceAgreementSigningPlan>;
}>> {
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
    seller: { identityBundle: identity(SELLER), vetRecordRef: sellerRef },
    selectedRail: exactListing.acceptedRails![0]!,
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

// The same coordinator records and immutable session effects, held in memory.
async function memoryAgreementHarness(profile: "x402" | "pay-dem") {
    const exactListing = listing();
    exactListing.pipeline.unshift({ kind: "vet-credentials" });
    if (profile === "pay-dem") {
        exactListing.acceptedRails = [{ railId: "demos-native:DEM", railVersion: 1, parameters: { network: "demos" } }];
        exactListing.pipeline[3] = { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } };
        exactListing.pricing = { kind: "fixed", price: { amount: "1", currency: "DEM" } };
    }
    const actors = (["buyer", "seller"] as const).map((role) => {
        const exactOrder = order(role);
        if (profile === "pay-dem")
            Object.assign(exactOrder.protocol, {
                commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE, standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION, phase: "pay-dem",
                rail: { registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF, registryIndexHash: "1".repeat(64), railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1", railDefinitionHash: "2".repeat(64), railId: "demos-native:DEM", railVersion: 1, railType: "demos-native", phaseHandler: "pay-dem", network: "demos", availability: "live" },
            });
        const record = { ...exactOrder, role,
            bindingHash: profile === "x402" ? fixedPriceX402OrderBindingHash(exactOrder) : fixedPricePayDemOrderBindingHash(exactOrder as never),
            localBindingHash: profile === "x402" ? fixedPriceX402OrderLocalBindingHash(exactOrder) : fixedPricePayDemOrderLocalBindingHash(exactOrder as never), tracks: {},
        };
        const effects = new Map<string, unknown>();
        const database = {
            metadata: { mode: "live-demos", role, authority: role === "buyer" ? BUYER : SELLER }, readTime: () => NOW,
            loadEffectInput: (kind: string, id: string) => structuredClone(effects.get(`${kind}:${id}`)),
            putEffectIntent: (input: {
                kind: string;
                effectId: string;
                input: unknown;
            }) => {
                const key = `${input.kind}:${input.effectId}`;
                const old = effects.get(key);
                if (old !== undefined)
                    return { status: canonicalize(old) === canonicalize(input.input) ? "existing" : "conflict" };
                effects.set(key, structuredClone(input.input));
                return { status: "created" };
            },
            createLiveCoordinatorStore: () => ({ load: async () => profile === "x402" ? { status: "ok", record } : { status: "missing" } }),
            createPayDemCoordinatorStore: () => ({ load: async () => profile === "pay-dem" ? { status: "ok", record } : { status: "missing" } }),
        };
        const anchors = new Map<string, Record<string, unknown>>();
        const receipts = new Map<string, ProtocolAnchorReceipt>();
        const context = {
            authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
            role, authority: role === "buyer" ? BUYER : SELLER, peerAuthority: role === "buyer" ? SELLER : BUYER, database, config: { role }, sessionStore: createInMemoryFencedSessionStore(),
            demos: {
                signComponent: vi.fn(async (bytes: Uint8Array) => ed25519Sign(bytes, privateKeyFromSeed(role === "buyer" ? BUYER_SEED : SELLER_SEED))),
                adapter: {
                    anchorWriteOnce: vi.fn(async (logicalAddress: string, value: Record<string, unknown>) => {
                        const nativeAddress = `stor-${sha256Hex(logicalAddress)}`;
                        anchors.set(nativeAddress, structuredClone(value));
                        receipts.set(nativeAddress, { ...sellerVetProduction().anchorReceipt, logicalAddress, nativeAddress, writer: role === "buyer" ? BUYER : SELLER, contentHash: contentHash(value) });
                        return { address: nativeAddress };
                    }),
                    resolveDemosAnchorReceipt: vi.fn(async (input: {
                        nativeAddress: string;
                    }) => receipts.get(input.nativeAddress) ?? null),
                    verifyDemosAnchorReceipt: vi.fn(async () => true), readAnchor: vi.fn(async (address: string) => structuredClone(anchors.get(address) ?? null)),
                },
            },
            sendMessage: vi.fn(async () => ({ envelope: { type: "acknowledgement", payload: { disposition: "accepted" } } })),
        } as unknown as DacsLiveRoleOperationContextV1;
        const application = { applicationVersion: "1", listing: exactListing, listingContentHash: contentHash(exactListing as unknown as Record<string, unknown>), listingRef: `stor-${"5".repeat(40)}`, listingLogicalAddress: listingAddress(SELLER, exactListing.listingId, exactListing.listingVersion), demosWriteFeeCeilings: { buyer: "0.001", seller: "0.001" }, request: {}, requestHash: sha256Hex(canonicalize({})) };
        expect(putDacsLiveOrderInputV1({ database: database as never, order: exactOrder, application }).status).toBe("created");
        retainDacsFixedPricePurchaseDemosBudgetGrantV1({ database: database as never, jobId: JOB_ID, role, authority: context.authority, maximumPerWriteFeeDem: "0.001" });
        const operation = { order: record, fence: { role, track: "agreement", jobId: JOB_ID, bindingHash: record.bindingHash, localBindingHash: record.localBindingHash, assertCurrent: vi.fn(async () => undefined) } };
        return { context, record, operation, exactOrder, application, effects };
    });
    const buyer = actors[0]!;
    const seller = actors[1]!;
    const produced = await produceDacsEmptyRequirementSessionVetV1({ context: buyer.context, operation: buyer.operation as never, evaluatedIdentity: identity(SELLER), requirement: { requirementVersion: "1", required: [] } });
    expect(produced.status).toBe("ready");
    if (produced.status !== "ready")
        throw new Error(produced.reasonCode);
    const production = produced.production;
    const finalizedReceipt = production.anchorReceipt;
    if (!isFinalizedVetAnchorReceipt(finalizedReceipt))
        throw new Error("finalized Vet receipt missing");
    const request = await proposal(exactListing, production.recordRef);
    const sellerRuntime = createDacsSellerAgreementTransportRuntimeV1({ context: seller.context, admitProposal: () => ({ order: seller.exactOrder, application: seller.application }) });
    const startOrder = vi.fn(async () => seller.record);
    const inbound = { role: "seller", coordinator: { startOrder } } as unknown as DacsLiveRoleInboundOperationContextV1;
    const buyerRuntime = createDacsBuyerAgreementTransportRuntimeV1({ context: buyer.context, resolveSellerVetProduction: () => production });
    vi.mocked(buyer.context.sendMessage).mockImplementation(async (message) => {
        const accepted = await sellerRuntime.handleMessage(authenticated("agreement-proposal", message.payload, BUYER, SELLER), inbound);
        return { envelope: { type: "acknowledgement", payload: { disposition: accepted.disposition } } } as never;
    });
    const publish = () => buyerRuntime.transport.publishProposal(request.proposal, request.transportIdentity, { owner: "buyer", generation: 1, idempotencyKey: "memory-proposal" });
    const signResponse = async () => {
        const contribution = await createFixedPriceAgreementSignatureContribution(request.plan, "seller", { party: SELLER, algorithm: "ed25519", sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)) });
        // Crash after durable response retention, before coordinator success.
        vi.mocked(seller.context.sendMessage).mockRejectedValueOnce(new Error("crash after response retention"));
        await sellerRuntime.transport.publishSellerContribution(contribution, request.transportIdentity, { owner: "seller", generation: 1, idempotencyKey: "memory-response" });
        expect(seller.record.tracks).toEqual({});
        expect(loadDacsAgreementTerminalBoundaryForOrderV1(seller.context, seller.record as never).sellerResponseRetained).toBe(true);
    };
    const terminalProduction = (evaluatedRole: "buyer" | "seller", decision: "pass" | "fail") => {
        const verifier = evaluatedRole === "seller" ? BUYER : SELLER;
        const record = { ...production.record, overallDecision: decision,
            evaluatedParty: evaluatedRole === "seller" ? SELLER : BUYER,
            bundleHash: identityBundleHash(identity(evaluatedRole === "seller" ? SELLER : BUYER)),
            signature: { ...production.record.signature, signer: verifier } };
        const recordHash = contentHash(record as unknown as Record<string, unknown>);
        const nativeAddress = evaluatedRole === "seller" ? finalizedReceipt.nativeAddress : `stor-${"9".repeat(40)}`;
        return { record, recordRef: { ...production.recordRef, contentHash: recordHash, signer: verifier,
            anchor: { kind: "storage-program" as const, locator: nativeAddress } },
            anchorReceipt: { ...finalizedReceipt, nativeAddress, contentHash: recordHash,
                logicalAddress: compositeVerificationAddress(JOB_ID, record.evaluatedParty), writer: verifier,
                state: "finalized" as const, observationDisposition: "established" as const } };
    };
    const terminalPassInput = (role: "buyer" | "seller") => ({
        jobId: JOB_ID, listingRef: { listingId: exactListing.listingId, version: exactListing.listingVersion, contentHash: seller.application.listingContentHash }, pipeline: exactListing.pipeline,
        vetPhaseIndex: 0, startedAt: NOW - 2000, vetInvokedAt: NOW - 1000, recipeRegistryVersion: 1, railRegistryVersion: 1,
        parties: [{ role: "buyer" as const, identityBundle: identity(BUYER) }, { role: "seller" as const, identityBundle: identity(SELLER) }],
        evaluatedRole: role === "buyer" ? "seller" as const : "buyer" as const,
        production: terminalProduction(role === "buyer" ? "seller" : "buyer", "pass"),
    });
    const terminalRuntime = () => createDacsVetTerminalBundleTransportRuntimeV1({ context: seller.context, expectedRegistryVersions: { recipeRegistryVersion: 1, railRegistryVersion: 1 }, authenticateProduction: async () => ({ status: "valid" }) });
    const failure = async (evaluatedRole: "buyer" | "seller" = "seller") => {
        const input = { ...terminalPassInput(evaluatedRole === "buyer" ? "seller" : "buyer"),
            production: terminalProduction(evaluatedRole, "fail"),
            complementaryProduction: terminalProduction(evaluatedRole === "buyer" ? "seller" : "buyer", "pass"),
        };
        const prepared = await prepareVetTerminalBundle(input, { authenticateProduction: async () => ({ status: "valid" }) });
        if (prepared.status !== "terminal")
            throw new Error("terminal fixture invalid");
        const payload = { proposalVersion: "1", terminalInput: input, plan: createTerminalBundlePlan(prepared.authority, { kind: "co-signed" }) };
        const auth = authenticated("agreement-proposal", payload, BUYER, SELLER);
        return { ...auth, envelope: { ...auth.envelope, type: "terminal-bundle-proposal-buyer" } } as unknown as DacsHttpAuthenticatedEnvelopeV1;
    };
    // The role's own Vet of its peer passed: a terminal runtime accepts and
    // signs the peer's Vet-failure plan only once this is recorded.
    const ownVetPassed = (role: "buyer" | "seller") => {
        const actor = role === "buyer" ? buyer : seller;
        return createDacsVetTerminalBundleTransportRuntimeV1({ context: actor.context, expectedRegistryVersions: { recipeRegistryVersion: 1, railRegistryVersion: 1 }, authenticateProduction: async () => ({ status: "valid" }) })
            .registerLocalVetPass!({ jobId: JOB_ID, localBindingHash: actor.record.localBindingHash }, terminalPassInput(role));
    };
    return { buyer, seller, request, production, publish, signResponse, terminalRuntime, failure, inbound, sellerRuntime, startOrder, ownVetPassed, terminalPassInput };
}
describe("memory-backed agreement and Vet terminal recovery", () => {
    it.each(["x402", "pay-dem"] as const)("publishes %s proposals using the real session Vet output", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        expect(h.production.recordRef.anchor.locator).toBe(h.production.anchorReceipt.nativeAddress);
        expect(h.production.anchorReceipt.logicalAddress).toBe(compositeVerificationAddress(JOB_ID, SELLER));
        await expect(h.publish()).resolves.toEqual({ disposition: "submitted" });
        expect(loadDacsAgreementTerminalBoundaryForOrderV1(h.seller.context, h.seller.record as never)).toEqual({ sellerPassRetained: true, sellerResponseRetained: false });
    });
    it.each(["x402", "pay-dem"] as const)("rejects a %s native seller Vet ref whose receipt names another logical address", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        const payload = (sellerVetReceipt: ProtocolAnchorReceipt) => ({
            proposal: h.request.proposal, transportIdentity: h.request.transportIdentity,
            sellerVetRecord: h.production.record, sellerVetRef: h.production.recordRef, sellerVetReceipt,
        });
        const validate = (sellerVetReceipt: ProtocolAnchorReceipt) => h.sellerRuntime.validatePayload({ type: "agreement-proposal", payload: payload(sellerVetReceipt), jobId: JOB_ID, sender: BUYER, audience: SELLER });
        expect(await validate(h.production.anchorReceipt)).toEqual({ status: "valid" });
        // Same native address, hash and writer; only the logical binding differs.
        const rebound = { ...h.production.anchorReceipt, logicalAddress: compositeVerificationAddress(JOB_ID, BUYER) };
        expect(await validate(rebound)).toEqual({ status: "invalid", reasonCode: "agreement-proposal-invalid" });
        expect(await h.sellerRuntime.handleMessage(authenticated("agreement-proposal", payload(rebound), BUYER, SELLER), h.inbound))
            .toEqual({ disposition: "rejected", reasonCode: "agreement-proposal-invalid" });
        expect(loadDacsAgreementTerminalBoundaryForOrderV1(h.seller.context, h.seller.record as never).sellerPassRetained).toBe(false);
    });
    it.each(["x402", "pay-dem"] as const)("accepts a genuine %s seller failure before any proposal or response", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        await h.ownVetPassed("seller");
        await expect(h.terminalRuntime().handleMessage(await h.failure(), h.inbound)).resolves.toEqual({ disposition: "accepted" });
    });
    it.each(["x402", "pay-dem"] as const)("rejects %s seller failure after an authenticated seller-pass proposal", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        await expect(h.publish()).resolves.toEqual({ disposition: "submitted" });
        await expect(h.terminalRuntime().handleMessage(await h.failure(), h.inbound)).resolves.toMatchObject({ disposition: "rejected", reasonCode: "vet-terminal-not-pre-agreement" });
        expect(h.seller.context.demos.signComponent).not.toHaveBeenCalled();
    });
    it.each(["x402", "pay-dem"] as const)("refuses a %s agreement once the seller retained a terminal first", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        await h.ownVetPassed("seller");
        await expect(h.terminalRuntime().handleMessage(await h.failure(), h.inbound)).resolves.toEqual({ disposition: "accepted" });
        // The terminal committed the job first, so the seller-pass proposal and any response lose.
        await expect(h.publish()).resolves.toEqual({ disposition: "rejected", reason: "peer-rejected-proposal" });
        const contribution = await createFixedPriceAgreementSignatureContribution(h.request.plan, "seller", { party: SELLER, algorithm: "ed25519", sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)) });
        await expect(h.sellerRuntime.transport.publishSellerContribution(contribution, h.request.transportIdentity, { owner: "seller", generation: 1, idempotencyKey: "memory-response" }))
            .resolves.toEqual({ disposition: "rejected", reason: "agreement-proposal-binding-missing" });
        expect(loadDacsAgreementTerminalBoundaryForOrderV1(h.seller.context, h.seller.record as never)).toEqual({ sellerPassRetained: false, sellerResponseRetained: false });
        expect(vi.mocked(h.seller.context.sendMessage).mock.calls.map(([message]) => message.type)).not.toContain("agreement-response");
    });
    it.each(["x402", "pay-dem"] as const)("recovers the retained %s agreement response before terminal processing", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        await expect(h.publish()).resolves.toEqual({ disposition: "submitted" });
        await h.signResponse();
        const calls: string[] = [];
        const agreement = vi.fn(async () => { calls.push("agreement"); return { status: "final", outcome: "success", reference: "stor:agreement" }; });
        const advanceRegisteredTerminal = vi.fn(async () => { calls.push("terminal"); throw new Error("contradictory terminal"); });
        const track = createDacsSellerSessionBootstrapAgreementTrackV1({ context: h.seller.context, sessionBootstrap: { resolveInit: vi.fn() }, resolveBuyerRequirement: async () => ({ requirementVersion: "1", required: [] }), agreementProposalReady: async () => true, agreement, terminalBundle: { runtime: { advanceRegisteredTerminal }, createInput: vi.fn() } } as never);
        await expect(track(h.seller.operation as never)).resolves.toMatchObject({ status: "final", outcome: "success" });
        expect(calls).toEqual(["agreement"]);
        expect(advanceRegisteredTerminal).not.toHaveBeenCalled();
    });
});

type MemoryHarness = Awaited<ReturnType<typeof memoryAgreementHarness>>;

// A full seller bootstrap tick in which everything before the agreement hand-off
// is answered (the seller's Vet of the buyer passes), so only the terminal and
// phase checks decide whether the seller reaches the agreement step.
function bootstrapTranscript(h: MemoryHarness) {
    const buyerPass = h.terminalPassInput("seller").production;
    const init = { bootstrapVersion: "1", order: h.seller.exactOrder, application: h.seller.application, sellerChallenge: "1".repeat(64) };
    const challenge = { bootstrapVersion: "1", initPayloadHash: "2".repeat(64), sellerChallenge: init.sellerChallenge, buyerChallenge: "3".repeat(64), sellerIdentity: identity(SELLER) };
    const presentation = { bootstrapVersion: "1", challengePayloadHash: "4".repeat(64), buyerChallenge: challenge.buyerChallenge, buyerIdentity: identity(BUYER) };
    return { buyerPass, init, challenge, presentation };
}

function sellerBootstrapTrack(
    h: MemoryHarness,
    agreement: ReturnType<typeof vi.fn>,
    agreementProposalReady = async ({ operation }: { operation: never }) => {
        try {
            await h.sellerRuntime.resolveProposal({ operation });
            return true;
        } catch {
            return false;
        }
    },
) {
    const { buyerPass, init, challenge, presentation } = bootstrapTranscript(h);
    return createDacsSellerSessionBootstrapAgreementTrackV1({
        context: h.seller.context,
        sessionBootstrap: { resolveInit: () => init, resolveChallenge: () => challenge, resolvePresentation: () => presentation, resolveAdmission: () => undefined, publishAdmission: async () => "submitted", publishChallenge: async () => "submitted" },
        resolveBuyerRequirement: async () => ({ requirementVersion: "1", required: [] }),
        agreementProposalReady,
        agreement,
        vet: { produce: async () => ({ status: "ready", production: buyerPass }), authenticate: async () => "valid" },
        terminalBundle: { runtime: h.terminalRuntime(), createInput: () => h.terminalPassInput("seller") },
    } as never);
}

// The buyer's counterpart: both Vets pass, so only the phase check decides
// whether the buyer reaches its agreement step.
function buyerBootstrapTrack(h: MemoryHarness, agreement: ReturnType<typeof vi.fn>) {
    const { buyerPass, init, challenge, presentation } = bootstrapTranscript(h);
    const admission = {
        bootstrapVersion: "1", presentationPayloadHash: "5".repeat(64),
        buyerIdentityHash: identityBundleHash(identity(BUYER)), sellerIdentityHash: identityBundleHash(identity(SELLER)),
        buyerVetRecord: buyerPass.record, buyerVetRef: buyerPass.recordRef, buyerVetReceipt: buyerPass.anchorReceipt,
    };
    return createDacsBuyerSessionBootstrapAgreementTrackV1({
        context: h.buyer.context,
        sessionBootstrap: { resolveInit: () => init, resolveChallenge: () => challenge, resolvePresentation: () => presentation, resolveAdmission: () => admission, publishInit: async () => "submitted", publishPresentation: async () => "submitted" },
        resolveRequirements: async () => ({ buyer: { requirementVersion: "1", required: [] }, seller: { requirementVersion: "1", required: [] } }),
        agreement,
        vet: { produce: async () => ({ status: "ready", production: h.production }), authenticate: async () => "valid" },
    } as never);
}

function sentTypes(h: MemoryHarness): string[] {
    return vi.mocked(h.seller.context.sendMessage).mock.calls.map(([message]) => message.type);
}

describe("agreement and Vet terminal are mutually exclusive for each role", () => {
    it.each(["x402", "pay-dem"] as const)("keeps a %s seller that contributed to a Vet failure from signing a later agreement", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        const runtime = h.terminalRuntime();
        await h.ownVetPassed("seller");
        await expect(runtime.handleMessage(await h.failure(), h.inbound)).resolves.toEqual({ disposition: "accepted" });
        await expect(runtime.advanceRegisteredTerminal(JOB_ID)).resolves.toMatchObject({ disposition: "waiting" });
        expect(h.seller.context.demos.signComponent).toHaveBeenCalled();
        expect(sentTypes(h)).toContain("terminal-bundle-contribution-seller");

        // The buyer then sends a seller-pass agreement proposal.
        expect.soft(await h.publish()).toEqual({ disposition: "rejected", reason: "peer-rejected-proposal" });
        const proposalPayload = vi.mocked(h.buyer.context.sendMessage).mock.calls[0]![0].payload;
        expect.soft(await h.sellerRuntime.handleMessage(authenticated("agreement-proposal", proposalPayload, BUYER, SELLER), h.inbound))
            .toEqual({ disposition: "rejected", reasonCode: "agreement-vet-terminal-phase-conflict" });
        expect.soft(loadDacsAgreementTerminalBoundaryForOrderV1(h.seller.context, h.seller.record as never)).toEqual({ sellerPassRetained: false, sellerResponseRetained: false });
        // The terminal keeps the job; it never hands it back to the agreement.
        expect.soft(await advanceDacsVetTerminalTrackV1(runtime, h.seller.context, 1_000, JOB_ID)).toMatchObject({ status: "pending-retry", reasonCode: "vet-terminal-finalization-pending" });
        const agreement = vi.fn(async () => ({ status: "final", outcome: "success", reference: "stor:agreement" }));
        expect.soft(await sellerBootstrapTrack(h, agreement)(h.seller.operation as never)).toMatchObject({ status: "pending-retry", reasonCode: "vet-terminal-finalization-pending" });
        expect(agreement).not.toHaveBeenCalled();
        const contribution = await createFixedPriceAgreementSignatureContribution(h.request.plan, "seller", { party: SELLER, algorithm: "ed25519", sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)) });
        expect.soft(await h.sellerRuntime.transport.publishSellerContribution(contribution, h.request.transportIdentity, { owner: "seller", generation: 1, idempotencyKey: "memory-response" }))
            .toEqual({ disposition: "rejected", reason: "agreement-proposal-binding-missing" });
        expect(loadDacsAgreementTerminalBoundaryForOrderV1(h.seller.context, h.seller.record as never).sellerResponseRetained).toBe(false);
        expect(sentTypes(h)).not.toContain("agreement-response");
    });

    it.each(["x402", "pay-dem"] as const)("reports a %s gate failure after the seller's terminal contribution as an operator conflict", async (profile) => {
        // Retain the authenticated seller-pass proposal the way an admitted one is stored.
        const donor = await memoryAgreementHarness(profile);
        await expect(donor.publish()).resolves.toEqual({ disposition: "submitted" });
        const proposalEntry = [...donor.seller.effects].find(([, value]) =>
            typeof value === "object" && value !== null && "payload" in value &&
            typeof (value as { payload: unknown }).payload === "object" &&
            "proposal" in ((value as { payload: object }).payload));
        expect(proposalEntry).toBeDefined();

        const h = await memoryAgreementHarness(profile);
        const runtime = h.terminalRuntime();
        await h.ownVetPassed("seller");
        await expect(runtime.handleMessage(await h.failure(), h.inbound)).resolves.toEqual({ disposition: "accepted" });
        await expect(runtime.advanceRegisteredTerminal(JOB_ID)).resolves.toMatchObject({ disposition: "waiting" });
        h.seller.effects.set(proposalEntry![0], structuredClone(proposalEntry![1]));
        expect(loadDacsAgreementTerminalBoundaryForOrderV1(h.seller.context, h.seller.record as never).sellerPassRetained).toBe(true);

        await expect.soft(runtime.advanceRegisteredTerminal(JOB_ID)).rejects.toMatchObject({ reasonCode: "agreement-vet-terminal-phase-conflict" });
        expect.soft(await advanceDacsVetTerminalTrackV1(runtime, h.seller.context, 1_000, JOB_ID)).toEqual({ status: "operator-action", reasonCode: "agreement-vet-terminal-phase-conflict" });
        const agreement = vi.fn(async () => ({ status: "final", outcome: "success", reference: "stor:agreement" }));
        expect.soft(await sellerBootstrapTrack(h, agreement)(h.seller.operation as never)).toEqual({ status: "operator-action", reasonCode: "agreement-vet-terminal-phase-conflict" });
        expect(agreement).not.toHaveBeenCalled();
        await expect(h.sellerRuntime.resolveProposal({ operation: h.seller.operation as never })).rejects.toMatchObject({ reasonCode: "agreement-vet-terminal-phase-conflict" });
        const contribution = await createFixedPriceAgreementSignatureContribution(h.request.plan, "seller", { party: SELLER, algorithm: "ed25519", sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)) });
        expect(await h.sellerRuntime.transport.publishSellerContribution(contribution, h.request.transportIdentity, { owner: "seller", generation: 1, idempotencyKey: "memory-response" }))
            .toEqual({ disposition: "rejected", reason: "agreement-vet-terminal-phase-conflict" });
        expect(loadDacsAgreementTerminalBoundaryForOrderV1(h.seller.context, h.seller.record as never).sellerResponseRetained).toBe(false);
        expect(sentTypes(h)).not.toContain("agreement-response");
    });

    it.each(["x402", "pay-dem"] as const)("does not co-sign a %s seller failure after proposal admission fails once the order commits", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        // startOrder() commits the order and then throws, as on a crash before it returns.
        h.startOrder.mockRejectedValueOnce(new Error("order committed, then the process crashed"));
        expect(await h.publish()).toEqual({ disposition: "rejected", reason: "peer-rejected-proposal" });
        expect.soft(loadDacsAgreementTerminalBoundaryForOrderV1(h.seller.context, h.seller.record as never)).toEqual({ sellerPassRetained: true, sellerResponseRetained: false });

        const runtime = h.terminalRuntime();
        expect.soft(await runtime.handleMessage(await h.failure(), h.inbound)).toMatchObject({ disposition: "rejected" });
        await expect.soft(runtime.advanceRegisteredTerminal(JOB_ID)).rejects.toMatchObject({ reasonCode: "vet-terminal-material-unavailable" });
        expect(h.seller.context.demos.signComponent).not.toHaveBeenCalled();
        expect(sentTypes(h)).not.toContain("terminal-bundle-contribution-seller");
        // The buyer's retry completes the admission of the same proposal.
        expect(await h.publish()).toEqual({ disposition: "submitted" });
    });

    it.each(["x402", "pay-dem"] as const)("does not co-sign a %s seller failure after a crash between the seller-pass decision and the proposal write", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        const database = h.seller.context.database as unknown as { putEffectIntent: (input: { input: unknown }) => unknown };
        const put = database.putEffectIntent;
        let crashed = false;
        database.putEffectIntent = (input) => {
            const value = input.input as { payload?: { proposal?: unknown } };
            if (!crashed && value.payload?.proposal !== undefined) {
                crashed = true;
                throw new Error("process crashed before the proposal write");
            }
            return put(input);
        };
        expect(await h.publish()).toEqual({ disposition: "rejected", reason: "peer-rejected-proposal" });
        expect(crashed).toBe(true);
        expect(loadDacsAgreementTerminalBoundaryForOrderV1(h.seller.context, h.seller.record as never).sellerPassRetained).toBe(true);

        const runtime = h.terminalRuntime();
        const terminal = await h.failure();
        expect.soft(await runtime.validatePayload({ type: "terminal-bundle-proposal-buyer", payload: terminal.envelope.payload, jobId: JOB_ID, sender: BUYER, audience: SELLER }))
            .toEqual({ status: "invalid", reasonCode: "vet-terminal-not-pre-agreement" });
        expect.soft(await runtime.handleMessage(terminal, h.inbound)).toEqual({ disposition: "rejected", reasonCode: "vet-terminal-not-pre-agreement" });
        await expect.soft(runtime.advanceRegisteredTerminal(JOB_ID)).rejects.toMatchObject({ reasonCode: "vet-terminal-material-unavailable" });
        expect(h.seller.context.demos.signComponent).not.toHaveBeenCalled();
        expect(await h.publish()).toEqual({ disposition: "submitted" });
    });

    it.each([
        ["corrupt", (binding: Record<string, unknown>) => { binding.payloadHash = "0".repeat(64); }, "agreement-proposal-binding-corrupt"],
        ["unauthenticated", (binding: Record<string, unknown>) => { delete binding.transportAuthentication; }, "agreement-proposal-binding-unauthenticated"],
    ] as const)("names a %s retained proposal binding in the seller bootstrap's operator reason", async (_label, tamper, reasonCode) => {
        const h = await memoryAgreementHarness("x402");
        await expect(h.publish()).resolves.toEqual({ disposition: "submitted" });
        const [key, value] = [...h.seller.effects].find(([, entry]) =>
            typeof entry === "object" && entry !== null && "payload" in entry &&
            typeof (entry as { payload: unknown }).payload === "object" &&
            "proposal" in ((entry as { payload: object }).payload))!;
        const binding = structuredClone(value) as Record<string, unknown>;
        tamper(binding);
        h.seller.effects.set(key, binding);
        const agreement = vi.fn();
        expect(await sellerBootstrapTrack(h, agreement)(h.seller.operation as never)).toEqual({ status: "operator-action", reasonCode });
        expect(agreement).not.toHaveBeenCalled();
    });

    it("keeps the terminal-boundary reader out of the package's public exports", async () => {
        const root = await import("../src/index.js");
        expect(Object.keys(root)).not.toContain("loadDacsAgreementTerminalBoundaryForOrderV1");
        expect(Object.keys(root)).toEqual(expect.arrayContaining([
            "createDacsBuyerAgreementTransportRuntimeV1",
            "createDacsSellerAgreementTransportRuntimeV1",
            "DacsAgreementTransportRuntimeError",
            "loadDacsSellerAgreementVetProductionForOrderV1",
        ]));
    }, 30_000); // imports the whole package root

    it("does not hand a terminal-committed seller job to the agreement even when the host says the proposal is ready", async () => {
        const donor = await memoryAgreementHarness("x402");
        await expect(donor.publish()).resolves.toEqual({ disposition: "submitted" });
        const h = await memoryAgreementHarness("x402");
        for (const [key, value] of donor.seller.effects) {
            if (typeof value === "object" && value !== null && "payload" in value &&
                typeof (value as { payload: unknown }).payload === "object" &&
                "proposal" in ((value as { payload: object }).payload)) h.seller.effects.set(key, structuredClone(value));
        }
        // The terminal path won, but its material was never written (a crash in between).
        claimDacsPreAgreementPhaseV1(h.seller.context, h.seller.record, "vet-terminal");
        const agreement = vi.fn();
        const track = createDacsSellerSessionBootstrapAgreementTrackV1({
            context: h.seller.context, sessionBootstrap: { resolveInit: vi.fn() },
            resolveBuyerRequirement: async () => ({ requirementVersion: "1", required: [] }),
            agreementProposalReady: async () => true, agreement,
        } as never);
        // Mark the response retained so the bootstrap takes its response-first hand-off.
        const contribution = await createFixedPriceAgreementSignatureContribution(h.request.plan, "seller", { party: SELLER, algorithm: "ed25519", sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)) });
        await donor.sellerRuntime.transport.publishSellerContribution(contribution, donor.request.transportIdentity, { owner: "seller", generation: 1, idempotencyKey: "memory-response" });
        for (const [key, value] of donor.seller.effects) {
            if (typeof value === "object" && value !== null && "payload" in value &&
                typeof (value as { payload: unknown }).payload === "object" &&
                "sellerContribution" in ((value as { payload: object }).payload)) h.seller.effects.set(key, structuredClone(value));
        }
        expect(loadDacsAgreementTerminalBoundaryForOrderV1(h.seller.context, h.seller.record as never).sellerResponseRetained).toBe(true);
        expect(await track(h.seller.operation as never)).toEqual({ status: "operator-action", reasonCode: "agreement-vet-terminal-phase-conflict" });
        expect(agreement).not.toHaveBeenCalled();
    });

    it.each([
        ["seller", (h: MemoryHarness, agreement: ReturnType<typeof vi.fn>) => sellerBootstrapTrack(h, agreement, async () => true)(h.seller.operation as never), (h: MemoryHarness) => h.seller],
        ["buyer", (h: MemoryHarness, agreement: ReturnType<typeof vi.fn>) => buyerBootstrapTrack(h, agreement)(h.buyer.operation as never), (h: MemoryHarness) => h.buyer],
    ] as const)("claims the agreement before the %s bootstrap hands a job to it", async (_role, tick, actor) => {
        const reached = await memoryAgreementHarness("x402");
        const signs = vi.fn(async () => ({ status: "final", outcome: "success", reference: "stor:agreement" }));
        expect(await tick(reached, signs)).toMatchObject({ status: "final", outcome: "success" });
        expect(signs).toHaveBeenCalledTimes(1);

        const h = await memoryAgreementHarness("x402");
        claimDacsPreAgreementPhaseV1(actor(h).context, actor(h).record, "vet-terminal");
        const agreement = vi.fn();
        expect(await tick(h, agreement)).toEqual({ status: "operator-action", reasonCode: "agreement-vet-terminal-phase-conflict" });
        expect(agreement).not.toHaveBeenCalled();
    });

    it.each(["x402", "pay-dem"] as const)("keeps a %s buyer that retained a Vet-failure terminal from proposing an agreement", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        const buyerTerminal = createDacsVetTerminalBundleTransportRuntimeV1({ context: h.buyer.context, expectedRegistryVersions: { recipeRegistryVersion: 1, railRegistryVersion: 1 }, authenticateProduction: async () => ({ status: "valid" }) });
        // The seller proposes that the buyer failed the seller's Vet.
        const fromBuyer = await h.failure("buyer");
        const fromSeller = { ...fromBuyer, envelope: { ...fromBuyer.envelope, type: "terminal-bundle-proposal-seller", sender: SELLER, audience: BUYER, keyId: SELLER } } as unknown as DacsHttpAuthenticatedEnvelopeV1;
        await h.ownVetPassed("buyer");
        await expect(buyerTerminal.handleMessage(fromSeller, { role: "buyer" } as DacsLiveRoleInboundOperationContextV1)).resolves.toEqual({ disposition: "accepted" });
        expect(await h.publish()).toEqual({ disposition: "rejected", reason: "agreement-vet-terminal-phase-conflict" });
        expect(vi.mocked(h.buyer.context.sendMessage).mock.calls.map(([message]) => message.type)).not.toContain("agreement-proposal");
    });

    it.each(["x402", "pay-dem"] as const)("still co-signs a genuine %s buyer-proposed seller failure before any proposal or response", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        const runtime = h.terminalRuntime();
        await h.ownVetPassed("seller");
        await expect(runtime.handleMessage(await h.failure(), h.inbound)).resolves.toEqual({ disposition: "accepted" });
        await expect(runtime.advanceRegisteredTerminal(JOB_ID)).resolves.toMatchObject({ disposition: "waiting" });
        expect(h.seller.context.demos.signComponent).toHaveBeenCalled();
        expect(sentTypes(h)).toContain("terminal-bundle-contribution-seller");
        await expect(advanceDacsVetTerminalTrackV1(runtime, h.seller.context, 1_000, JOB_ID)).resolves.toMatchObject({ status: "pending-retry", reasonCode: "vet-terminal-finalization-pending" });
    });
});

function phaseDecisionKey(role: "buyer" | "seller") {
    return `session:${sha256Hex(`dacs-live-pre-agreement-phase:v1:${canonicalize({ role, jobId: JOB_ID })}`)}`;
}

describe("round 4 admission and phase regressions", () => {
    for (const profile of ["x402", "pay-dem"] as const) {
        it.each([false, true])(`A0/A1 ${profile}: buyer failure is co-signed with early proposal=%s`, async (earlyProposal) => {
            const h = await memoryAgreementHarness(profile);
            if (earlyProposal) expect(await h.publish()).toEqual({ disposition: "submitted" });
            const failure = await h.failure("buyer");
            const terminalInput = (failure.envelope.payload as unknown as { terminalInput: never }).terminalInput;
            const { init, challenge, presentation } = bootstrapTranscript(h);
            const agreement = vi.fn();
            const production = (terminalInput as { production: unknown }).production;
            const runtime = h.terminalRuntime();
            const track = createDacsSellerSessionBootstrapAgreementTrackV1({
                context: h.seller.context,
                sessionBootstrap: { resolveInit: () => init, resolveChallenge: () => challenge,
                    resolvePresentation: () => presentation, resolveAdmission: () => undefined,
                    publishAdmission: async () => "submitted", publishChallenge: async () => "submitted" },
                resolveBuyerRequirement: async () => ({ requirementVersion: "1", required: [] }),
                agreementProposalReady: async () => true, agreement,
                vet: { produce: async () => ({ status: "ready", production }), authenticate: async () => "valid" },
                terminalBundle: { runtime, createInput: () => terminalInput },
            } as never);
            for (let tick = 0; tick < 2; tick += 1) {
                expect(await track(h.seller.operation as never)).toMatchObject({ status: "pending-retry", reasonCode: "vet-terminal-finalization-pending" });
            }
            expect(agreement).not.toHaveBeenCalled();
            expect(h.seller.context.demos.signComponent).toHaveBeenCalledTimes(2);
            expect(sentTypes(h)).toContain("terminal-bundle-proposal-seller");
            expect(sentTypes(h)).toContain("terminal-bundle-contribution-seller");
            expect(sentTypes(h)).not.toContain("agreement-response");
            if (earlyProposal) {
                await expect(h.sellerRuntime.resolveProposal({ operation: h.seller.operation as never }))
                    .rejects.toMatchObject({ reasonCode: "agreement-vet-terminal-phase-conflict" });
                // Transport refuses the losing proposal cleanly, without changing the terminal track.
                expect(await h.publish()).toEqual({ disposition: "rejected", reason: "peer-rejected-proposal" });
            }
        });

        it.each([
            ["corrupt", (h: MemoryHarness) => ({ nonsense: true })],
            ["stale-binding", (h: MemoryHarness) => ({ decisionVersion: "1", localBindingHash: "e".repeat(64), phase: "agreement" })],
            ["unknown-phase", (h: MemoryHarness) => ({ decisionVersion: "1", localBindingHash: h.seller.record.localBindingHash, phase: "both" })],
        ] as const)(`${profile}: a %s phase row requires operator action and fails closed`, async (_label, value) => {
            const h = await memoryAgreementHarness(profile);
            expect(await h.publish()).toEqual({ disposition: "submitted" });
            h.seller.effects.set(phaseDecisionKey("seller"), value(h));
            const agreement = vi.fn();
            expect(await sellerBootstrapTrack(h, agreement)(h.seller.operation as never))
                .toEqual({ status: "operator-action", reasonCode: "pre-agreement-phase-corrupt" });
            expect(agreement).not.toHaveBeenCalled();
            const terminal = await h.failure("buyer");
            expect(await h.terminalRuntime().validatePayload({ type: "terminal-bundle-proposal-buyer", payload: terminal.envelope.payload,
                jobId: JOB_ID, sender: BUYER, audience: SELLER }))
                .toEqual({ status: "invalid", reasonCode: "vet-terminal-binding-corrupt" });
            expect(h.seller.context.demos.signComponent).not.toHaveBeenCalled();
        });

        it(`${profile}: a valid vet-terminal phase with no terminal material goes to an operator (probe R7)`, async () => {
            const h = await memoryAgreementHarness(profile);
            expect(await h.publish()).toEqual({ disposition: "submitted" });
            // A crash between the terminal phase claim and its material write.
            h.seller.effects.set(phaseDecisionKey("seller"),
                { decisionVersion: "1", localBindingHash: h.seller.record.localBindingHash, phase: "vet-terminal" });
            const agreement = vi.fn();
            const track = sellerBootstrapTrack(h, agreement);
            for (let tick = 0; tick < 3; tick += 1) {
                expect(await track(h.seller.operation as never))
                    .toEqual({ status: "operator-action", reasonCode: "agreement-vet-terminal-phase-conflict" });
            }
            expect(agreement).not.toHaveBeenCalled();
            expect(h.seller.context.demos.signComponent).not.toHaveBeenCalled();
            expect(sentTypes(h)).not.toContain("agreement-response");
        });

        it(`${profile}: a corrupt seller-outcome row is reported as pre-agreement-phase-corrupt (probe R4)`, async () => {
            const h = await memoryAgreementHarness(profile);
            const id = sha256Hex(`dacs-live-seller-vet-outcome:v1:${canonicalize({ role: "seller", jobId: JOB_ID })}`);
            h.seller.effects.set(`session:${id}`, { nonsense: true });
            const agreement = vi.fn();
            expect(await sellerBootstrapTrack(h, agreement)(h.seller.operation as never))
                .toEqual({ status: "operator-action", reasonCode: "pre-agreement-phase-corrupt" });
            expect(agreement).not.toHaveBeenCalled();
            expect(h.seller.context.demos.signComponent).not.toHaveBeenCalled();
        });

        // Final r11 review: these reads run at the top of every seller tick, so
        // SQLite lock contention must be retried, not parked at operator action.
        it(`${profile}: retries a terminal decision read that meets SQLite lock contention`, async () => {
            const h = await memoryAgreementHarness(profile);
            const database = h.seller.context.database as unknown as { loadEffectInput: (kind: string, id: string) => unknown };
            const load = database.loadEffectInput;
            database.loadEffectInput = (kind, id) => {
                if (`${kind}:${id}` === phaseDecisionKey("seller")) {
                    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
                }
                return load(kind, id);
            };
            const agreement = vi.fn();
            expect(await sellerBootstrapTrack(h, agreement)(h.seller.operation as never)).toMatchObject({
                status: "indeterminate", reasonCode: "pre-agreement-phase-unavailable-busy",
            });
            expect(agreement).not.toHaveBeenCalled();
            expect(h.seller.context.demos.signComponent).not.toHaveBeenCalled();
            database.loadEffectInput = load;
            expect(await sellerBootstrapTrack(h, agreement)(h.seller.operation as never))
                .not.toMatchObject({ status: "operator-action" });
        });

        // Final re-review 1 (P3-1): the retained seller-response read had no
        // busy test of its own, so sending it to an operator went unnoticed.
        it(`${profile}: retries a retained seller-response read that meets SQLite lock contention`, async () => {
            const h = await memoryAgreementHarness(profile);
            const database = h.seller.context.database as unknown as { loadEffectInput: (kind: string, id: string) => unknown };
            const load = database.loadEffectInput;
            database.loadEffectInput = (kind, id) => {
                if (`${kind}:${id}` !== phaseDecisionKey("seller")) {
                    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
                }
                return load(kind, id);
            };
            const agreement = vi.fn();
            expect(await sellerBootstrapTrack(h, agreement)(h.seller.operation as never)).toMatchObject({
                status: "indeterminate", reasonCode: "seller-agreement-binding-unavailable-busy",
            });
            expect(agreement).not.toHaveBeenCalled();
            expect(h.seller.context.demos.signComponent).not.toHaveBeenCalled();
            database.loadEffectInput = load;
            expect(await sellerBootstrapTrack(h, agreement)(h.seller.operation as never))
                .not.toMatchObject({ status: "operator-action" });
        });

        it(`${profile}: an unreadable terminal decision cannot be treated as no decision`, async () => {
            const h = await memoryAgreementHarness(profile);
            const database = h.seller.context.database as unknown as { loadEffectInput: (kind: string, id: string) => unknown };
            const load = database.loadEffectInput;
            database.loadEffectInput = (kind, id) => {
                if (`${kind}:${id}` === phaseDecisionKey("seller")) throw new Error("unreadable decision row");
                return load(kind, id);
            };
            const terminal = await h.failure("buyer");
            expect(await h.terminalRuntime().validatePayload({ type: "terminal-bundle-proposal-buyer", payload: terminal.envelope.payload,
                jobId: JOB_ID, sender: BUYER, audience: SELLER }))
                .toEqual({ status: "invalid", reasonCode: "vet-terminal-binding-corrupt" });
            const agreement = vi.fn();
            expect(await sellerBootstrapTrack(h, agreement)(h.seller.operation as never))
                .toEqual({ status: "operator-action", reasonCode: "pre-agreement-phase-unavailable" });
            expect(agreement).not.toHaveBeenCalled();
            expect(h.seller.context.demos.signComponent).not.toHaveBeenCalled();
            expect(sentTypes(h)).toEqual([]);
        });
    }
});


describe("seller-pass admission outcome", () => {
    it.each(["x402", "pay-dem"] as const)("lets genuine %s agreement signing claim its phase after admission", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        expect(await h.publish()).toEqual({ disposition: "submitted" });
        expect(loadDacsPreAgreementPhaseV1(h.seller.context, h.seller.record)).toBeUndefined();
        expect(loadDacsSellerVetOutcomeV1(h.seller.context, h.seller.record)).toBe("seller-pass");
        await h.sellerRuntime.resolveProposal({ operation: h.seller.operation as never });
        expect(loadDacsPreAgreementPhaseV1(h.seller.context, h.seller.record)).toBe("agreement");
        await h.signResponse();
        expect(loadDacsAgreementTerminalBoundaryForOrderV1(h.seller.context, h.seller.record as never).sellerResponseRetained).toBe(true);
    });
    it.each(["x402", "pay-dem"] as const)("keeps %s admission and seller failure mutually exclusive at their insert-once outcome", async (profile) => {
        const h = await memoryAgreementHarness(profile);
        claimDacsSellerVetOutcomeV1(h.seller.context, h.seller.record, "seller-failure");
        expect(await h.publish()).toEqual({ disposition: "rejected", reason: "peer-rejected-proposal" });
        expect(h.startOrder).not.toHaveBeenCalled();
        expect(() => claimDacsSellerVetOutcomeV1(h.seller.context, h.seller.record, "seller-pass"))
            .toThrow("agreement-vet-terminal-phase-conflict");
        const admitted = await memoryAgreementHarness(profile);
        claimDacsSellerVetOutcomeV1(admitted.seller.context, admitted.seller.record, "seller-pass");
        expect(() => claimDacsSellerVetOutcomeV1(admitted.seller.context, admitted.seller.record, "seller-failure"))
            .toThrow("agreement-vet-terminal-phase-conflict");
    });
    it.each(["x402", "pay-dem"] as const)("rejects corrupt and stale %s seller outcome rows before admission", async (profile) => {
        for (const row of [ { nonsense: true }, { decisionVersion: "1", localBindingHash: "e".repeat(64), outcome: "seller-pass" },
            { decisionVersion: "1", localBindingHash: "e".repeat(64), outcome: "both" } ]) {
            const h = await memoryAgreementHarness(profile);
            const id = sha256Hex(`dacs-live-seller-vet-outcome:v1:${canonicalize({ role: "seller", jobId: JOB_ID })}`);
            h.seller.effects.set(`session:${id}`, row);
            expect(() => loadDacsSellerVetOutcomeV1(h.seller.context, h.seller.record)).toThrow("pre-agreement-phase-corrupt");
            expect(await h.publish()).toEqual({ disposition: "rejected", reason: "peer-rejected-proposal" });
            expect(h.startOrder).not.toHaveBeenCalled();
            expect(h.seller.context.demos.signComponent).not.toHaveBeenCalled();
        }
    });
});

it.each(["x402", "pay-dem"] as const)("the %s terminal outcome CAS rejects a stale admission-boundary snapshot", async (profile) => {
    const h = await memoryAgreementHarness(profile);
    // Authenticated admission crashes after its outcome decision, before its proposal.
    const database = h.seller.context.database as unknown as {
        putEffectIntent: (input: { input: unknown }) => unknown;
        loadEffectInput: (kind: string, id: string) => unknown;
    };
    const put = database.putEffectIntent;
    database.putEffectIntent = (input) => {
        if ((input.input as { payload?: { proposal?: unknown } }).payload?.proposal !== undefined)
            throw new Error("admission crashed before proposal retention");
        return put(input);
    };
    expect(await h.publish()).toEqual({ disposition: "rejected", reason: "peer-rejected-proposal" });
    expect(loadDacsSellerVetOutcomeV1(h.seller.context, h.seller.record)).toBe("seller-pass");
    const load = database.loadEffectInput;
    const outcomeId = sha256Hex(`dacs-live-seller-vet-outcome:v1:${canonicalize({ role: "seller", jobId: JOB_ID })}`);
    let outcomeWriteAttempted = false;
    // Model a terminal's pre-CAS checks that read before admission claimed.
    // The insert-once write and its readback see the actual retained decision.
    database.loadEffectInput = (kind, id) => id === outcomeId && !outcomeWriteAttempted ? undefined : load(kind, id);
    database.putEffectIntent = (input) => {
        if ((input.input as { outcome?: unknown }).outcome === "seller-failure") outcomeWriteAttempted = true;
        return put(input);
    };
    await h.ownVetPassed("seller");
    expect(await h.terminalRuntime().handleMessage(await h.failure(), h.inbound))
        .toEqual({ disposition: "rejected", reasonCode: "agreement-vet-terminal-phase-conflict" });
    expect(outcomeWriteAttempted).toBe(true);
    expect(h.seller.context.demos.signComponent).not.toHaveBeenCalled();
});


it.each(["x402", "pay-dem"] as const)("C2 %s: an agreement decision resumes the same proposal after a crash before retention", async (profile) => {
    const h = await memoryAgreementHarness(profile);
    claimDacsPreAgreementPhaseV1(h.seller.context, h.seller.record, "agreement");
    expect(await h.publish()).toEqual({ disposition: "submitted" });
    await expect(h.sellerRuntime.resolveProposal({ operation: h.seller.operation as never })).resolves.toBeDefined();
    expect(loadDacsPreAgreementPhaseV1(h.seller.context, h.seller.record)).toBe("agreement");
});
