import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign } from "node:crypto";

import {
  deriveFixedPriceAgreement,
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
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef } from "@kynesyslabs/dacs/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  resolveListing: vi.fn(),
  protocolBinding: vi.fn(),
}));

vi.mock("../src/listingDoctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/listingDoctor.js")>()),
  resolveDacsX402ExistingListingV1: dependencies.resolveListing,
}));
vi.mock("../src/purchaseQueue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/purchaseQueue.js")>()),
  createDacsFixedPriceX402ProtocolBindingV1: dependencies.protocolBinding,
}));

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import {
  DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
  captureDacsFixedPriceX402ApplicationV1,
  createDacsFixedPriceX402BuyerAgreementPolicyV1,
  createDacsFixedPriceX402SellerAgreementPolicyV1,
  createDacsFixedPriceX402SellerSessionPolicyV1,
  loadDacsFixedPriceX402SellerAdmissionV1,
  resolveDacsFixedPriceX402BuyerRequirementsV1,
} from "../src/fixedPriceX402Profile.js";
import { createDacsFixedPriceX402OrderPairV1 } from "../src/liveOrder.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
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
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:test" } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [{
      railId: "x402:test",
      railVersion: 2,
      parameters: {
        network: "eip155:84532",
        payTo: `0x${"33".repeat(20)}`,
        asset: `0x${"44".repeat(20)}`,
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
    requestHash: sha256Hex(canonicalize(request)),
    request,
  };
}

function identity(authority: string) {
  return {
    bundleVersion: "1" as const,
    presentedBy: authority,
    presentedAt: NOW - 500,
    claims: [{ ref: authority }],
    presentation: {
      kind: "per-claim" as const,
      signatures: [{ ref: authority, signature: Buffer.alloc(64, 7).toString("base64url") }],
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
  bindingHash: string; localBindingHash: string }>) {
  return {
    order: record,
    fence: {
      role: record.role,
      track: "agreement",
      jobId: record.jobId,
      bindingHash: record.bindingHash,
      localBindingHash: record.localBindingHash,
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
  const admission = {
    listingRef: app.listingRef,
    logicalAddress: app.listingLogicalAddress,
    listingContentHash: app.listingContentHash,
    listing: app.listing,
    rail: { authenticated: true },
    facts: {},
  };
  dependencies.resolveListing.mockResolvedValue({ status: "verified", admission });
  dependencies.protocolBinding.mockReturnValue(pair.buyer.protocol);
  const context = {
    role: "seller",
    authority: SELLER,
    peerAuthority: BUYER,
    config: { rail: { requestedNetwork: "eip155:84532" } },
    database,
    demos: {
      adapter: {
        readAnchor: vi.fn(),
        resolveDemosAnchorReceipt: vi.fn(),
        verifyDemosAnchorReceipt: vi.fn(),
      },
    },
  } as never;
  let clock = NOW;
  const policy = createDacsFixedPriceX402SellerSessionPolicyV1({
    context,
    rail: admission.rail as never,
    sellerPublicEndpoint: "https://seller.example",
    sellerPayee: `0x${"33".repeat(20)}`,
    maximumServiceAmount: "1",
    now: () => clock++,
    readJson: vi.fn(),
  });
  return { database, pair, app, admission, context, policy };
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
  let loseFirstResponse = false;
  const anchorWriteOnce = vi.fn(async (
    logicalAddress: string,
    artifact: Readonly<Record<string, unknown>>,
  ) => {
    const address = `stor-${sha256Hex(logicalAddress).slice(0, 40)}`;
    const existing = anchors.get(address);
    if (existing !== undefined && canonicalize(existing) !== canonicalize(artifact)) {
      throw new Error("anchor conflict");
    }
    anchors.set(address, structuredClone(artifact));
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
          blockRef: { id: "block:42", height: "42" },
          evidence: { kind: "demos-bft-write-proof-v1", value: "proof" },
        })),
        verifyDemosAnchorReceipt: vi.fn(async () => true),
        readAnchor: vi.fn(async (address: string) =>
          structuredClone(anchors.get(address) ?? null)),
      },
    },
  } as never;
  const session = {
    factsVersion: "1",
    role: "buyer",
    jobId: JOB_ID,
    localBindingHash: loaded.record.localBindingHash,
    buyerIdentity: identity(BUYER),
    sellerIdentity: identity(SELLER),
    buyerRequirementHash: sha256Hex(canonicalize(app.listing.buyerRequirement)),
    buyerVetRecord: {},
    buyerVetRef: vetRef("buyer", SELLER),
    buyerVetReceipt: {},
    sellerRequirementHash: sha256Hex(canonicalize(
      DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
    )),
    sellerVetRecord: {},
    sellerVetRef: vetRef("seller", BUYER),
    sellerVetReceipt: {},
  } as never;
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
        payeeAddress: `0x${"33".repeat(20)}`,
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
    expect(reconciled.value.artifact).toEqual(artifact);
    expect(value.anchorWriteOnce).toHaveBeenCalledTimes(2);
    await expect(policy.anchor.verifyAnchorReceipt({
      expectedWriter: BUYER,
      ref: reconciled.value.ref,
      receipt: reconciled.value.anchorReceipt,
    })).resolves.toBe("valid");
    expect(policy.authorizeAnchored({
      operation: value.operation,
      retained: value.retained,
      result: {
        agreement: reconciled.value.artifact,
        agreementHash,
        agreementRef: reconciled.value.ref,
        anchorReceipt: reconciled.value.anchorReceipt,
      },
    })).toBe(true);
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
    const buyerVetRef = vetRef("buyer", SELLER);
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
      buyer: { identityBundle: identity(BUYER), vetRecordRef: buyerVetRef },
      seller: { identityBundle: identity(SELLER), vetRecordRef: sellerVetRef },
      selectedRail: value.app.listing.acceptedRails![0],
      payoutBindings: [{
        railId: "x402:test",
        phaseIndex: 2,
        payeeAddress: `0x${"33".repeat(20)}`,
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
        buyerIdentity: identity(BUYER),
        sellerIdentity: identity(SELLER),
        buyerRequirementHash: sha256Hex(canonicalize(value.app.listing.buyerRequirement)),
        buyerVetRecord: {},
        buyerVetRef,
        buyerVetReceipt: {},
      },
      sellerVet: { record: sellerVetRecord, recordRef: sellerVetRef, anchorReceipt: {} },
      sellerRequirement: DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
    } as never;
    const resolved = policy.resolveAuthenticatedAgreementContext(base);
    expect(resolved).toEqual({
      disposition: "present",
      value: expect.any(Object),
    });
    if (resolved.disposition !== "present") throw new Error("context missing");
    expect(deriveFixedPriceAgreement(resolved.value)).toEqual(candidateDraft);

    expect(policy.resolveAuthenticatedAgreementContext({
      ...base,
      listingPin: { ...candidateDraft.listingRef, contentHash: "9".repeat(64) },
    })).toMatchObject({ disposition: "rejected" });
  });
});
