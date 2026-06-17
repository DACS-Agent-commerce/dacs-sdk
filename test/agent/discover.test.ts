import { describe, expect, test } from "vitest";

import { discoverListings } from "../../src/agent/discover.js";

const LISTING = {
  agentId: "did:demos:agent:alice",
  serviceId: "svc",
  name: "Market Data",
  description: "d",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-x402"],
  supportedDelivery: ["deliver-attested-payload"],
  signature: "deadbeef",
};

const store: Record<string, Record<string, unknown>> = {
  "ref:1": LISTING,
  "ref:2": { not: "a listing" },
  "ref:3": { ...LISTING, agentId: "did:demos:agent:bob" },
};
const read = async (ref: string) => store[ref] ?? null;

describe("discoverListings (resolve + validate caller-supplied refs)", () => {
  test("returns only refs that resolve to valid listings, with the signature stripped", async () => {
    const found = await discoverListings(["ref:1", "ref:2", "missing", "ref:3"], read);
    expect(found.map((f) => f.ref)).toEqual(["ref:1", "ref:3"]);
    expect(found[0]!.listing.agentId).toBe("did:demos:agent:alice");
    // returned listing is the signed scope (signature omitted)
    expect("signature" in found[0]!.listing).toBe(false);
  });

  test("skips missing refs without throwing", async () => {
    expect(await discoverListings(["missing", "also-missing"], read)).toEqual([]);
  });

  test("empty input yields empty result", async () => {
    expect(await discoverListings([], read)).toEqual([]);
  });
});
