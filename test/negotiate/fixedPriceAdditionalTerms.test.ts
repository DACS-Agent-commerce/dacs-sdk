import { describe, expect, test } from "vitest";

import {
  ARTIFACT_SEPARATORS,
  canonicalize,
  contentHash,
  createFixedPriceAgreementSigningPlan,
  deriveFixedPriceAgreement,
  ed25519Sign,
  ed25519Verify,
  isAgreementArtifact,
  isAgreementDocument,
  isPayeeBoundAgreementDocument,
  privateKeyFromSeed,
  publicKeyFromSeed,
  sha256Hex,
  signFixedPriceAgreement,
  signedBytes,
  validateFixedPriceAgreementBinding,
  type AgreementArtifact,
  type FixedPriceAgreementInput,
  type UnsignedAgreementArtifact,
} from "../../src/index.js";

import {
  BUYER,
  BUYER_SEED,
  FIXTURES,
  NOW,
  SELLER,
  SELLER_SEED,
  input,
  payeeBoundInput,
} from "./fixedPriceFixtures.js";

// sha256(JCS(draft)) of every fixture, recorded from SDK main d1f0e60 before
// additionalTerms existed. An omitted field must keep these bytes exactly.
const MAIN_DRAFT_HASHES: Record<string, string> = {
  "fixed-commit-agreement":
    "f81007246df01b95d1be883b6ad8f03aa88346a66a4080dbc210c201955934dd",
  "negotiable-band-centre":
    "612bcb393a952d56ecea6ab84d958eb02d3e3ee9664ba2b59aff038732dbf557",
  metered: "1c2a34a567ada0919a96c15db7b8fa05290b64f6795cfb4a4897af0b07ced49e",
  "payee-bound":
    "a72afc936d9181ed321de1829e371f07811323e6258387ee7b1bab23e9b2a5c1",
  "zero-pay": "83c5bcbfb78ad3738eb54d27986cdf49be26f9a50ced892591f65c533e2b8e26",
  "deliverable-with-signature-member":
    "8a146d4c20494a527bdd7237e4be2a5df689d6d2077b876b12286b886e9ac25b",
  "seller-responder-plain":
    "11f7a40c4e7a170071c9b81bee461d06adaac571b1217ebbc0d89f4cb085c7dd",
  "seller-responder-payee-bound":
    "740bc7a572f4d215d6a2e8af6826290aa22ce043db55d8521a5c47d8aee6737c",
};

const REQUEST_KEY = "dacs-chatgpt-plugin:public-service-request:v1";
const REQUEST = {
  type: "public-data",
  serviceId: "public-text-report",
  version: "1",
  input: "Cats chase mice. Cats nap.",
};
const SERVICE_REQUEST_TERMS = {
  [REQUEST_KEY]: {
    request: REQUEST,
    requestHash: sha256Hex(canonicalize(REQUEST)),
  },
};

const VARIANTS: Array<[string, () => FixedPriceAgreementInput]> = [
  ["AgreementDocument", () => input()],
  ["PayeeBoundAgreementDocument", () => payeeBoundInput()],
];

const draftHash = (draft: UnsignedAgreementArtifact): string =>
  sha256Hex(canonicalize(draft));

function withTerms(
  base: FixedPriceAgreementInput,
  additionalTerms: unknown,
): FixedPriceAgreementInput {
  return { ...base, additionalTerms } as FixedPriceAgreementInput;
}

async function sign(draft: UnsignedAgreementArtifact): Promise<AgreementArtifact> {
  return signFixedPriceAgreement(
    draft,
    {
      party: BUYER,
      algorithm: "ed25519",
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
    },
    {
      party: SELLER,
      algorithm: "ed25519",
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
  );
}

function separator(agreement: AgreementArtifact | UnsignedAgreementArtifact) {
  return "agreementVersion" in agreement
    ? ARTIFACT_SEPARATORS.AgreementDocument
    : ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument;
}

function verifiesUnder(agreement: AgreementArtifact, hash: string): boolean {
  const bytes = signedBytes(separator(agreement), hash);
  return agreement.signatures.every((signature, index) =>
    ed25519Verify(
      bytes,
      Uint8Array.from(Buffer.from(signature.value, "base64url")),
      publicKeyFromSeed(index === 0 ? BUYER_SEED : SELLER_SEED),
    )
  );
}

function nested(levels: number, kind: "object" | "array" = "object"): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < levels; index += 1) {
    value = kind === "object" ? { inner: value } : [value];
  }
  return value;
}

describe("fixed-price additionalTerms (DACS-3 §8.5)", () => {
  test("omitted additionalTerms leaves every existing fixture byte-identical to main", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(MAIN_DRAFT_HASHES).sort());
    for (const [name, build] of Object.entries(FIXTURES)) {
      const draft = deriveFixedPriceAgreement(build());
      expect(draftHash(draft), name).toBe(MAIN_DRAFT_HASHES[name]);
      expect(Object.prototype.hasOwnProperty.call(draft.terms, "additionalTerms"), name)
        .toBe(false);
    }
  });

  test("present additionalTerms is the only difference from the omitted derivation", () => {
    for (const [name, build] of Object.entries(FIXTURES)) {
      const base = deriveFixedPriceAgreement(build());
      const extended = deriveFixedPriceAgreement(withTerms(build(), SERVICE_REQUEST_TERMS));
      const { additionalTerms, ...otherTerms } = extended.terms as typeof extended.terms & {
        additionalTerms?: unknown;
      };
      expect(additionalTerms, name).toEqual(SERVICE_REQUEST_TERMS);
      expect(canonicalize(otherTerms), name).toBe(canonicalize(base.terms));
      expect(canonicalize({ ...extended, terms: base.terms }), name)
        .toBe(canonicalize(base));
      expect(draftHash(extended), name).not.toBe(MAIN_DRAFT_HASHES[name]);
    }
  });

  test("an explicit undefined is refused like every other optional input member", () => {
    expect(() => deriveFixedPriceAgreement(withTerms(input(), undefined)))
      .toThrow(/fixed-price agreement input is not stable canonical JSON/);
  });

  test.each(VARIANTS)(
    "%s carries the terms verbatim under both signatures and the agreement hash",
    async (_name, build) => {
      const base = await sign(deriveFixedPriceAgreement(build()));
      const draft = deriveFixedPriceAgreement(withTerms(build(), SERVICE_REQUEST_TERMS));
      const signed = await sign(draft);
      expect(isAgreementArtifact(signed)).toBe(true);
      expect(
        "agreementVersion" in signed
          ? isAgreementDocument(signed)
          : isPayeeBoundAgreementDocument(signed),
      ).toBe(true);
      expect(signed.terms.additionalTerms).toEqual(SERVICE_REQUEST_TERMS);

      const hash = contentHash(signed as unknown as Record<string, unknown>);
      expect(hash).not.toBe(contentHash(base as unknown as Record<string, unknown>));
      expect(verifiesUnder(signed, hash)).toBe(true);

      // A one-byte change inside the entry changes the hash, so neither
      // signature covers the altered Agreement.
      const altered = structuredClone(signed);
      (altered.terms.additionalTerms![REQUEST_KEY] as { requestHash: string })
        .requestHash = `${SERVICE_REQUEST_TERMS[REQUEST_KEY].requestHash.slice(0, -1)}0`;
      const alteredHash = contentHash(altered as unknown as Record<string, unknown>);
      expect(alteredHash).not.toBe(hash);
      expect(verifiesUnder(altered, alteredHash)).toBe(false);
    },
  );

  test("member order is canonicalised, and nested signature members stay signed", () => {
    const reordered = deriveFixedPriceAgreement(withTerms(input(), {
      [REQUEST_KEY]: {
        requestHash: SERVICE_REQUEST_TERMS[REQUEST_KEY].requestHash,
        request: { input: REQUEST.input, version: "1", serviceId: REQUEST.serviceId, type: REQUEST.type },
      },
    }));
    expect(draftHash(reordered)).toBe(
      draftHash(deriveFixedPriceAgreement(withTerms(input(), SERVICE_REQUEST_TERMS))),
    );

    // contentHash strips only the top-level signature members (§8.5.1).
    const first = deriveFixedPriceAgreement(withTerms(input(), {
      "acme:attested-quote:v1": { signature: "one", signatures: ["a"] },
    }));
    const second = deriveFixedPriceAgreement(withTerms(input(), {
      "acme:attested-quote:v1": { signature: "two", signatures: ["a"] },
    }));
    expect(contentHash(first as unknown as Record<string, unknown>)).not.toBe(
      contentHash(second as unknown as Record<string, unknown>),
    );
  });

  test("the derived draft owns its copy of the caller's terms", () => {
    const callerTerms = structuredClone(SERVICE_REQUEST_TERMS);
    const draft = deriveFixedPriceAgreement(withTerms(input(), callerTerms));
    callerTerms[REQUEST_KEY].request.input = "substituted after derivation";
    expect(draft.terms.additionalTerms).toEqual(SERVICE_REQUEST_TERMS);
  });

  test("accepts namespaced keys that only resemble reserved names", () => {
    for (const key of [
      REQUEST_KEY,
      "com.example:price-quote:v1",
      "dacs.example:request:v2",
      "acme:prices:v10",
      "a1:b2:v1",
    ]) {
      expect(
        deriveFixedPriceAgreement(withTerms(input(), { [key]: true })).terms
          .additionalTerms,
        key,
      ).toEqual({ [key]: true });
    }
  });

  test.each(VARIANTS)(
    "%s: the producer accepts exactly the numbers the signing plan accepts",
    (_name, build) => {
      const base = deriveFixedPriceAgreement(build());
      const accepts = (fn: () => unknown): boolean => {
        try {
          fn();
          return true;
        } catch {
          return false;
        }
      };
      for (const [label, value, expected] of [
        ["0", 0, true],
        ["1", 1, true],
        ["-1", -1, true],
        ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER, true],
        ["MIN_SAFE_INTEGER", Number.MIN_SAFE_INTEGER, true],
        ["4.5", 4.5, false],
        ["-4.5", -4.5, false],
        ["0.1", 0.1, false],
        ["1e-7", 1e-7, false],
        ["2^51 + 0.5", 2 ** 51 + 0.5, false],
        ["2^53", 2 ** 53, false],
        ["-(2^53)", -(2 ** 53), false],
        ["1e21", 1e21, false],
        ["-0", -0, false],
        ["NaN", Number.NaN, false],
        ["Infinity", Number.POSITIVE_INFINITY, false],
        ["-Infinity", Number.NEGATIVE_INFINITY, false],
      ] as const) {
        const terms = { "acme:x:v1": { value } };
        const producer = accepts(() =>
          deriveFixedPriceAgreement(withTerms(build(), terms))
        );
        // Bypass the producer: the same value placed directly in a draft.
        const draft = structuredClone(base);
        (draft.terms as { additionalTerms?: unknown }).additionalTerms = terms;
        const plan = accepts(() => createFixedPriceAgreementSigningPlan(draft));
        expect(producer, label).toBe(expected);
        expect(plan, label).toBe(expected);
      }
    },
  );

  describe.each(VARIANTS)("%s refusals", (_name, build) => {
    test("non-record values", () => {
      for (const value of [[], [SERVICE_REQUEST_TERMS], null, "terms", 1, true]) {
        expect(
          () => deriveFixedPriceAgreement(withTerms(build(), value)),
          canonicalize(value),
        ).toThrow(/additionalTerms must be an exact JSON record/);
      }
    });

    test("an empty record", () => {
      expect(() => deriveFixedPriceAgreement(withTerms(build(), {})))
        .toThrow(/additionalTerms must be omitted rather than empty/);
    });

    test("keys outside <namespace>:<name>:v<n>", () => {
      for (const key of [
        "request",
        "Acme:request:v1",
        "acme:Request:v1",
        "acme:request:V1",
        "acme:request",
        "acme:request:v0",
        "acme:request:v01",
        "acme:request:1",
        "acme::v1",
        ":request:v1",
        "acme:request:v1:extra",
        "acme_co:request:v1",
        "acme:request_body:v1",
        "acme.:request:v1",
        "acme:-request:v1",
        " acme:request:v1",
        "acme:request:v1 ",
        "ácme:request:v1",
        "acme:request:v1​",
        `${"a".repeat(120)}:request:v1`,
        "__proto__",
        "constructor",
      ]) {
        const terms = JSON.parse(`{${JSON.stringify(key)}:true}`) as unknown;
        expect(() => deriveFixedPriceAgreement(withTerms(build(), terms)), key)
          .toThrow(/additionalTerms keys must be <namespace>:<name>:v<n>/);
      }
    });

    test("keys that shadow an agreement term or the dacs namespace", () => {
      for (const key of [
        "acme:deliverable:v1",
        "acme:price:v1",
        "acme:metered-quantity:v1",
        "acme:rail:v1",
        "acme:deadline:v2",
        "acme:price-anchor:v1",
        "acme:fee-schedule:v1",
        "acme:payout-bindings:v1",
        "acme:prior-payment-disposition-ref:v1",
        "acme:additional-terms:v1",
        "dacs:request:v1",
      ]) {
        expect(
          () => deriveFixedPriceAgreement(withTerms(build(), {
            ...SERVICE_REQUEST_TERMS,
            [key]: { amount: "0", currency: "USDC" },
          })),
          key,
        ).toThrow(/shadows a DACS-3 §8.5 agreement term or the reserved dacs namespace/);
      }
    });

    test("canonical UTF-8 above 8,192 bytes", () => {
      // {"acme:blob:v1":"<n>"} is n + 19 canonical bytes.
      const atCap = deriveFixedPriceAgreement(
        withTerms(build(), { "acme:blob:v1": "x".repeat(8_173) }),
      );
      expect(Buffer.byteLength(canonicalize(atCap.terms.additionalTerms), "utf8"))
        .toBe(8_192);
      expect(() => deriveFixedPriceAgreement(
        withTerms(build(), { "acme:blob:v1": "x".repeat(8_174) }),
      )).toThrow(/additionalTerms canonical form exceeds 8192 bytes/);
      // Measured in UTF-8 bytes, not UTF-16 code units.
      expect(() => deriveFixedPriceAgreement(
        withTerms(build(), { "acme:blob:v1": "é".repeat(4_100) }),
      )).toThrow(/additionalTerms canonical form exceeds 8192 bytes/);
    });

    test("nesting deeper than 8 container levels", () => {
      for (const kind of ["object", "array"] as const) {
        expect(
          deriveFixedPriceAgreement(withTerms(build(), { "acme:deep:v1": nested(7, kind) }))
            .terms.additionalTerms,
          kind,
        ).toEqual({ "acme:deep:v1": nested(7, kind) });
        expect(
          () => deriveFixedPriceAgreement(
            withTerms(build(), { "acme:deep:v1": nested(8, kind) }),
          ),
          kind,
        ).toThrow(/additionalTerms must not nest deeper than 8 levels/);
      }
    });

    test("prototype member names at any depth", () => {
      for (const json of [
        `{"acme:x:v1":{"__proto__":{"polluted":true}}}`,
        `{"acme:x:v1":{"constructor":"x"}}`,
        `{"acme:x:v1":[{"prototype":1}]}`,
        `{"acme:x:v1":{"a":{"b":{"__proto__":null}}}}`,
      ]) {
        const terms = JSON.parse(json) as unknown;
        expect(() => deriveFixedPriceAgreement(withTerms(build(), terms)), json)
          .toThrow(/additionalTerms must not use a prototype member name/);
      }
      // A literal __proto__ in source sets a prototype instead of a member.
      expect(() => deriveFixedPriceAgreement(withTerms(build(), {
        __proto__: { "acme:x:v1": true },
        "acme:y:v1": true,
      }))).toThrow(/not stable canonical JSON/);
    });

    test("numbers that are not safe integers, top-level and nested", () => {
      for (const [label, value] of [
        ["top-level fraction", 4.5],
        ["negative fraction", -4.5],
        ["small fraction", 0.1],
        ["exponent fraction", 1e-7],
        ["fraction above 2^51", 2 ** 51 + 0.5],
        ["nested fraction", { score: 4.5 }],
        ["fraction in an array", [1, 2, 0.5]],
        ["deep fraction", { a: [{ b: { c: 4.5 } }] }],
      ] as const) {
        expect(
          () => deriveFixedPriceAgreement(withTerms(build(), { "acme:x:v1": value })),
          label,
        ).toThrow(/additionalTerms numbers must be safe integers; carry decimals as strings/);
      }
      // The same values as decimal strings are carried verbatim.
      expect(
        deriveFixedPriceAgreement(withTerms(build(), { "acme:x:v1": { score: "4.5" } }))
          .terms.additionalTerms,
      ).toEqual({ "acme:x:v1": { score: "4.5" } });
    });

    test("values JSON cannot represent, without invoking accessors", () => {
      let getterCalls = 0;
      const accessor = {};
      Object.defineProperty(accessor, "value", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 1;
        },
      });
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      const symbolKeyed = { [Symbol("hidden")]: 1 };
      for (const [label, value] of [
        ["undefined", undefined],
        ["function", () => 1],
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["-Infinity", Number.NEGATIVE_INFINITY],
        ["negative zero", -0],
        ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
        ["negative unsafe integer", -(2 ** 53)],
        ["1e21", 1e21],
        ["bigint", 1n],
        ["Date", new Date(NOW)],
        ["Map", new Map([["a", 1]])],
        ["accessor", accessor],
        ["Proxy", new Proxy({}, {})],
        ["cycle", cycle],
        ["symbol key", symbolKeyed],
        ["lone surrogate", "\ud800"],
      ] as const) {
        expect(
          () => deriveFixedPriceAgreement(withTerms(build(), { "acme:x:v1": value })),
          label,
        ).toThrow(/fixed-price agreement input is not stable canonical JSON/);
      }
      expect(getterCalls).toBe(0);
    });
  });
});

describe("fixed-price Agreement readers with additionalTerms", () => {
  test.each(VARIANTS)(
    "%s with valid terms passes the artifact validator and the Listing binding",
    async (_name, build) => {
      const agreementInput = withTerms(build(), SERVICE_REQUEST_TERMS);
      const signed = await sign(deriveFixedPriceAgreement(agreementInput));
      expect(isAgreementArtifact(signed)).toBe(true);
      const binding = validateFixedPriceAgreementBinding({
        agreement: signed,
        verifiedListing: agreementInput.verifiedListing,
        committedAt: NOW,
      });
      expect(binding.agreementHash).toBe(
        contentHash(signed as unknown as Record<string, unknown>),
      );
    },
  );

  test.each(VARIANTS)(
    "%s with a malformed member is refused by the validator and the Listing binding",
    async (_name, build) => {
      const agreementInput = withTerms(build(), SERVICE_REQUEST_TERMS);
      const signed = await sign(deriveFixedPriceAgreement(agreementInput));
      for (const malformed of [[], null, "terms", 1, [SERVICE_REQUEST_TERMS]]) {
        const agreement = {
          ...signed,
          terms: { ...signed.terms, additionalTerms: malformed },
        } as unknown as AgreementArtifact;
        expect(isAgreementArtifact(agreement), canonicalize(malformed)).toBe(false);
        expect(() => validateFixedPriceAgreementBinding({
          agreement,
          verifiedListing: agreementInput.verifiedListing,
          committedAt: NOW,
        }), canonicalize(malformed)).toThrow();
      }
    },
  );

  test("readers keep the Standard's open record: profile limits bind producers only", async () => {
    // §8.5 allows any Record. An Agreement another conforming producer signed
    // with an un-namespaced member is still a valid artifact for this reader.
    const agreementInput = input();
    const draft = deriveFixedPriceAgreement(agreementInput);
    const foreign = await sign({
      ...draft,
      terms: { ...draft.terms, additionalTerms: { competitiveContext: { bids: 3 } } },
    } as UnsignedAgreementArtifact);
    expect(isAgreementArtifact(foreign)).toBe(true);
    expect(() => validateFixedPriceAgreementBinding({
      agreement: foreign,
      verifiedListing: agreementInput.verifiedListing,
      committedAt: NOW,
    })).not.toThrow();
  });
});
