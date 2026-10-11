import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign } from "node:crypto";

import {
  commitFixedPriceAgreement,
  createFixedPriceAgreementSignatureContribution,
  createFixedPriceAgreementSigningPlan,
  deriveFixedPriceAgreement,
  finalizeFixedPriceAgreementContributions,
  fixedPriceAgreementLogicalAddress,
} from "@kynesyslabs/dacs";
import type { Listing } from "@kynesyslabs/dacs/artifacts";
import {
  canonicalize,
  contentHash,
  listingAddress,
  sha256Hex,
} from "@kynesyslabs/dacs/canonical";
import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
} from "@kynesyslabs/dacs/commerce";
import {
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef, identityBundleHash } from "@kynesyslabs/dacs/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  resolveListing: vi.fn(),
  protocolBinding: vi.fn(),
  railProvenance: new WeakMap<object, Readonly<Record<string, unknown>>>(),
}));

vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  isAuthenticatedRailDefinition: (value: unknown) =>
    typeof value === "object" && value !== null && dependencies.railProvenance.has(value),
  getAuthenticatedRailProvenance: (value: unknown) =>
    typeof value === "object" && value !== null
      ? dependencies.railProvenance.get(value) ?? null : null,
}));

vi.mock("../src/listingDoctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/listingDoctor.js")>()),
  resolveDacsX402ExistingListingV1: dependencies.resolveListing,
}));
vi.mock("../src/purchaseQueue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/purchaseQueue.js")>()),
  createDacsFixedPriceX402ProtocolBindingV1: dependencies.protocolBinding,
}));
vi.mock("../src/sessionBootstrapTransportRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sessionBootstrapTransportRuntime.js")>()),
  authenticateDacsX402SessionIdentityV1: vi.fn(async () => true),
}));

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import {
  DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
  captureDacsFixedPriceX402ApplicationV1,
  createDacsFixedPriceX402BuyerAgreementPolicyV1,
  createDacsFixedPriceX402BuyerPaymentPolicyV1,
  createDacsFixedPriceX402SellerAgreementPolicyV1,
  createDacsFixedPriceX402SellerSessionPolicyV1,
  loadDacsFixedPriceX402CommitmentResultV1,
  loadDacsFixedPriceX402BuyerAgreementPublicationV1,
  loadDacsFixedPriceX402BuyerCommitmentResultV1,
  loadDacsFixedPriceX402SellerAdmissionV1,
  resolveDacsFixedPriceX402BuyerRequirementsV1,
} from "../src/fixedPriceX402Profile.js";
import { createDacsFixedPriceX402SellerAuthorityV1 } from
  "../src/fixedPriceX402SellerAuthority.js";
import { createDacsFixedPriceX402OrderPairV1 } from "../src/liveOrder.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import { retainDacsFixedPricePurchaseDemosBudgetGrantV1 } from
  "../src/purchaseDemosBudget.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const NOW = Date.now();
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 11));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 22));
const BUYER = demosAgentClaimRef(rawPublicKey(publicKeyFromSeed(BUYER_SEED)));
const SELLER = demosAgentClaimRef(rawPublicKey(publicKeyFromSeed(SELLER_SEED)));
const PAYER = `0x${"55".repeat(20)}`;
const PAYEE = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";
const ASSET = "0xCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEf";
const roots: string[] = [];
const databases: DacsNodeSqliteDatabase[] = [];

afterEach(() => {
  dependencies.resolveListing.mockReset();
  dependencies.protocolBinding.mockReset();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function protocol() {
  return {
    commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
    phase: "pay-x402" as const,
    orchestratorTopology: "seller-as-phase-orchestrator-v1" as const,
    orchestrator: SELLER,
    rail: {
      registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
      registryIndexHash: "1".repeat(64),
      railDefinitionRef: "dacs4:rail:x402%3Atest:2",
      railDefinitionHash: "2".repeat(64),
      railId: "x402:test",
      railVersion: 2,
      railType: "x402" as const,
      phaseHandler: "pay-x402" as const,
      network: "eip155:84532" as const,
      availability: "live" as const,
    },
  };
}

function listing(): Listing {
  const signature = Buffer.alloc(64, 3).toString("base64url");
  return {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "fixed-price-profile-test",
    seller: {
      identity: {
        bundleVersion: "1",
        presentedBy: SELLER,
        presentedAt: NOW - 1_000,
        claims: [{ ref: SELLER }],
        presentation: {
          kind: "per-claim",
          signatures: [{ ref: SELLER, signature }],
        },
      },
      displayName: "Seller",
      publicEndpoint: "https://seller.example",
    },
    offering: {
      title: "Result",
      description: "Bound result",
      category: "data.test",
      tags: ["test"],
      deliverable: {
        kind: "storage-program",
        accessModel: "public",
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:test" } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [{
      railId: "x402:test",
      railVersion: 2,
      parameters: {
        network: "eip155:84532",
        payTo: PAYEE,
        asset: ASSET,
        httpResource: "https://seller.example/dacs/x402",
      },
    }],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 10_000, notAfter: NOW + 1_000_000 },
    signature: { algorithm: "ed25519", signer: SELLER, value: signature },
  };
}

function application(exactListing = listing()) {
  const request = { schema: "request/v1", input: { query: "weather" } };
  return {
    applicationVersion: "1" as const,
    listingRef: `stor-${"5".repeat(40)}`,
    listingContentHash: contentHash(exactListing as unknown as Record<string, unknown>),
    listingLogicalAddress: listingAddress(
      exactListing.seller.identity.presentedBy,
      exactListing.listingId,
      exactListing.listingVersion,
    ),
    listing: exactListing,
    demosWriteFeeCeilings: { buyer: "2", seller: "2" },
    requestHash: sha256Hex(canonicalize(request)),
    request,
  };
}

function authenticatedRail() {
  const rail = Object.freeze({
    railVersion: 2,
    railId: "x402:test",
    railType: "x402" as const,
    asset: {
      kind: "erc20" as const,
      chainId: 84532,
      contract: ASSET,
      symbol: "USDC",
      decimals: 6,
    },
    network: {
      kind: "x402-resource" as const,
      resourceBaseUrl: "https://seller.example/dacs/x402",
    },
    phaseHandler: "pay-x402" as const,
    parameters: { authorization: "eip-3009", finalityBlocks: 1 },
    availability: "live" as const,
    governance: {
      proposedBy: SELLER,
      acceptedAt: NOW - 1_000,
      anchoring: "single-signer" as const,
    },
    signature: {
      algorithm: "ed25519" as const,
      signer: SELLER,
      value: Buffer.alloc(64, 4).toString("base64url"),
    },
  });
  dependencies.railProvenance.set(rail, Object.freeze({
    registryVersion: 1,
    indexContentHash: "1".repeat(64),
    definitionContentHash: "2".repeat(64),
  }));
  return rail;
}

function identity(authority: string, linkedClaim?: string) {
  const claims = [authority, ...(linkedClaim === undefined ? [] : [linkedClaim])];
  return {
    bundleVersion: "1" as const,
    presentedBy: authority,
    presentedAt: NOW - 500,
    claims: claims.map((ref) => ({ ref })),
    presentation: {
      kind: "per-claim" as const,
      signatures: claims.map((ref) => ({
        ref,
        signature: Buffer.alloc(64, 7).toString("base64url"),
      })),
    },
  };
}

function vetRef(subject: "buyer" | "seller", signer: string) {
  return {
    anchor: {
      kind: "storage-program" as const,
      locator: `dacs2:composite:${JOB_ID}:${subject}`,
    },
    contentHash: (subject === "buyer" ? "a" : "b").repeat(64),
    signer,
  };
}

function operation(record: Readonly<{ role: "buyer" | "seller"; jobId: string;
  bindingHash: string; localBindingHash: string }>, track = "agreement") {
  return {
    order: record,
    fence: {
      role: record.role,
      track,
      jobId: record.jobId,
      bindingHash: record.bindingHash,
      localBindingHash: record.localBindingHash,
      assertCurrent: async () => undefined,
    },
  } as never;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dacs-profile-policy-"));
  roots.push(root);
  const database = await openDacsNodeSqliteDatabase({
    databasePath: join(root, "seller.sqlite"),
    mode: "live-demos",
    profile: DACS_NODE_LIVE_PROFILE,
    role: "seller",
    authority: SELLER,
  });
  databases.push(database);
  const pair = createDacsFixedPriceX402OrderPairV1({
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: protocol(),
  });
  const app = application();
  const rail = authenticatedRail();
  const admission = {
    listingRef: app.listingRef,
    logicalAddress: app.listingLogicalAddress,
    listingContentHash: app.listingContentHash,
    listing: app.listing,
    rail,
    facts: {},
  };
  dependencies.resolveListing.mockResolvedValue({ status: "verified", admission });
  dependencies.protocolBinding.mockReturnValue(pair.buyer.protocol);
  const anchors = new Map<string, Readonly<Record<string, unknown>>>();
  const context = {
    role: "seller",
    authority: SELLER,
    peerAuthority: BUYER,
    config: {
      role: "seller",
      rail: { requestedNetwork: "eip155:84532" },
      limits: { maxDemosNetworkFeeDem: "2" },
    },
    evm: {
      role: "seller",
      address: PAYEE,
      identity: {
        role: "seller",
        network: "eip155:84532",
        chainId: 84532,
        address: PAYEE,
        warningCodes: [],
      },
    },
    database,
    demos: {
      role: "seller",
      signComponent: async (bytes: Uint8Array) =>
        sign(null, bytes, privateKeyFromSeed(SELLER_SEED)),
      adapter: {
        anchorWriteOnce: vi.fn(async (
          logicalAddress: string,
          artifact: Readonly<Record<string, unknown>>,
        ) => {
          const address = `stor-${sha256Hex(logicalAddress).slice(0, 40)}`;
          const existing = anchors.get(address);
          if (existing !== undefined && canonicalize(existing) !== canonicalize(artifact)) {
            throw new Error("anchor conflict");
          }
          anchors.set(address, structuredClone(artifact));
          return { address };
        }),
        readAnchor: vi.fn(async (address: string) =>
          structuredClone(anchors.get(address) ?? null)),
        resolveDemosAnchorReceipt: vi.fn(async (input: {
          logicalAddress: string;
          nativeAddress: string;
          contentHash: string;
          writer: string;
        }) => ({
          receiptVersion: "1" as const,
          substrate: "demos",
          finalityProfile: "demos-bft-confirmed-native-read",
          logicalAddress: input.logicalAddress,
          nativeAddress: input.nativeAddress,
          contentHash: input.contentHash,
          transactionRef: { kind: "demos-storage-program", value: `tx:${input.nativeAddress}` },
          writer: input.writer,
          state: "finalized" as const,
          observationDisposition: "established" as const,
          observedAt: NOW + 10,
          blockRef: { id: "block:commitment", height: "43", timestamp: NOW + 10 },
          evidence: { kind: "demos-bft-write-proof-v1", value: "proof" },
        })),
        verifyDemosAnchorReceipt: vi.fn(async () => true),
      },
    },
  } as never;
  let clock = NOW;
  const policy = createDacsFixedPriceX402SellerSessionPolicyV1({
    context,
    rail: admission.rail as never,
    sellerPublicEndpoint: "https://seller.example",
    sellerPayee: PAYEE,
    maximumServiceAmount: "1",
    now: () => clock++,
    readJson: vi.fn(),
  });
  return { database, pair, app, admission, rail, context, policy };
}

async function buyerFixture() {
  const root = mkdtempSync(join(tmpdir(), "dacs-profile-buyer-policy-"));
  roots.push(root);
  const database = await openDacsNodeSqliteDatabase({
    databasePath: join(root, "buyer.sqlite"),
    mode: "live-demos",
    profile: DACS_NODE_LIVE_PROFILE,
    role: "buyer",
    authority: BUYER,
  });
  databases.push(database);
  const pair = createDacsFixedPriceX402OrderPairV1({
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: protocol(),
  });
  const app = application();
  const retainedPut = putDacsLiveOrderInputV1({
    database,
    order: pair.buyer,
    application: app,
  });
  if (retainedPut.status === "conflict") throw new Error("buyer input conflict");
  retainDacsFixedPricePurchaseDemosBudgetGrantV1({
    database,
    jobId: JOB_ID,
    role: "buyer",
    authority: BUYER,
    maximumPerWriteFeeDem: app.demosWriteFeeCeilings.buyer,
  });
  const store = database.createLiveCoordinatorStore("buyer");
  await store.create({
    role: "buyer",
    order: pair.buyer,
    bindingHash: fixedPriceX402OrderBindingHash(pair.buyer),
    localBindingHash: fixedPriceX402OrderLocalBindingHash(pair.buyer),
  });
  const loaded = await store.load("buyer", JOB_ID);
  if (loaded.status !== "ok") throw new Error("buyer order missing");
  const anchors = new Map<string, Readonly<Record<string, unknown>>>();
  const namedAnchors = new Map<string, string>();
  let loseFirstResponse = false;
  const anchorWriteOnce = vi.fn(async (
    logicalAddress: string,
    artifact: Readonly<Record<string, unknown>>,
    _options?: Readonly<{ metadata?: Readonly<Record<string, string>> }>,
  ) => {
    const address = `stor-${sha256Hex(logicalAddress).slice(0, 40)}`;
    const existing = anchors.get(address);
    if (existing !== undefined && canonicalize(existing) !== canonicalize(artifact)) {
      throw new Error("anchor conflict");
    }
    anchors.set(address, structuredClone(artifact));
    namedAnchors.set(logicalAddress, address);
    if (loseFirstResponse) {
      loseFirstResponse = false;
      throw new Error("response lost");
    }
    return { address };
  });
  const context = {
    role: "buyer",
    authority: BUYER,
    peerAuthority: SELLER,
    config: {
      role: "buyer",
      rail: { requestedNetwork: "eip155:84532" },
      limits: { maxDemosNetworkFeeDem: "2" },
    },
    database,
    demos: {
      adapter: {
        anchorWriteOnce,
        resolveDemosAnchorReceipt: vi.fn(async (input: {
          logicalAddress: string;
          nativeAddress: string;
          contentHash: string;
          writer: string;
        }) => ({
          receiptVersion: "1" as const,
          substrate: "demos",
          finalityProfile: "demos-bft-confirmed-native-read",
          logicalAddress: input.logicalAddress,
          nativeAddress: input.nativeAddress,
          contentHash: input.contentHash,
          transactionRef: { kind: "demos-storage-program", value: `tx:${input.nativeAddress}` },
          writer: input.writer,
          state: "finalized" as const,
          observationDisposition: "established" as const,
          observedAt: NOW + 1,
          blockRef: { id: "block:42", height: "42", timestamp: NOW + 10 },
          evidence: { kind: "demos-bft-write-proof-v1", value: "proof" },
        })),
        verifyDemosAnchorReceipt: vi.fn(async () => true),
        readAnchor: vi.fn(async (address: string) =>
          structuredClone(anchors.get(address) ?? null)),
        resolveAnchorByName: vi.fn(async (logicalAddress: string) => {
          const address = namedAnchors.get(logicalAddress);
          return address === undefined
            ? { status: "absent" as const }
            : { status: "present" as const, address };
        }),
      },
    },
    evm: {
      role: "buyer",
      address: PAYER,
      runtime: {
        network: "eip155:84532",
        chainId: 84532,
        payerAddress: PAYER,
      },
    },
  } as never;
  const buyerIdentity = identity(BUYER, `cci-xm:evm:84532:${PAYER}`);
  const sellerIdentity = identity(SELLER);
  function vetProduction(
    evaluatedIdentity: ReturnType<typeof identity>,
    evaluatedParty: string,
    verifier: string,
    subject: "buyer" | "seller",
  ) {
    const requirement = subject === "buyer"
      ? app.listing.buyerRequirement
      : DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1;
    const unsigned = {
      recordVersion: "1" as const,
      jobId: JOB_ID,
      evaluatedParty,
      bundleHash: identityBundleHash(evaluatedIdentity),
      requirementHash: sha256Hex(canonicalize(requirement)),
      freshness: [],
      supplementary: [],
      dealSpecific: [],
      overallDecision: "pass" as const,
      generatedAt: NOW,
    };
    const record = {
      ...unsigned,
      signature: {
        algorithm: "ed25519" as const,
        signer: verifier,
        value: Buffer.alloc(64, subject === "buyer" ? 8 : 9).toString("base64url"),
      },
    };
    const recordRef = {
      anchor: { kind: "storage-program" as const,
        locator: `dacs2:composite:${JOB_ID}:${evaluatedParty}` },
      contentHash: contentHash(record),
      signer: verifier,
    };
    return {
      record,
      recordRef,
      anchorReceipt: {
        receiptVersion: "1" as const,
        substrate: "demos" as const,
        finalityProfile: "demos-bft-confirmed-native-read",
        logicalAddress: recordRef.anchor.locator,
        nativeAddress: `stor-${sha256Hex(subject).slice(0, 40)}`,
        contentHash: recordRef.contentHash,
        transactionRef: { kind: "demos-storage-program", value: `tx:${subject}` },
        writer: verifier,
        state: "finalized" as const,
        observationDisposition: "established" as const,
        observedAt: NOW,
        blockRef: { id: `block:${subject}`, height: "40", timestamp: NOW },
        evidence: { kind: "demos-bft-write-proof-v1", value: "proof" },
      },
    };
  }
  const buyerVet = vetProduction(buyerIdentity, BUYER, SELLER, "buyer");
  const sellerVet = vetProduction(sellerIdentity, SELLER, BUYER, "seller");
  const session = {
    factsVersion: "1" as const,
    role: "buyer" as const,
    jobId: JOB_ID,
    localBindingHash: loaded.record.localBindingHash,
    buyerIdentity,
    sellerIdentity,
    buyerRequirementHash: sha256Hex(canonicalize(app.listing.buyerRequirement)),
    buyerVetRecord: buyerVet.record,
    buyerVetRef: buyerVet.recordRef,
    buyerVetReceipt: buyerVet.anchorReceipt,
    sellerRequirementHash: sha256Hex(canonicalize(
      DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
    )),
    sellerVetRecord: sellerVet.record,
    sellerVetRef: sellerVet.recordRef,
    sellerVetReceipt: sellerVet.anchorReceipt,
  };
  const factsId = sha256Hex(`dacs-live-session-agreement-facts:v1:${canonicalize({
    role: "buyer",
    jobId: JOB_ID,
  })}`);
  const factsPut = database.putEffectIntent({
    kind: "session",
    effectId: factsId,
    bindingHash: loaded.record.localBindingHash,
    input: session,
    idempotencyKey: factsId,
    jobId: JOB_ID,
  });
  if (factsPut.status === "conflict") throw new Error("buyer facts conflict");
  return {
    database,
    pair,
    app,
    retained: retainedPut.record,
    record: loaded.record,
    operation: operation(loaded.record),
    context,
    session,
    anchorWriteOnce,
    publishRemote(logicalAddress: string, artifact: Readonly<Record<string, unknown>>) {
      const address = `stor-${sha256Hex(logicalAddress).slice(0, 40)}`;
      anchors.set(address, structuredClone(artifact));
      namedAnchors.set(logicalAddress, address);
      return address;
    },
    loseNextResponse() { loseFirstResponse = true; },
  };
}

function authenticated(payload: unknown) {
  return {
    envelope: {
      sender: BUYER,
      audience: SELLER,
      payload,
    },
  } as never;
}

describe("fixed-price x402 generated profile policy", () => {
  it("captures the closed application and exposes the explicit empty seller requirement", () => {
    const app = application();
    expect(captureDacsFixedPriceX402ApplicationV1(app)).toEqual(app);
    const requirements = resolveDacsFixedPriceX402BuyerRequirementsV1({
      application: app,
    } as never);
    expect(requirements.buyer).toEqual(app.listing.buyerRequirement);
    expect(requirements.seller).toBe(DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1);

    expect(() => captureDacsFixedPriceX402ApplicationV1({
      ...app,
      request: { changed: true },
    })).toThrow("fixed-price-application-binding-invalid");
    expect(() => captureDacsFixedPriceX402ApplicationV1({
      ...app,
      demosWriteFeeCeilings: { buyer: "0.0000000001", seller: "2" },
    })).toThrow("fixed-price-application-invalid");
  });

  it("independently admits and durably reuses one exact seller session", async () => {
    const value = await fixture();
    const init = { order: value.pair.buyer, application: value.app };
    const first = await value.policy.admitInit({
      authenticated: authenticated(init),
      payload: init as never,
    });
    const replay = await value.policy.admitInit({
      authenticated: authenticated(init),
      payload: init as never,
    });
    expect(replay).toEqual(first);
    expect(dependencies.resolveListing).toHaveBeenCalledTimes(2);

    const store = value.database.createLiveCoordinatorStore("seller");
    await store.create({
      role: "seller",
      order: first.order,
      bindingHash: fixedPriceX402OrderBindingHash(first.order),
      localBindingHash: fixedPriceX402OrderLocalBindingHash(first.order),
    });
    const loaded = await store.load("seller", JOB_ID);
    if (loaded.status !== "ok") throw new Error("seller order missing");
    const retained = loadDacsFixedPriceX402SellerAdmissionV1(
      value.context,
      loaded.record,
    );
    expect(retained.admittedAt).toBe(NOW);
    expect(retained.application).toEqual(value.app);

    // Runtime rail provenance is intentionally held in a WeakMap and cannot
    // survive SQLite serialization. Durable replay must validate the retained
    // protocol pin instead of trying to recreate authentication from JSON.
    dependencies.protocolBinding.mockImplementation(() => {
      throw new Error("online rail authentication is unavailable after restart");
    });
    expect(loadDacsFixedPriceX402SellerAdmissionV1(
      value.context,
      loaded.record,
    ).protocol).toEqual(first.order.protocol);

    await expect(value.policy.admitProposal({
      payload: { transportIdentity: { jobId: JOB_ID } },
    } as never)).resolves.toEqual({
      order: first.order,
      application: value.app,
    });
  });

  it("rejects a buyer order rebound to another seller", async () => {
    const value = await fixture();
    const rebound = {
      ...value.pair.buyer,
      seller: `did:demos:agent:${"99".repeat(32)}`,
    };
    await expect(value.policy.admitInit({
      authenticated: authenticated({ order: rebound, application: value.app }),
      payload: { order: rebound, application: value.app } as never,
    })).rejects.toThrow("fixed-price-session-party-mismatch");
    expect(dependencies.resolveListing).not.toHaveBeenCalled();
  });

  it("rejects a buyer-supplied seller fee grant above local policy", async () => {
    const value = await fixture();
    const applicationWithHigherGrant = {
      ...value.app,
      demosWriteFeeCeilings: { buyer: "2", seller: "3" },
    };
    const init = { order: value.pair.buyer, application: applicationWithHigherGrant };
    await expect(value.policy.admitInit({
      authenticated: authenticated(init),
      payload: init as never,
    })).rejects.toThrow("fixed-price Demos fee budget exceeds local policy");
  });

  it("replays one exact buyer draft and verifies only the bound Ed25519 parties", async () => {
    const value = await buyerFixture();
    let clock = NOW;
    const policy = createDacsFixedPriceX402BuyerAgreementPolicyV1({
      context: value.context,
      now: () => clock++,
    });
    const input = {
      operation: value.operation,
      retained: value.retained,
      session: value.session,
    };
    const first = policy.buildDraft(input);
    const replay = policy.buildDraft(input);
    expect(replay).toEqual(first);
    expect(first.generatedAt).toBe(NOW);
    expect(clock).toBe(NOW + 1);
    expect("payoutBindings" in first.terms ? first.terms.payoutBindings : undefined)
      .toEqual([{
        railId: "x402:test",
        phaseIndex: 2,
        payeeAddress: PAYEE,
      }]);

    const bytes = Uint8Array.from(Buffer.from("agreement contribution"));
    const signature = sign(null, bytes, privateKeyFromSeed(BUYER_SEED))
      .toString("base64url");
    expect(await policy.verifyContribution({
      role: "buyer",
      party: BUYER,
      algorithm: "ed25519",
      value: signature,
      signedBytes: bytes,
    })).toBe("valid");
    expect(await policy.verifyContribution({
      role: "seller",
      party: BUYER,
      algorithm: "ed25519",
      value: signature,
      signedBytes: bytes,
    })).toBe("invalid");
  });

  it("reconciles the exact retained Agreement after a lost Demos response", async () => {
    const value = await buyerFixture();
    const policy = createDacsFixedPriceX402BuyerAgreementPolicyV1({
      context: value.context,
      now: () => NOW,
    });
    const draft = policy.buildDraft({
      operation: value.operation,
      retained: value.retained,
      session: value.session,
    });
    const artifact = {
      ...draft,
      signatures: [{
        party: BUYER,
        algorithm: "ed25519" as const,
        value: Buffer.alloc(64, 1).toString("base64url"),
      }, {
        party: SELLER,
        algorithm: "ed25519" as const,
        value: Buffer.alloc(64, 2).toString("base64url"),
      }],
    };
    const agreementHash = contentHash(artifact as unknown as Record<string, unknown>);
    const envelopeHash = sha256Hex(canonicalize(artifact));
    const logicalAddress = fixedPriceAgreementLogicalAddress(JOB_ID);
    value.loseNextResponse();
    await expect(policy.anchor.anchorAgreement({
      logicalAddress,
      agreementHash,
      artifact: artifact as never,
    }, {} as never)).resolves.toMatchObject({ disposition: "indeterminate" });

    const reconciled = await policy.anchor.reconcileAgreementAnchor({
      logicalAddress,
      agreementHash,
    }, {} as never);
    expect(reconciled).toMatchObject({ disposition: "present" });
    if (reconciled.disposition !== "present") throw new Error("agreement missing");
    const reconciledValue = reconciled.value as {
      artifact: typeof artifact;
      ref: Parameters<typeof policy.anchor.verifyAnchorReceipt>[0]["ref"];
      anchorReceipt: Parameters<typeof policy.anchor.verifyAnchorReceipt>[0]["receipt"];
    };
    expect(reconciledValue.artifact).toEqual(artifact);
    expect(value.anchorWriteOnce).toHaveBeenCalledTimes(2);
    for (const invocation of value.anchorWriteOnce.mock.calls) {
      expect(invocation[2]).toEqual({
        metadata: {
          logicalAddress,
          contentHash: agreementHash,
          envelopeHash,
        },
        feeBudget: {
          budgetId: `dacs-fixed-price-purchase:v1:${JOB_ID}:buyer`,
          maximumPerWriteFeeOs: 2_000_000_000n,
          maximumTotalFeeOs: 12_000_000_000n,
        },
      });
    }
    await expect(policy.anchor.verifyAnchorReceipt({
      expectedWriter: BUYER,
      ref: reconciledValue.ref,
      receipt: reconciledValue.anchorReceipt,
    })).resolves.toBe("valid");
    expect(policy.authorizeAnchored({
      operation: value.operation,
      retained: value.retained,
      result: {
        agreement: reconciledValue.artifact,
        agreementHash,
        agreementRef: reconciledValue.ref,
        anchorReceipt: reconciledValue.anchorReceipt,
      },
    })).toBe(true);
  });

  it("authenticates the finalized commitment before deriving exact buyer x402 authority", async () => {
    const value = await buyerFixture();
    const agreementPolicy = createDacsFixedPriceX402BuyerAgreementPolicyV1({
      context: value.context,
      now: () => NOW,
    });
    const draft = agreementPolicy.buildDraft({
      operation: value.operation,
      retained: value.retained,
      session: value.session,
    });
    const plan = createFixedPriceAgreementSigningPlan(draft);
    const [buyerContribution, sellerContribution] = await Promise.all([
      createFixedPriceAgreementSignatureContribution(plan, "buyer", {
        party: BUYER,
        algorithm: "ed25519",
        sign: (bytes) => sign(null, bytes, privateKeyFromSeed(BUYER_SEED)),
      }),
      createFixedPriceAgreementSignatureContribution(plan, "seller", {
        party: SELLER,
        algorithm: "ed25519",
        sign: (bytes) => sign(null, bytes, privateKeyFromSeed(SELLER_SEED)),
      }),
    ]);
    const agreement = await finalizeFixedPriceAgreementContributions(
      plan,
      [buyerContribution, sellerContribution],
      agreementPolicy.verifyContribution,
    );
    const agreementHash = contentHash(agreement as unknown as Record<string, unknown>);
    const logicalAddress = fixedPriceAgreementLogicalAddress(JOB_ID);
    await expect(agreementPolicy.anchor.anchorAgreement({
      logicalAddress,
      agreementHash,
      artifact: agreement,
    }, {} as never)).resolves.toEqual({ disposition: "submitted" });
    await expect(loadDacsFixedPriceX402BuyerAgreementPublicationV1(
      value.context,
      value.record,
    )).resolves.toMatchObject({ agreementHash, artifact: agreement });

    const rail = authenticatedRail();
    const paymentPolicy = createDacsFixedPriceX402BuyerPaymentPolicyV1({
      context: value.context,
      rail: rail as never,
      tokenDomain: { name: "USD Coin", version: "2" },
      maxTimeoutSeconds: 120,
    });
    const paymentOperation = operation(value.record, "payment");
    await expect(paymentPolicy.resolvePreparation({
      operation: paymentOperation,
      retained: value.retained,
    } as never)).rejects.toMatchObject({
      status: "pending-retry",
      reasonCode: "fixed-price-commitment-pending",
    });

    const commitmentAgreement = JSON.parse(canonicalize(agreement));
    const commitment = await commitFixedPriceAgreement({
      agreement: commitmentAgreement,
      verifiedListing: {
        disposition: "verified",
        listing: JSON.parse(canonicalize(value.app.listing)),
        pin: JSON.parse(canonicalize(agreement.listingRef)),
      },
      session: {
        jobId: JOB_ID,
        listingRef: JSON.parse(canonicalize(agreement.listingRef)),
        phaseKind: "commit-payee-bound-agreement",
        orchestrator: SELLER,
        buyer: {
          primaryClaim: BUYER,
          bundleHash: identityBundleHash(value.session.buyerIdentity),
          vetRecordRef: JSON.parse(canonicalize(value.session.buyerVetRef)),
        },
        seller: {
          primaryClaim: SELLER,
          bundleHash: identityBundleHash(value.session.sellerIdentity),
          vetRecordRef: JSON.parse(canonicalize(value.session.sellerVetRef)),
        },
      },
      createdAt: NOW + 5,
      commitmentSigner: {
        algorithm: "ed25519",
        signer: SELLER,
        sign: (bytes) => sign(null, bytes, privateKeyFromSeed(SELLER_SEED)),
      },
    }, {
      resolve: async () => ({ disposition: "absent" }),
      submit: async (commitmentAddress, record) => {
        const address = value.publishRemote(
          commitmentAddress,
          record as unknown as Record<string, unknown>,
        );
        return {
          record,
          nativeAddress: address,
          anchorTxRef: {
            kind: "storage-program",
            address,
            writeTxHash: `tx:${address}`,
          },
          anchorReceipt: {
            receiptVersion: "1",
            substrate: "demos",
            finalityProfile: "demos-bft-confirmed-native-read",
            logicalAddress: commitmentAddress,
            nativeAddress: address,
            contentHash: contentHash(record as unknown as Record<string, unknown>),
            transactionRef: { kind: "demos-storage-program", value: `tx:${address}` },
            writer: SELLER,
            state: "finalized",
            observationDisposition: "established",
            observedAt: NOW + 10,
            blockRef: { id: "block:commitment", height: "43", timestamp: NOW + 10 },
            evidence: { kind: "demos-bft-write-proof-v1", value: "proof" },
          },
        };
      },
      verifyAnchorReceipt: async () => "valid" as const,
    }, ({ signer, algorithm, value: signature, signedBytes }) => {
      const seed = signer === BUYER ? BUYER_SEED : signer === SELLER ? SELLER_SEED : null;
      if (seed === null || algorithm !== "ed25519") return "invalid";
      return ed25519Verify(
        signedBytes,
        Uint8Array.from(Buffer.from(signature, "base64url")),
        publicKeyFromSeed(seed),
      ) ? "valid" : "invalid";
    });
    expect(commitment.recordKind).toBe("finality");

    const preparation = await paymentPolicy.resolvePreparation({
      operation: paymentOperation,
      retained: value.retained,
    } as never);
    expect(preparation).toEqual({
      authority: {
        jobId: JOB_ID,
        phaseIndex: 2,
        railId: "x402:test",
        railVersion: "2",
        railDescriptorHash: "2".repeat(64),
        agreementHash,
        termsHash: sha256Hex(canonicalize(agreement.terms)),
        sessionBindingHash: sha256Hex(canonicalize({
          jobId: JOB_ID,
          payer: PAYER,
          commitment: `dacs3:commit:${JOB_ID}`,
        })),
        network: "eip155:84532",
        payer: PAYER,
        payee: PAYEE,
        asset: ASSET,
        amount: "1000000",
        httpResource: `https://seller.example/dacs/x402/${JOB_ID}`,
        method: "GET",
      },
      expectedRequirements: {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: ASSET,
        payTo: PAYEE,
        maxTimeoutSeconds: 120,
        extra: {
          name: "USD Coin",
          version: "2",
        },
      },
    });
    expect(loadDacsFixedPriceX402BuyerCommitmentResultV1(
      value.context,
      value.record,
    )).toMatchObject({ agreementHash, commitment: { recordKind: "finality" } });
    const intent = {
      ...preparation.authority,
      intentVersion: "1",
      settlementKey: "settlement:test",
      bindingHash: "f".repeat(64),
      chosenRequirements: {
        ...preparation.expectedRequirements,
        asset: ASSET.toLowerCase(),
        payTo: PAYEE.toLowerCase(),
      },
      signedPaymentPayload: {},
      paymentHeader: { name: "PAYMENT-SIGNATURE", value: "opaque" },
      authorizationNonce: `0x${"1".repeat(64)}`,
    } as never;
    const authorization = {
      from: PAYER,
      to: PAYEE.toLowerCase(),
      value: "1000000",
      validAfter: String(Math.floor(NOW / 1_000) - 1),
      validBefore: String(Math.floor(agreement.terms.deadline / 1_000)),
      nonce: `0x${"1".repeat(64)}`,
      signature: `0x${"1".repeat(130)}`,
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 84532,
        verifyingContract: ASSET.toLowerCase(),
      },
    } as const;
    await expect(paymentPolicy.authorizeIntent({
      intent,
      authorization,
      fence: {} as never,
    })).resolves.toEqual({ disposition: "authorized", bindingHash: "f".repeat(64) });
    await expect(paymentPolicy.authorizeIntent({
      intent,
      authorization: {
        ...authorization,
        validBefore: String(Math.floor(agreement.terms.deadline / 1_000) + 1),
      },
      fence: {} as never,
    })).resolves.toMatchObject({
      disposition: "rejected",
      reason: "payment-authority-mismatch",
    });
    expect(paymentPolicy.authorizePreparedIntent({
      operation: paymentOperation,
      retained: value.retained,
      intent,
    } as never)).toBe(true);
    expect(paymentPolicy.authorizePreparedIntent({
      operation: paymentOperation,
      retained: value.retained,
      intent: { ...(intent as unknown as Record<string, unknown>), amount: "1000001" },
    } as never)).toBe(false);

    vi.spyOn(value.database, "readTime").mockReturnValue(agreement.terms.deadline + 1);
    await expect(paymentPolicy.authorizeIntent({
      intent,
      authorization,
      fence: {} as never,
    })).resolves.toEqual({ disposition: "authorized", bindingHash: "f".repeat(64) });
    expect(paymentPolicy.authorizePreparedIntent({
      operation: paymentOperation,
      retained: value.retained,
      intent,
    } as never)).toBe(false);
  });

  it("requires operator action when the completed buyer Agreement is unavailable", async () => {
    const value = await buyerFixture();
    const paymentPolicy = createDacsFixedPriceX402BuyerPaymentPolicyV1({
      context: value.context,
      rail: authenticatedRail() as never,
      tokenDomain: { name: "USD Coin", version: "2" },
      maxTimeoutSeconds: 120,
    });
    await expect(paymentPolicy.resolvePreparation({
      operation: operation(value.record, "payment"),
      retained: value.retained,
    } as never)).rejects.toMatchObject({
      status: "operator-action",
      reasonCode: "fixed-price-agreement-authority-invalid",
    });
  });

  it("reconstructs the admitted seller Agreement instead of trusting the proposal", async () => {
    const value = await fixture();
    const init = { order: value.pair.buyer, application: value.app };
    const admitted = await value.policy.admitInit({
      authenticated: authenticated(init),
      payload: init as never,
    });
    const retainedPut = putDacsLiveOrderInputV1({
      database: value.database,
      order: admitted.order,
      application: value.app,
    });
    if (retainedPut.status === "conflict") throw new Error("seller input conflict");
    const store = value.database.createLiveCoordinatorStore("seller");
    await store.create({
      role: "seller",
      order: admitted.order,
      bindingHash: fixedPriceX402OrderBindingHash(admitted.order),
      localBindingHash: fixedPriceX402OrderLocalBindingHash(admitted.order),
    });
    const loaded = await store.load("seller", JOB_ID);
    if (loaded.status !== "ok") throw new Error("seller order missing");
    const buyerIdentity = identity(BUYER, `cci-xm:evm:84532:${PAYER}`);
    const sellerIdentity = identity(SELLER);
    const buyerRequirementHash = sha256Hex(canonicalize(
      value.app.listing.buyerRequirement,
    ));
    const buyerVetRecord = {
      recordVersion: "1" as const,
      jobId: JOB_ID,
      evaluatedParty: BUYER,
      bundleHash: identityBundleHash(buyerIdentity),
      requirementHash: buyerRequirementHash,
      freshness: [],
      supplementary: [],
      dealSpecific: [],
      overallDecision: "pass" as const,
      generatedAt: NOW,
      signature: {
        algorithm: "ed25519" as const,
        signer: SELLER,
        value: Buffer.alloc(64, 6).toString("base64url"),
      },
    };
    const buyerVetRef = {
      anchor: {
        kind: "storage-program" as const,
        locator: `dacs2:composite:${JOB_ID}:${BUYER}`,
      },
      contentHash: contentHash(buyerVetRecord),
      signer: SELLER,
    };
    const buyerVetReceipt = {
      receiptVersion: "1" as const,
      substrate: "demos" as const,
      finalityProfile: "demos-bft-confirmed-native-read",
      logicalAddress: buyerVetRef.anchor.locator,
      nativeAddress: `stor-${sha256Hex("seller-buyer-vet").slice(0, 40)}`,
      contentHash: buyerVetRef.contentHash,
      transactionRef: { kind: "demos-storage-program" as const, value: "tx:buyer-vet" },
      writer: SELLER,
      state: "finalized" as const,
      observationDisposition: "established" as const,
      observedAt: NOW,
      blockRef: { id: "block:buyer-vet", height: "41", timestamp: NOW },
      evidence: { kind: "demos-bft-write-proof-v1", value: "proof" },
    };
    const sellerVetRecord = { record: "buyer-produced seller Vet" };
    const sellerVetRef = {
      ...vetRef("seller", BUYER),
      contentHash: contentHash(sellerVetRecord),
    };
    const candidateDraft = deriveFixedPriceAgreement({
      jobId: JOB_ID,
      verifiedListing: {
        disposition: "verified",
        listing: value.app.listing,
        pin: {
          listingId: value.app.listing.listingId,
          version: value.app.listing.listingVersion,
          contentHash: value.app.listingContentHash,
        },
      },
      buyer: { identityBundle: buyerIdentity, vetRecordRef: buyerVetRef },
      seller: { identityBundle: sellerIdentity, vetRecordRef: sellerVetRef },
      selectedRail: value.app.listing.acceptedRails![0],
      payoutBindings: [{
        railId: "x402:test",
        phaseIndex: 2,
        payeeAddress: PAYEE,
      }],
      generatedAt: NOW,
    });
    const policy = createDacsFixedPriceX402SellerAgreementPolicyV1({
      context: value.context,
    });
    const base = {
      queryVersion: "1" as const,
      jobId: JOB_ID,
      listingPin: candidateDraft.listingRef,
      candidateDraft,
      planHash: "1".repeat(64),
      agreementHash: "2".repeat(64),
      proposalHash: "3".repeat(64),
      buyer: BUYER,
      seller: SELLER,
      operation: operation(loaded.record),
      retained: retainedPut.record,
      session: {
        factsVersion: "1",
        role: "seller",
        jobId: JOB_ID,
        localBindingHash: loaded.record.localBindingHash,
        buyerIdentity,
        sellerIdentity,
        buyerRequirementHash,
        buyerVetRecord,
        buyerVetRef,
        buyerVetReceipt,
      },
      sellerVet: { record: sellerVetRecord, recordRef: sellerVetRef, anchorReceipt: {} },
      sellerRequirement: DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
    };
    const resolved = policy.resolveAuthenticatedAgreementContext(base as never);
    expect(resolved).toEqual({
      disposition: "present",
      value: expect.any(Object),
    });
    if (resolved.disposition !== "present") throw new Error("context missing");
    expect(deriveFixedPriceAgreement(resolved.value)).toEqual(candidateDraft);

    expect(policy.resolveAuthenticatedAgreementContext({
      ...base,
      listingPin: { ...candidateDraft.listingRef, contentHash: "9".repeat(64) },
    } as never)).toMatchObject({ disposition: "rejected" });

    const plan = createFixedPriceAgreementSigningPlan(candidateDraft);
    const buyerContribution = await createFixedPriceAgreementSignatureContribution(
      plan,
      "buyer",
      {
        party: BUYER,
        algorithm: "ed25519",
        sign: (bytes) => sign(null, bytes, privateKeyFromSeed(BUYER_SEED)),
      },
    );
    const sellerContribution = await createFixedPriceAgreementSignatureContribution(
      plan,
      "seller",
      {
        party: SELLER,
        algorithm: "ed25519",
        sign: (bytes) => sign(null, bytes, privateKeyFromSeed(SELLER_SEED)),
      },
    );
    const proposalMaterial = {
      proposalVersion: "1" as const,
      plan,
      buyerContribution,
    };
    const proposal = {
      ...proposalMaterial,
      proposalHash: sha256Hex(canonicalize(proposalMaterial)),
    };
    const result = {
      responseVersion: "1" as const,
      transportIdentity: {
        jobId: JOB_ID,
        planHash: plan.planHash,
        agreementHash: plan.agreementHash,
        buyer: BUYER,
        seller: SELLER,
        proposalHash: proposal.proposalHash,
      },
      sellerContribution,
    };
    const authorization = {
      operation: operation(loaded.record),
      retained: retainedPut.record,
      proposal,
      result,
    };
    await expect(policy.authorizeComplete(authorization)).resolves.toBe(true);
    const committed = loadDacsFixedPriceX402CommitmentResultV1(
      value.context,
      loaded.record,
    );
    expect(committed.agreement.jobId).toBe(JOB_ID);
    expect(committed.commitment.recordKind).toBe("finality");
    expect(committed.commitment.logicalAddress).toBe(`dacs3:commit:${JOB_ID}`);
    await expect(policy.authorizeComplete(authorization)).resolves.toBe(true);

    const facts = base.session;
    const factsId = sha256Hex(`dacs-live-session-agreement-facts:v1:${canonicalize({
      role: "seller",
      jobId: JOB_ID,
    })}`);
    const factsPut = value.database.putEffectIntent({
      kind: "session",
      effectId: factsId,
      bindingHash: loaded.record.localBindingHash,
      input: facts,
      idempotencyKey: factsId,
      jobId: JOB_ID,
    });
    expect(factsPut.status).toBe("created");

    const sellerAuthority = createDacsFixedPriceX402SellerAuthorityV1({
      context: value.context,
      rail: value.rail as never,
      tokenDomain: { name: "USD Coin", version: "2" },
    });
    await expect(sellerAuthority.resolveOrderScope({
      operation: operation(loaded.record, "payment"),
      retained: retainedPut.record,
    })).resolves.toEqual({ paymentPhaseIndex: 2, deliveryPhaseIndex: 3 });
    const laterOrderSnapshot = {
      ...loaded.record,
      revision: loaded.record.revision + 1,
      updatedAt: loaded.record.updatedAt + 1,
    };
    await expect(sellerAuthority.resolveOrderScope({
      operation: operation(laterOrderSnapshot, "payment-evidence"),
      retained: retainedPut.record,
    })).resolves.toEqual({ paymentPhaseIndex: 2, deliveryPhaseIndex: 3 });
    await expect(sellerAuthority.resolveHttpScope(JOB_ID)).resolves.toEqual({
      paymentPhaseIndex: 2,
      httpResource: `https://seller.example/dacs/x402/${JOB_ID}`,
    });
    const expected = {
      network: "eip155:84532" as const,
      payTo: PAYEE,
      amount: "1000000",
      asset: ASSET,
      eip712: { name: "USD Coin", version: "2" },
    };
    await expect(sellerAuthority.resolveCommittedSession({
      jobId: JOB_ID,
      phaseIndex: 2,
      payer: PAYER,
      request: {
        getMethod: () => "GET",
        getUrl: () => `https://seller.example/dacs/x402/${JOB_ID}`,
      },
      expected,
    } as never)).resolves.toMatchObject({
      disposition: "verified",
      session: {
        jobId: JOB_ID,
        payer: PAYER,
        payerPayingKey: `cci-xm:evm:84532:${PAYER}`,
        httpResource: `https://seller.example/dacs/x402/${JOB_ID}`,
        railRegistryVersion: 1,
        expected,
      },
    });
    await expect(sellerAuthority.resolveCommittedSession({
      jobId: JOB_ID,
      phaseIndex: 2,
      payer: PAYER,
      request: {
        getMethod: () => "GET",
        getUrl: () => "https://seller.example/dacs/x402/wrong",
      },
      expected,
    } as never)).resolves.toMatchObject({ disposition: "rejected" });
    await expect(sellerAuthority.resolveCommittedAgreement(JOB_ID)).resolves.toMatchObject({
      disposition: "verified",
      agreementHash: contentHash(committed.agreement as unknown as Record<string, unknown>),
      railRegistryVersion: 1,
    });
    await expect(sellerAuthority.resolveListingAtCommit(
      candidateDraft.listingRef,
    )).resolves.toMatchObject({
      validation: { disposition: "verified", step: 9 },
    });
    await expect(sellerAuthority.resolveFulfilmentAgreement(
      `dacs3:agreement:${JOB_ID}`,
    )).resolves.toMatchObject({
      status: "verified",
      value: {
        artifactKind: "payee-bound",
        jobId: JOB_ID,
        listingPin: candidateDraft.listingRef,
        buyer: { primaryClaim: BUYER },
        seller: { primaryClaim: SELLER },
        deliverableRef: { deliverableType: "storage-program" },
        commitment: { status: "finalized", signer: SELLER },
      },
    });
    await expect(sellerAuthority.resolveFulfilmentListing(
      candidateDraft.listingRef,
    )).resolves.toMatchObject({
      status: "verified",
      value: {
        pin: candidateDraft.listingRef,
        sellerPrimaryClaim: SELLER,
        deliverable: { kind: "storage-program" },
      },
    });
    const intakeResolution = await sellerAuthority.resolveRail({
      ref: candidateDraft.terms.rail!,
      railRegistryVersion: 1,
    });
    expect(intakeResolution).toEqual({
      disposition: "verified",
      rail: {
        railVersion: 2,
        railId: "x402:test",
        railType: "x402",
        asset: {
          kind: "erc20",
          chainId: 84532,
          contract: ASSET,
          symbol: "USDC",
          decimals: 6,
        },
        network: {
          kind: "x402-resource",
          resourceBaseUrl: "https://seller.example/dacs/x402",
        },
        phaseHandler: "pay-x402",
        parameters: { authorization: "eip-3009", finalityBlocks: 1 },
        availability: "live",
      },
      railRegistryVersion: 1,
    });
    if (intakeResolution.disposition !== "verified" ||
        intakeResolution.rail.railType !== "x402") throw new Error("rail missing");
    await expect(sellerAuthority.resolvePayerAddress({
      payingKey: `cci-xm:evm:84532:${PAYER}`,
      buyerBundle: buyerIdentity,
      rail: intakeResolution.rail,
    })).resolves.toEqual({ disposition: "verified", address: PAYER });
    await expect(sellerAuthority.resolvePayeeDestination({
      payeePrimaryClaim: SELLER,
      payeeBundle: sellerIdentity,
      payoutAddress: PAYEE,
      rail: intakeResolution.rail,
    })).resolves.toEqual({ disposition: "bound", address: PAYEE, tier: 3 });
    await expect(sellerAuthority.resolveIdentityBundle(
      identityBundleHash(buyerIdentity),
    )).resolves.toMatchObject({ disposition: "verified", bundle: buyerIdentity });
  });
});
