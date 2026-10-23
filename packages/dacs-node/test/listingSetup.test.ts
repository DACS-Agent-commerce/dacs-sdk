import { generateKeyPairSync, sign } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticated = vi.hoisted(() => ({ value: true }));
vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  isAuthenticatedRailDefinition: () => authenticated.value,
  getAuthenticatedRailProvenance: () => authenticated.value ? { registryVersion: 1 } : null,
}));

import { rawPublicKey, signedBytes } from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef, identityBundleHash } from "@kynesyslabs/dacs/identity";
import type { ListingDraft } from "@kynesyslabs/dacs/artifacts";

import {
  createDacsListingSetupExecutorV1,
  prepareDacsListingSetupV1,
} from "../src/listingSetup.js";

const PAYEE = `0x${"2".repeat(40)}`;
const ASSET = `0x${"3".repeat(40)}`;
const RESOURCE = "https://seller.example/buy";
const LISTING_REF = `stor-${"4".repeat(40)}`;

function fixture() {
  const sellerKeys = generateKeyPairSync("ed25519");
  const buyerKeys = generateKeyPairSync("ed25519");
  const publicKey = rawPublicKey(sellerKeys.publicKey);
  const sellerAuthority = demosAgentClaimRef(publicKey);
  const buyerAuthority = demosAgentClaimRef(rawPublicKey(buyerKeys.publicKey));
  const bundle = {
    bundleVersion: "1" as const,
    presentedBy: sellerAuthority,
    presentedAt: 1_000,
    claims: [{ ref: sellerAuthority }],
    presentation: {
      kind: "per-claim" as const,
      signatures: [{ ref: sellerAuthority, signature: "pending" }],
    },
  };
  bundle.presentation.signatures[0]!.signature = sign(
    null,
    signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle)),
    sellerKeys.privateKey,
  ).toString("base64url");
  const draft = {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "generated-live-service",
    seller: { identity: bundle, displayName: "Generated seller", publicEndpoint: RESOURCE },
    offering: {
      title: "Generated result",
      description: "A bounded application result",
      category: "software.service",
      tags: ["dacs"],
      deliverable: { kind: "storage-program", accessModel: "public" },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:base-sepolia" } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "0.5", currency: "USDC" } },
    acceptedRails: [{
      railId: "x402:base-sepolia",
      railVersion: 1,
      parameters: {
        network: "eip155:84532",
        payTo: PAYEE,
        asset: ASSET,
        httpResource: RESOURCE,
      },
    }],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: 900, notAfter: 2_000 },
  };
  const rail = {
    railVersion: 1,
    railId: "x402:base-sepolia",
    railType: "x402",
    asset: { kind: "erc20", chainId: 84_532, contract: ASSET, symbol: "USDC", decimals: 6 },
    network: { kind: "x402-resource", resourceBaseUrl: RESOURCE },
    phaseHandler: "pay-x402",
    parameters: {},
    availability: "live",
    governance: { proposedBy: sellerAuthority, acceptedAt: 1, anchoring: "single-signer" },
    signature: { algorithm: "ed25519", signer: sellerAuthority, value: "A".repeat(86) },
  };
  let anchored: Record<string, unknown> | null = null;
  const adapter = {
    raw: {
      getNetworkInfo: vi.fn(), getAddressNonce: vi.fn(), getAddressInfo: vi.fn(),
    },
    connect: vi.fn(),
    getAddress: () => "seller-wallet",
    getPublicKey: async () => publicKey,
    sign: async (bytes: Uint8Array) => Uint8Array.from(sign(null, bytes, sellerKeys.privateKey)),
    resolveIdentity: vi.fn(),
    readAnchor: vi.fn(async (ref: string) => ref === LISTING_REF ? anchored : null),
    resolveAnchorByName: vi.fn(),
    scanOwnAnchorsByNamePrefix: vi.fn(async () => ({ status: "ok" as const, anchors: [] })),
    anchorWriteOnce: vi.fn(async (_name: string, value: object) => {
      anchored = structuredClone(value) as Record<string, unknown>;
      return { address: LISTING_REF, txRef: "tx-listing" };
    }),
    resolveDemosAnchorReceipt: vi.fn(async () => ({ receipt: true })),
    verifyDemosAnchorReceipt: vi.fn(async () => true),
  };
  const seller = {
    role: "seller" as const,
    authority: sellerAuthority,
    walletAddress: "seller-wallet",
    publicKey,
    adapter,
    signTransportEnvelope: vi.fn(),
    signComponent: async (bytes: Uint8Array) =>
      Uint8Array.from(sign(null, bytes, sellerKeys.privateKey)),
    networkInfo: vi.fn(), addressNonce: vi.fn(), addressInfo: vi.fn(),
  };
  return { draft, rail, seller, buyerAuthority, adapter };
}

describe("guarded Listing setup", () => {
  beforeEach(() => { authenticated.value = true; });

  it("binds a deterministic plan, authenticates readback and publishes discovery", async () => {
    const value = fixture();
    const prepared = await prepareDacsListingSetupV1({
      draft: value.draft,
      buyerAuthority: value.buyerAuthority,
      seller: value.seller as never,
      sellerPublicEndpoint: RESOURCE,
      sellerPayee: PAYEE,
      network: "eip155:84532",
      demosNetwork: "demos:testnet",
      rail: value.rail as never,
      maximumServiceAmount: "1",
      actionMaximumSpendDem: "2",
      safetyMarginDem: "1",
      maximumSpendDem: "10",
      now: 1_000,
    });
    expect(prepared.plan).toMatchObject({
      kind: "setup",
      actionSpendDem: "2",
      safetyMarginDem: "1",
      maximumSpendDem: "10",
      actions: [{ actionId: "publish-listing", maximumSpendDem: "2" }],
    });
    expect(Object.isFrozen(prepared.draft)).toBe(true);
    expect(Object.isFrozen(prepared.draft.seller.identity)).toBe(true);
    expect(() => {
      (prepared.draft.acceptedRails![0]!.parameters as { payTo: string }).payTo =
        `0x${"9".repeat(40)}`;
    }).toThrow();
    const publishActive = vi.fn(async () => ({
      status: "published" as const,
      indexHash: "a".repeat(64),
    }));
    const executor = createDacsListingSetupExecutorV1({
      prepared,
      seller: value.seller as never,
      rail: value.rail as never,
      discovery: { publishActive },
    });
    const assertCurrent = vi.fn(async () => undefined);
    await expect(executor({
      plan: prepared.plan,
      consent: {} as never,
      fence: {
        mode: "perform",
        effectId: prepared.plan.effectId,
        planHash: prepared.plan.planHash,
        generation: 1,
        idempotencyKey: "setup",
        assertCurrent,
      },
    })).resolves.toMatchObject({
      status: "completed",
      result: { listingRef: LISTING_REF, indexHash: "a".repeat(64) },
    });
    expect(assertCurrent).toHaveBeenCalledTimes(4);
    expect(value.adapter.anchorWriteOnce).toHaveBeenCalledTimes(1);
    expect(value.adapter.anchorWriteOnce).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      {
        metadata: {
          logicalAddress: expect.any(String),
          contentHash: prepared.plan.listingContentHash,
          envelopeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
    );
    expect(value.adapter.verifyDemosAnchorReceipt).toHaveBeenCalledTimes(1);
    expect(publishActive).toHaveBeenCalledTimes(1);
  });

  it("prepares a native DEM Listing without requiring any EVM configuration", async () => {
    const value = fixture();
    const sellerPayee = Buffer.from(value.seller.publicKey).toString("hex");
    const draft = structuredClone(value.draft) as unknown as ListingDraft;
    draft.listingId = "generated-live-service-pay-dem";
    draft.pipeline[2] = {
      kind: "pay-dem",
      parameters: { rail: "demos-native:DEM" },
    };
    draft.pricing = { kind: "fixed", price: { amount: "1", currency: "DEM" } };
    draft.acceptedRails = [{
      railId: "demos-native:DEM",
      railVersion: 1,
      parameters: { network: "demos", payTo: sellerPayee },
    }];
    const rail = {
      ...value.rail,
      railId: "demos-native:DEM",
      railType: "demos-native",
      asset: { kind: "native-dem", symbol: "DEM", decimals: 9 },
      network: { kind: "demos" },
      phaseHandler: "pay-dem",
    };
    const prepared = await prepareDacsListingSetupV1({
      draft,
      buyerAuthority: value.buyerAuthority,
      seller: value.seller as never,
      sellerPublicEndpoint: RESOURCE,
      sellerPayee,
      demosNetwork: "demos:testnet",
      rail: rail as never,
      maximumServiceAmount: "2",
      actionMaximumSpendDem: "2",
      safetyMarginDem: "1",
      maximumSpendDem: "10",
      now: 1_000,
    });
    expect(prepared.listing).toMatchObject({
      listingId: "generated-live-service-pay-dem",
      pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
      acceptedRails: [{ railId: "demos-native:DEM" }],
    });
    expect(prepared.plan.listingContentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enters durable reconciliation after an unauthenticated response boundary", async () => {
    const value = fixture();
    const prepared = await prepareDacsListingSetupV1({
      draft: value.draft,
      buyerAuthority: value.buyerAuthority,
      seller: value.seller as never,
      sellerPublicEndpoint: RESOURCE,
      sellerPayee: PAYEE,
      network: "eip155:84532",
      demosNetwork: "demos:testnet",
      rail: value.rail as never,
      maximumServiceAmount: "1",
      actionMaximumSpendDem: "2",
      safetyMarginDem: "1",
      maximumSpendDem: "10",
      now: 1_000,
    });
    value.adapter.resolveDemosAnchorReceipt.mockResolvedValue(null as never);
    const executor = createDacsListingSetupExecutorV1({
      prepared,
      seller: value.seller as never,
      rail: value.rail as never,
      discovery: { publishActive: vi.fn() },
    });
    const fence = {
      effectId: prepared.plan.effectId,
      planHash: prepared.plan.planHash,
      generation: 1,
      idempotencyKey: "setup",
      assertCurrent: async () => undefined,
    };
    await expect(executor({ plan: prepared.plan, consent: {} as never,
      fence: { ...fence, mode: "perform" } })).resolves.toEqual({
      status: "ambiguous",
      reasonCode: "listing-setup-reconciliation-required",
    });
    await expect(executor({ plan: prepared.plan, consent: {} as never,
      fence: { ...fence, mode: "reconcile" } })).resolves.toEqual({
      status: "reconciled-indeterminate",
      reasonCode: "listing-setup-reconciliation-required",
    });
  });

  it("rejects a non-contiguous Listing version during read-only preparation", async () => {
    const value = fixture();
    value.draft.listingVersion = 2;
    await expect(prepareDacsListingSetupV1({
      draft: value.draft,
      buyerAuthority: value.buyerAuthority,
      seller: value.seller as never,
      sellerPublicEndpoint: RESOURCE,
      sellerPayee: PAYEE,
      network: "eip155:84532",
      demosNetwork: "demos:testnet",
      rail: value.rail as never,
      maximumServiceAmount: "1",
      actionMaximumSpendDem: "2",
      safetyMarginDem: "1",
      maximumSpendDem: "10",
      now: 1_000,
    })).rejects.toThrow("listingVersion must advance monotonically without gaps");
    expect(value.adapter.anchorWriteOnce).not.toHaveBeenCalled();
  });

  it("does not classify a pre-write history failure as an ambiguous write", async () => {
    const value = fixture();
    const prepared = await prepareDacsListingSetupV1({
      draft: value.draft,
      buyerAuthority: value.buyerAuthority,
      seller: value.seller as never,
      sellerPublicEndpoint: RESOURCE,
      sellerPayee: PAYEE,
      network: "eip155:84532",
      demosNetwork: "demos:testnet",
      rail: value.rail as never,
      maximumServiceAmount: "1",
      actionMaximumSpendDem: "2",
      safetyMarginDem: "1",
      maximumSpendDem: "10",
      now: 1_000,
    });
    value.adapter.scanOwnAnchorsByNamePrefix.mockResolvedValue({
      status: "indeterminate",
      reason: "rpc-unavailable",
    } as never);
    const executor = createDacsListingSetupExecutorV1({
      prepared,
      seller: value.seller as never,
      rail: value.rail as never,
      discovery: { publishActive: vi.fn() },
    });
    await expect(executor({
      plan: prepared.plan,
      consent: {} as never,
      fence: {
        mode: "perform",
        effectId: prepared.plan.effectId,
        planHash: prepared.plan.planHash,
        generation: 1,
        idempotencyKey: "setup",
        assertCurrent: async () => undefined,
      },
    })).resolves.toEqual({
      status: "operator-action",
      reasonCode: "listing-setup-prewrite-failed",
    });
    expect(value.adapter.anchorWriteOnce).not.toHaveBeenCalled();
  });

  it("rejects a rail whose authenticated provenance has been lost", async () => {
    const value = fixture();
    const prepared = await prepareDacsListingSetupV1({
      draft: value.draft,
      buyerAuthority: value.buyerAuthority,
      seller: value.seller as never,
      sellerPublicEndpoint: RESOURCE,
      sellerPayee: PAYEE,
      network: "eip155:84532",
      demosNetwork: "demos:testnet",
      rail: value.rail as never,
      maximumServiceAmount: "1",
      actionMaximumSpendDem: "2",
      safetyMarginDem: "1",
      maximumSpendDem: "10",
      now: 1_000,
    });
    authenticated.value = false;
    expect(() => createDacsListingSetupExecutorV1({
      prepared,
      seller: value.seller as never,
      rail: structuredClone(value.rail) as never,
      discovery: { publishActive: vi.fn() },
    })).toThrow("Listing setup executor options are invalid");
    expect(value.adapter.anchorWriteOnce).not.toHaveBeenCalled();
  });
});
