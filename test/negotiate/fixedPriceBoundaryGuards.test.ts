import { describe, expect, test } from "vitest";

import {
  deriveFixedPriceAgreement,
  deriveMeteredPriceTerm,
  negotiablePriceBand,
  signFixedPriceAgreement,
  type Listing,
  type MeteredQuantityInput,
  type PayoutBinding,
} from "../../src/index.js";
import { BUYER, SELLER, FIXTURES, input, payeeBoundInput, rail } from "./fixedPriceFixtures.js";

type MeteredPricing = Extract<Listing["pricing"], { kind: "metered" }>;
type NegotiablePricing = Extract<Listing["pricing"], { kind: "negotiable" }>;

describe("metered price input guards", () => {
  const pricing = (): MeteredPricing => ({
    kind: "metered", unit: "request", unitPrice: { amount: "0.05", currency: "USDC" },
  });
  const quantity = (): MeteredQuantityInput => ({ quantity: "1", unit: "request" });

  test.each([
    ["0.05", "1", "0.05"],
    ["0.005", "2", "0.01"],
    ["0.001", "5", "0.005"],
    ["0.25", "2", "0.5"],
    ["0.000001", "3", "0.000003"],
    ["0.000001", "1", "0.000001"],
    ["0.05", "21", "1.05"],
  ])("pads the exact product %s × %s to %s", (unitPrice, count, total) => {
    const value = pricing();
    value.unitPrice.amount = unitPrice;
    expect(deriveMeteredPriceTerm(value, { ...quantity(), quantity: count }))
      .toEqual({ amount: total, currency: "USDC" });
  });

  test.each<[string, (p: MeteredPricing) => void, RegExp]>([
    ["wrong kind", (p) => { p.kind = "fixed" as never; }, /non-empty unit/],
    ["non-string unit", (p) => { p.unit = 1 as never; }, /non-empty unit/],
    ["empty unit", (p) => { p.unit = ""; }, /non-empty unit/],
    ["zero price", (p) => { p.unitPrice.amount = "0"; }, /positive CD-1/],
    ["noncanonical price", (p) => { p.unitPrice.amount = "0.050"; }, /positive CD-1/],
    ["non-string currency", (p) => { p.unitPrice.currency = 1 as never; }, /currency must be non-empty/],
    ["empty currency", (p) => { p.unitPrice.currency = ""; }, /currency must be non-empty/],
    ["zero minimum", (p) => { p.minTotal = { amount: "0", currency: "USDC" }; }, /minTotal must be a positive/],
    ["noncanonical minimum", (p) => { p.minTotal = { amount: "0.10", currency: "USDC" }; }, /minTotal must be a positive/],
    ["minimum currency", (p) => { p.minTotal = { amount: "1", currency: "EUR" }; }, /min-total-currency-mismatch/],
  ])("refuses %s independently", (_label, change, error) => {
    const p = pricing();
    change(p);
    expect(() => deriveMeteredPriceTerm(p, quantity())).toThrow(error);
  });

  test.each([1, "01", "-1", "+1", "1.0", "1e1", "", " 1"])(
    "refuses noncanonical quantity %j", (count) => {
      expect(() => deriveMeteredPriceTerm(pricing(), { ...quantity(), quantity: count as string }))
        .toThrow(/non-canonical-metered-quantity/);
    },
  );

  test("requires the exact unit and a positive total", () => {
    expect(() => deriveMeteredPriceTerm(pricing(), { quantity: "1", unit: "byte" }))
      .toThrow(/metered-unit-mismatch/);
    expect(() => deriveMeteredPriceTerm(pricing(), { ...quantity(), quantity: "0" }))
      .toThrow(/total must be positive/);
    const minimum = { ...pricing(), minTotal: { amount: "0.1", currency: "USDC" } };
    expect(deriveMeteredPriceTerm(minimum, { ...quantity(), quantity: "0" }).amount).toBe("0.1");
    expect(deriveMeteredPriceTerm(minimum, { ...quantity(), quantity: "3" }).amount).toBe("0.15");
    expect(deriveMeteredPriceTerm(minimum, { ...quantity(), quantity: "2" }).amount).toBe("0.1");
  });
});

describe("negotiable band decimal expansion", () => {
  const pricing = (): NegotiablePricing => ({
    kind: "negotiable", bandCenter: { amount: "1000000000", currency: "USDC" },
    minPct: 1e-7, maxPct: 1.25e-7,
  });

  test("expands exponent percentages before exact money arithmetic", () => {
    expect(negotiablePriceBand(pricing())).toEqual({ lower: "999999999", upper: "1000000001" });
    expect(negotiablePriceBand({ ...pricing(), minPct: 0, maxPct: 0 }))
      .toEqual({ lower: "1000000000", upper: "1000000000" });
    expect(negotiablePriceBand({ ...pricing(), minPct: 5e-8, maxPct: 5e-8 }))
      .toEqual({ lower: "1000000000", upper: "1000000001" });
  });

  test.each([
    [1e-7, 1e-7, "999999999", "1000000001"],
    [2.5e-7, 1e-7, "999999998", "1000000001"],
    [10, 2e-7, "900000000", "1000000002"],
  ] as const)("replays exponent-band probe min=%s max=%s", (minPct, maxPct, lower, upper) => {
    expect(negotiablePriceBand({ ...pricing(), minPct, maxPct })).toEqual({ lower, upper });
  });

  test.each<[string, unknown]>([
    ["wrong kind", { ...pricing(), kind: "fixed" }],
    ["null", null], ["array", []],
    ["null centre", { ...pricing(), bandCenter: null }],
    ["array centre", { ...pricing(), bandCenter: [] }],
    ["zero centre", { ...pricing(), bandCenter: { amount: "0", currency: "USDC" } }],
    ["noncanonical centre", { ...pricing(), bandCenter: { amount: "1.0", currency: "USDC" } }],
    ["empty currency", { ...pricing(), bandCenter: { amount: "1", currency: "" } }],
    ["non-string currency", { ...pricing(), bandCenter: { amount: "1", currency: 1 } }],
    ["negative minPct", { ...pricing(), minPct: -1 }],
    ["negative maxPct", { ...pricing(), maxPct: -1 }],
    ["100 percent minimum", { ...pricing(), minPct: 100 }],
  ])("refuses %s", (_label, value) => {
    expect(() => negotiablePriceBand(value as NegotiablePricing)).toThrow();
  });
});

describe("payout and party derivation boundaries", () => {
  test.each<[string, (binding: PayoutBinding) => void]>([
    ["wrong rail", (b) => { b.railId = "x402:other"; }],
    ["wrong phase", (b) => { b.phaseIndex = 1; }],
    ["string phase", (b) => { b.phaseIndex = "2" as never; }],
    ["fractional phase", (b) => { b.phaseIndex = 2.5; }],
    ["negative phase", (b) => { b.phaseIndex = -2; }],
    ["empty payee", (b) => { b.payeeAddress = ""; }],
    ["non-string payee", (b) => { b.payeeAddress = 1 as never; }],
  ])("refuses a payout tuple with %s", (_label, change) => {
    const value = payeeBoundInput();
    change(value.payoutBindings![0]!);
    expect(() => deriveFixedPriceAgreement(value)).toThrow(/missing, duplicate, or extra pay tuple/);
  });

  test("refuses duplicate payout tuples even when the count is correct", () => {
    const value = payeeBoundInput();
    const exactListing = value.verifiedListing.listing;
    exactListing.pipeline.push({ kind: "pay-x402", parameters: { rail: rail.railId } });
    const bound = { ...input(exactListing), payoutBindings: [value.payoutBindings![0]!, { ...value.payoutBindings![0]! }] };
    expect(() => deriveFixedPriceAgreement(bound)).toThrow(/missing, duplicate, or extra pay tuple/);
  });

  test("zero-pay drafts omit rail, and payee-bound drafts refuse any payout tuple", () => {
    const zero = FIXTURES["zero-pay"]!();
    expect(deriveFixedPriceAgreement(zero).terms).not.toHaveProperty("rail");
    zero.verifiedListing.listing.pipeline[1] = { kind: "commit-payee-bound-agreement" };
    const payee = { ...input(zero.verifiedListing.listing), selectedRail: undefined };
    delete payee.selectedRail;
    expect(deriveFixedPriceAgreement(payee).terms).toHaveProperty("payoutBindings", []);
    expect(() => deriveFixedPriceAgreement({ ...payee, payoutBindings: payeeBoundInput().payoutBindings }))
      .toThrow(/cannot target a non-pay phase/);
    expect(() => deriveFixedPriceAgreement({ ...input(), payoutBindings: payeeBoundInput().payoutBindings }))
      .toThrow(/MUST NOT carry payoutBindings/);
  });

  test.each(["buyer", "seller"] as const)("refuses malformed %s vet reference and empty encryption key", (role) => {
    const badRef = input();
    badRef[role].vetRecordRef.contentHash = "invalid";
    expect(() => deriveFixedPriceAgreement(badRef)).toThrow(/vetRecordRef/);
    const emptyKey = input();
    emptyKey[role].encryptionKey = "";
    expect(() => deriveFixedPriceAgreement(emptyKey)).toThrow(/encryptionKey must be non-empty/);
  });
});

describe("agreement validation precedes both signer effects", () => {
  test.each(["buyer", "seller", "pattern", "signatures", "signature"] as const)(
    "invalid %s never invokes either signer", async (member) => {
      const draft = deriveFixedPriceAgreement(input());
      if (member === "pattern") draft.derivedFromPattern = "rfq";
      if (member === "signature" || member === "signatures") Object.assign(draft, { [member]: [] });
      let calls = 0;
      const signer = (party: string) => ({ party, algorithm: "ed25519" as const, sign: () => {
        calls += 1;
        return new Uint8Array(64);
      } });
      await expect(signFixedPriceAgreement(
        draft, signer(member === "buyer" ? SELLER : BUYER), signer(member === "seller" ? BUYER : SELLER),
      )).rejects.toThrow();
      expect(calls).toBe(0);
    },
  );
});
