import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  canonicalize,
  deriveFixedPriceAgreement,
  isAgreementArtifact,
  isAgreementDocument,
  isListing,
  isPayeeBoundAgreementDocument,
  negotiablePriceBand,
  signFixedPriceAgreement,
  type AgreementArtifact,
  type FixedPriceAgreementInput,
  type Listing,
} from "../../src/index.js";

import {
  BUYER,
  NOW,
  SELLER,
  identity,
  input,
  listing,
  payeeBoundInput,
  rail,
} from "./fixedPriceFixtures.js";

// One negative case per comparison arm: each guard below has a sibling that
// would otherwise refuse the same input, so a composite case cannot tell
// whether this one still runs.

function repinned(value: Listing): FixedPriceAgreementInput {
  return input(value);
}

async function signed(base: FixedPriceAgreementInput): Promise<AgreementArtifact> {
  return signFixedPriceAgreement(
    deriveFixedPriceAgreement(base),
    { party: BUYER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
    { party: SELLER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
  );
}

describe("fixed-price derivation guards (DACS-1 §6.3.4, DACS-3 §8.4.1/§8.5)", () => {
  test("the LR-1 pin is compared on listingId, version, and contentHash independently", () => {
    const wrongId = input();
    wrongId.verifiedListing.pin.listingId = "other-listing";
    expect(() => deriveFixedPriceAgreement(wrongId)).toThrow(/pin does not match/);

    const wrongVersion = input();
    wrongVersion.verifiedListing.pin.version += 1;
    expect(() => deriveFixedPriceAgreement(wrongVersion)).toThrow(/pin does not match/);

    const wrongHash = input();
    wrongHash.verifiedListing.pin.contentHash = "b".repeat(64);
    expect(() => deriveFixedPriceAgreement(wrongHash)).toThrow(/pin does not match/);

    expect(deriveFixedPriceAgreement(input()).listingRef).toEqual(
      input().verifiedListing.pin,
    );
  });

  test("a Listing is refused before notBefore and accepted from it", () => {
    const early = { ...input(), generatedAt: NOW - 1_001 };
    expect(() => deriveFixedPriceAgreement(early)).toThrow(/validity window/);
    expect(() =>
      deriveFixedPriceAgreement({ ...input(), generatedAt: NOW - 1_000 }),
    ).not.toThrow();
  });

  test("an auto-accept Listing never yields an ordinary Agreement", () => {
    const value = listing();
    value.terms = { ...value.terms, acceptanceModel: "auto-accept" };
    expect(isListing(value)).toBe(true);
    expect(() => deriveFixedPriceAgreement(repinned(value))).toThrow(/auto-accept/);
  });

  test("every pay phase must bind the selected rail", () => {
    const value = listing();
    const other = { ...rail, railId: "x402:other" };
    value.acceptedRails = [rail, other];
    value.pipeline[2] = { kind: "pay-x402", parameters: { rail: other.railId } };
    expect(isListing(value)).toBe(true);
    expect(() => deriveFixedPriceAgreement(repinned(value))).toThrow(
      /does not bind selected rail/,
    );
  });

  test("a valid RFQ Listing is never signed as a fixed-price Agreement", () => {
    const value = listing();
    value.pipeline[0] = {
      kind: "negotiate-rfq",
      parameters: { maxTurns: 2, timeoutSec: 60 },
    };
    value.pricing = {
      kind: "negotiable",
      bandCenter: { amount: "2.5", currency: "USDC" },
      minPct: 10,
      maxPct: 20,
    };
    expect(isListing(value)).toBe(true);
    expect(() => deriveFixedPriceAgreement(repinned(value))).toThrow(
      /exactly one negotiate-fixed-price phase/,
    );
  });

  test("the derivation re-validates the Listing it was handed", () => {
    const unsigned = listing() as unknown as Record<string, unknown>;
    delete unsigned.signature;
    expect(isListing(unsigned)).toBe(false);
    expect(() =>
      deriveFixedPriceAgreement(repinned(unsigned as unknown as Listing)),
    ).toThrow(/invalid wire shape/);
  });

  test("a party bundle whose presentedBy is not a carried claim is refused (BP-3)", () => {
    const bundle = identity(BUYER);
    bundle.claims = [{ ref: `${BUYER}0` }];
    bundle.presentation = {
      kind: "per-claim",
      signatures: [{ ref: `${BUYER}0`, signature: "identity-proof" }],
    };
    const value = input();
    value.buyer = { ...value.buyer, identityBundle: bundle };
    expect(() => deriveFixedPriceAgreement(value)).toThrow(
      /buyer IdentityBundle is not a normative DACS-1 bundle/,
    );
  });

  test("a supplied encryptionKey is carried on its party", () => {
    const value = input();
    value.buyer = { ...value.buyer, encryptionKey: "buyer-x25519-key" };
    const parties = deriveFixedPriceAgreement(value).parties;
    expect(parties.find((party) => party.role === "buyer")?.encryptionKey).toBe(
      "buyer-x25519-key",
    );
    expect(parties.find((party) => party.role === "seller")).not.toHaveProperty(
      "encryptionKey",
    );
  });

  test("payout bindings must cover every pay phase, not only some", () => {
    const value = listing("commit-payee-bound-agreement");
    value.pipeline = [
      ...value.pipeline,
      { kind: "pay-x402", parameters: { rail: rail.railId } },
    ];
    expect(isListing(value)).toBe(true);
    const partial = {
      ...repinned(value),
      payoutBindings: [{ railId: rail.railId, phaseIndex: 2, payeeAddress: "0xseller" }],
    };
    expect(() => deriveFixedPriceAgreement(partial)).toThrow(
      /cover every pay phase exactly once/,
    );
    const full = {
      ...partial,
      payoutBindings: [
        ...partial.payoutBindings,
        { railId: rail.railId, phaseIndex: 4, payeeAddress: "0xseller" },
      ],
    };
    expect(deriveFixedPriceAgreement(full).terms).toHaveProperty("payoutBindings");
  });

  test("a band whose lower bound rounds to zero is refused (§8.5.2 check 2)", () => {
    const pricing = {
      kind: "negotiable" as const,
      bandCenter: { amount: "0.01", currency: "USDC" },
      minPct: 99.9,
      maxPct: 10,
    };
    expect(() => negotiablePriceBand(pricing)).toThrow(
      /price band must have a positive lower bound/,
    );
    expect(negotiablePriceBand({ ...pricing, minPct: 50 })).toEqual({
      lower: "0.01",
      upper: "0.01",
    });
  });
});

describe("fixed-price boundaries and signer-input isolation", () => {
  test("a Listing is accepted at notAfter and refused one millisecond later", () => {
    const value = listing();
    const notAfter = value.validity.notAfter!;
    expect(() =>
      deriveFixedPriceAgreement({ ...repinned(value), generatedAt: notAfter }),
    ).not.toThrow();
    expect(() =>
      deriveFixedPriceAgreement({ ...repinned(value), generatedAt: notAfter + 1 }),
    ).toThrow(/validity window/);
  });

  test("a derived deadline beyond unix-ms safe integers is refused", () => {
    const value = listing();
    value.terms = { ...value.terms, deadlineSecAfterCommit: Math.floor(Number.MAX_SAFE_INTEGER / 1_000) };
    expect(isListing(value)).toBe(true);
    expect(() => deriveFixedPriceAgreement(repinned(value))).toThrow(
      /derived deadline overflows unix ms/,
    );
  });

  test.each<[string, (bytes: Uint8Array, context: Record<string, unknown>) => void]>([
    ["signed bytes", (bytes) => { bytes[0] = (bytes[0] ?? 0) ^ 0xff; }],
    ["party", (_bytes, context) => { context.party = "did:demos:agent:mutated"; }],
    ["algorithm", (_bytes, context) => { context.algorithm = "ecdsa-secp256k1"; }],
    ["context members", (_bytes, context) => { context.extra = true; }],
  ])("a buyer signer that changes its %s alone is refused before the seller signs", async (
    _name,
    mutate,
  ) => {
    let sellerInvoked = false;
    await expect(
      signFixedPriceAgreement(
        deriveFixedPriceAgreement(input()),
        {
          party: BUYER,
          algorithm: "ed25519",
          sign: (bytes, context) => {
            mutate(bytes, context as unknown as Record<string, unknown>);
            return new Uint8Array(64);
          },
        },
        {
          party: SELLER,
          algorithm: "ed25519",
          sign: () => {
            sellerInvoked = true;
            return new Uint8Array(64);
          },
        },
      ),
    ).rejects.toThrow(/must not mutate its signing inputs/);
    expect(sellerInvoked).toBe(false);
  });
});

describe("DACS-1 §6.3.4 LR-2 Listing size cap", () => {
  test("a canonical Listing of 16,384 bytes is accepted and 16,385 refused", () => {
    const sized = (bytes: number): Listing => {
      // Pad an unused accepted rail; every bounded text field is far smaller.
      const value = listing();
      const padded = { railId: "x402:padded", railVersion: 1, parameters: { pad: "" } };
      value.acceptedRails = [rail, padded];
      const base = Buffer.byteLength(canonicalize(value), "utf8");
      padded.parameters.pad = "x".repeat(bytes - base);
      expect(Buffer.byteLength(canonicalize(value), "utf8")).toBe(bytes);
      return value;
    };
    expect(isListing(sized(16_384))).toBe(true);
    expect(isListing(sized(16_385))).toBe(false);
  });
});

describe("DACS-3 §8.5 exactly one Agreement discriminator", () => {
  const IDENTITY_BOUND = [
    "identityBoundAgreementVersion",
    "identityBoundPayeeAgreementVersion",
  ] as const;

  const SECOND_VERSIONS = ["1", "2", null, 1] as const;

  test.each(["payeeBoundAgreementVersion", ...IDENTITY_BOUND].flatMap(
    (member) => SECOND_VERSIONS.map((version) => [member, version] as const),
  ))("a legacy Agreement refuses %s=%j", async (member, version) => {
    const agreement = await signed(input());
    expect(isAgreementDocument(agreement)).toBe(true);
    const ambiguous = { ...agreement, [member]: version };
    expect(isAgreementDocument(ambiguous)).toBe(false);
    expect(isPayeeBoundAgreementDocument(ambiguous)).toBe(false);
    expect(isAgreementArtifact(ambiguous)).toBe(false);
  });

  test.each(["agreementVersion", ...IDENTITY_BOUND].flatMap(
    (member) => SECOND_VERSIONS.map((version) => [member, version] as const),
  ))("a payee-bound Agreement refuses %s=%j", async (member, version) => {
    const agreement = await signed(payeeBoundInput());
    expect(isPayeeBoundAgreementDocument(agreement)).toBe(true);
    const ambiguous = { ...agreement, [member]: version };
    expect(isAgreementDocument(ambiguous)).toBe(false);
    expect(isPayeeBoundAgreementDocument(ambiguous)).toBe(false);
    expect(isAgreementArtifact(ambiguous)).toBe(false);
  });

  test("an omitted or unsupported discriminator version is refused", async () => {
    for (const [agreement, member] of [
      [await signed(input()), "agreementVersion"],
      [await signed(payeeBoundInput()), "payeeBoundAgreementVersion"],
    ] as const) {
      const omitted = { ...agreement } as Record<string, unknown>;
      delete omitted[member];
      expect(isAgreementArtifact(omitted), member).toBe(false);
      for (const version of ["2", "0", 1, ""]) {
        expect(
          isAgreementArtifact({ ...agreement, [member]: version }),
          `${member}=${String(version)}`,
        ).toBe(false);
      }
    }
  });

  test("an identity-bound discriminator alone is not read as a supported shape", async () => {
    const { agreementVersion: _legacy, ...rest } =
      (await signed(input())) as unknown as Record<string, unknown>;
    for (const member of IDENTITY_BOUND) {
      expect(isAgreementArtifact({ ...rest, [member]: "1" }), member).toBe(false);
    }
  });

  test("documents the existing reader refusal of parsed negative zero", async () => {
    const agreement = await signed(input());
    const additionalTerms: unknown = JSON.parse('{"acme:rating:v1":-0}');
    expect(Object.is((additionalTerms as Record<string, unknown>)["acme:rating:v1"], -0)).toBe(true);
    expect(isAgreementArtifact({ ...agreement, terms: { ...agreement.terms, additionalTerms } })).toBe(false);
  });

  test("replays every discriminator rejection in the pinned IBH vector set", () => {
    // DACS-Standard d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20.
    const vectors = JSON.parse(readFileSync(new URL(
      "../../vendor/DACS-Standard/conformance/vectors/security/identity-bundle-hash-binding-v0.1.json",
      import.meta.url,
    ), "utf8")) as {
      scenarios: Record<string, { agreement: Record<string, unknown> }>;
      vectors: { name: string; scenario: string; expected: string; mutations: {
        op: string; path: string[]; value?: unknown;
      }[] }[];
    };
    const discriminators = vectors.vectors.filter((v) => v.name.startsWith("discriminator-"));
    expect(discriminators).toHaveLength(6);
    for (const vector of discriminators) {
      expect(vector.expected).toBe("fail");
      const agreement = structuredClone(vectors.scenarios[vector.scenario]!.agreement);
      for (const mutation of vector.mutations) {
        expect(mutation.path).toHaveLength(2);
        expect(mutation.path[0]).toBe("agreement");
        const member = mutation.path[1]!;
        if (mutation.op === "delete") delete agreement[member];
        else {
          expect(mutation.op).toBe("set");
          agreement[member] = mutation.value;
        }
      }
      expect(isAgreementDocument(agreement), vector.name).toBe(false);
      expect(isPayeeBoundAgreementDocument(agreement), vector.name).toBe(false);
      expect(isAgreementArtifact(agreement), vector.name).toBe(false);
    }
  });
});
