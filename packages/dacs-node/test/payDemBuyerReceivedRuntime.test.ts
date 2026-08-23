import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ retained: vi.fn() }));

vi.mock("../src/orderInput.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/orderInput.js")>()),
  loadDacsLiveOrderInputForTrackV1: dependencies.retained,
}));

import {
  canonicalize,
  contentHash,
  listingAddress,
  sha256Hex,
} from "@kynesyslabs/dacs/canonical";
import {
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
} from "@kynesyslabs/dacs/commerce";

import { createDacsFixedPricePayDemRoleOrderV1 } from "../src/liveOrder.js";
import { createDacsPayDemBuyerReceivedTrackV1 } from
  "../src/payDemBuyerReceivedRuntime.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_KEY = "11".repeat(32);
const SELLER_KEY = "22".repeat(32);
const BUYER = `did:demos:agent:${BUYER_KEY}`;
const SELLER = `did:demos:agent:${SELLER_KEY}`;
const NATIVE_ADDRESS = `stor-${"a".repeat(40)}`;

const protocol = {
  commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  phase: "pay-dem" as const,
  orchestratorTopology: "seller-as-phase-orchestrator-v1" as const,
  orchestrator: SELLER,
  rail: {
    registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
    registryIndexHash: "1".repeat(64),
    railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
    railDefinitionHash: "2".repeat(64),
    railId: "demos-native:DEM",
    railVersion: 1,
    railType: "demos-native" as const,
    phaseHandler: "pay-dem" as const,
    network: "demos" as const,
    availability: "live" as const,
  },
};

const inputOrder = createDacsFixedPricePayDemRoleOrderV1({
  role: "buyer", jobId: JOB_ID, buyer: BUYER, seller: SELLER, protocol,
});
const order = {
  ...inputOrder,
  role: "buyer",
  storeVersion: "1",
  revision: 1,
  bindingHash: "3".repeat(64),
  localBindingHash: "4".repeat(64),
  tracks: {},
  createdAt: 1,
  updatedAt: 1,
} as const;
const listing = {
  dacsVersion: "1",
  listingVersion: 1,
  listingId: "native-result",
  seller: {
    identity: {
      bundleVersion: "1",
      presentedBy: SELLER,
      presentedAt: 1,
      claims: [{ ref: SELLER }],
      presentation: { kind: "per-claim", signatures: [{ ref: SELLER, signature: "c2ln" }] },
    },
    displayName: "Seller",
    publicEndpoint: "https://seller.example",
  },
  offering: {
    title: "Result",
    description: "Native result",
    category: "software",
    tags: ["native"],
    deliverable: { kind: "storage-program", accessModel: "public" },
  },
  buyerRequirement: { requirementVersion: "1", required: [] },
  pipeline: [
    { kind: "negotiate-fixed-price" },
    { kind: "commit-payee-bound-agreement" },
    { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } },
    { kind: "deliver-storage-program" },
  ],
  pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
  acceptedRails: [{
    railId: "demos-native:DEM",
    railVersion: 1,
    parameters: { network: "demos", payTo: SELLER_KEY },
  }],
  terms: { deadlineSecAfterCommit: 3_600 },
  validity: { notBefore: 0, notAfter: 10_000 },
  signature: { algorithm: "ed25519", signer: SELLER, value: "c2ln" },
} as const;
const listingContentHash = contentHash(listing as unknown as Record<string, unknown>);
const application = {
  applicationVersion: "1",
  listingRef: NATIVE_ADDRESS,
  listingContentHash,
  listingLogicalAddress: listingAddress(SELLER, listing.listingId, listing.listingVersion),
  listing,
  requestHash: sha256Hex(canonicalize({ requestVersion: "1" })),
  request: { requestVersion: "1" },
} as const;

function operation(track: "buyer-received" | "payment" = "buyer-received") {
  return {
    order,
    fence: {
      role: "buyer",
      track,
      jobId: JOB_ID,
      bindingHash: order.bindingHash,
      localBindingHash: order.localBindingHash,
      assertCurrent: vi.fn(),
    },
  } as const;
}

describe("native DEM buyer received track", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.retained.mockReturnValue({
      jobId: JOB_ID,
      localBindingHash: order.localBindingHash,
      order: inputOrder,
      application,
    });
  });

  it("authenticates and durably replays the seller's exact public anchor", async () => {
    const effects = new Map<string, unknown>();
    const payload = { result: "native DEM delivered" };
    const logicalAddress = `dacs4:deliverable:${JOB_ID}`;
    const adapter = {
      resolveAnchorByName: vi.fn(async () => ({
        status: "present" as const, address: NATIVE_ADDRESS,
      })),
      readAnchor: vi.fn(async () => payload),
      resolveDemosAnchorReceipt: vi.fn(async () => ({
        nativeAddress: NATIVE_ADDRESS,
        logicalAddress,
        contentHash: contentHash(payload),
        writer: SELLER,
        state: "finalized" as const,
        observationDisposition: "established" as const,
        observedAt: 90,
      })),
      verifyDemosAnchorReceipt: vi.fn(async () => true),
    };
    const authorizeReceived = vi.fn(() => true);
    const track = createDacsPayDemBuyerReceivedTrackV1({
      context: {
        role: "buyer",
        database: {
          readTime: () => 100,
          loadEffectInput: (_kind: string, id: string) => effects.get(id),
          putEffectIntent: (input: { effectId: string; input: unknown }) => {
            effects.set(input.effectId, structuredClone(input.input));
            return { status: "created" as const };
          },
        },
        demos: { adapter },
      } as never,
      authorizeReceived,
    });
    const first = await track(operation() as never);
    const second = await track(operation() as never);

    expect(first).toEqual({
      status: "final",
      outcome: "success",
      reference: logicalAddress,
      authenticationHash: contentHash(payload),
    });
    expect(second).toEqual(first);
    expect(adapter.resolveAnchorByName).toHaveBeenCalledTimes(1);
    expect(adapter.resolveAnchorByName).toHaveBeenCalledWith(logicalAddress, SELLER_KEY);
    expect(authorizeReceived).toHaveBeenCalledTimes(2);
    expect(authorizeReceived).toHaveBeenLastCalledWith(expect.objectContaining({
      payload,
      record: expect.objectContaining({
        nativeAddress: NATIVE_ADDRESS,
        contentHash: contentHash(payload),
      }),
    }));
  });

  it("rejects a coordinator-track substitution before touching Demos", async () => {
    const adapter = { resolveAnchorByName: vi.fn() };
    const track = createDacsPayDemBuyerReceivedTrackV1({
      context: { role: "buyer", demos: { adapter } } as never,
      authorizeReceived: () => true,
    });
    await expect(track(operation("payment") as never)).resolves.toEqual({
      status: "operator-action",
      reasonCode: "pay-dem-buyer-received-track-binding-mismatch",
    });
    expect(adapter.resolveAnchorByName).not.toHaveBeenCalled();
  });
});
