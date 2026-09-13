import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  application: undefined as unknown,
}));

vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  getAuthenticatedRailProvenance: () => ({ registryVersion: 7 }),
  isFinalizedVetAnchorReceipt: () => true,
}));

vi.mock("../src/fixedPriceX402Profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fixedPriceX402Profile.js")>()),
  captureDacsFixedPriceX402ApplicationV1: () => dependencies.application,
}));

import { createDacsFixedPriceVetTerminalInputFactoryV1 } from
  "../src/fixedPriceVetTerminal.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BINDING_HASH = "1".repeat(64);
const BUYER = `did:demos:agent:${"2".repeat(64)}`;
const SELLER = `did:demos:agent:${"3".repeat(64)}`;

function listing(pipeline: readonly Readonly<Record<string, unknown>>[]) {
  return {
    listingId: "terminal-listing",
    listingVersion: 3,
    pipeline,
  };
}

function input() {
  return {
    operation: {
      order: {
        jobId: JOB_ID,
        localBindingHash: BINDING_HASH,
        buyer: BUYER,
        seller: SELLER,
        createdAt: 1_800_000_000_000,
      },
    },
    retained: {
      jobId: JOB_ID,
      localBindingHash: BINDING_HASH,
      application: {},
    },
    buyerIdentity: { presentedBy: BUYER },
    sellerIdentity: { presentedBy: SELLER },
    evaluatedRole: "seller" as const,
    production: {
      record: { overallDecision: "fail" },
      recordRef: { ref: true },
      anchorReceipt: { state: "finalized" },
    },
    vetInvokedAt: 1_800_000_000_050,
  };
}

describe("fixed-price Vet terminal projection", () => {
  beforeEach(() => {
    dependencies.application = {
      listing: listing([
        { kind: "vet-credentials" },
        { kind: "negotiate-fixed-price" },
        { kind: "commit-agreement" },
        { kind: "pay-x402", parameters: { rail: "x402:test" } },
        { kind: "deliver-attested-payload" },
      ]),
      listingContentHash: "4".repeat(64),
    };
  });

  it("projects the exact signed Listing pipeline and authenticated registry versions", () => {
    const createInput = createDacsFixedPriceVetTerminalInputFactoryV1({
      rail: {} as never,
      recipeRegistryVersion: 11,
    });

    const projected = createInput(input() as never);

    expect(projected).toMatchObject({
      jobId: JOB_ID,
      listingRef: {
        listingId: "terminal-listing",
        version: 3,
        contentHash: "4".repeat(64),
      },
      vetPhaseIndex: 0,
      recipeRegistryVersion: 11,
      railRegistryVersion: 7,
      evaluatedRole: "seller",
    });
    expect(projected.pipeline).toEqual(
      (dependencies.application as { listing: { pipeline: unknown } }).listing.pipeline,
    );
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.pipeline)).toBe(true);
  });

  it.each([
    ["missing", [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:test" } },
      { kind: "deliver-attested-payload" },
    ]],
    ["duplicated", [
      { kind: "vet-credentials" },
      { kind: "vet-credentials" },
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:test" } },
      { kind: "deliver-attested-payload" },
    ]],
  ])("rejects a %s Vet phase instead of changing the signed pipeline", (_label, pipeline) => {
    dependencies.application = {
      listing: listing(pipeline),
      listingContentHash: "4".repeat(64),
    };
    const createInput = createDacsFixedPriceVetTerminalInputFactoryV1({
      rail: {} as never,
      recipeRegistryVersion: 11,
    });

    expect(() => createInput(input() as never)).toThrow(
      /session projection is invalid/,
    );
  });
});
