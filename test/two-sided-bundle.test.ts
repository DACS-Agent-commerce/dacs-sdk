/**
 * DACS-5 §10.4.1/§10.4.2 v0.3 FaultAttestationBundle producer.
 *
 * Golden reference: `practice-dacs-0001` — at the time of writing, the only conformant
 * two-sided bundle anchored on the live DACS Directory. Both copies are pinned in
 * test/fixtures/ from public records:
 *   GET /api/dacs/deal-owners?jobId=practice-dacs-0001
 *   GET /api/dacs/artifact?ref=<bundleRef>
 *
 * Testing against a FOREIGN producer's output (demosdk 4.x) rather than our own is the point:
 * a producer and a verifier written by the same hand can share a bug and still agree.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, createPublicKey, verify as edVerify } from "node:crypto";

import {
  buildTwoSidedBundle,
  bundleSignedScope,
  attestationBundleHash,
  BUNDLE_SIGNED_SCOPE_OMIT,
} from "../src/agent/twoSidedBundle.js";
import { verifyBundleCopy } from "../src/agent/bundleCopyValidity.js";
import type {
  BundleOutcome,
  SigningSessionParty,
  TwoSidedSession,
} from "../src/agent/twoSidedBundle.js";
import { bundlesDiverge } from "../src/agent/bundleDivergence.js";
import type {
  AnyAttestationBundle,
  AttestationBundle,
  FaultAttestationBundle,
} from "../src/artifacts/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const golden = (role: "buyer" | "seller"): AttestationBundle =>
  JSON.parse(readFileSync(join(FIXTURES, `practice-dacs-0001.${role}.json`), "utf8"));

/** practice-dacs-0001's attestation-bundle hash, independently reproduced by dacs-verify. */
const GOLDEN_HASH = "6c2c7ca7bab682b4d872653e057f25409c356dc9d0dc2cf908f7c3c7b6a61f6a";

/** Deterministic ed25519 seeds for the two test parties (test-only; never a real key). */
const seed = (n: number) => new Uint8Array(createHash("sha256").update(`test-party-${n}`).digest());

function publicKeyRaw(rawSeed: Uint8Array): Uint8Array {
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(rawSeed),
  ]);
  const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
  return new Uint8Array(spki.subarray(spki.length - 32));
}

const buyerSeed = seed(1);
const sellerSeed = seed(2);
const buyerClaim = `demos:0x${Buffer.from(publicKeyRaw(buyerSeed)).toString("hex")}`;
const sellerClaim = `demos:0x${Buffer.from(publicKeyRaw(sellerSeed)).toString("hex")}`;

const session = (): TwoSidedSession & {
  buyer: SigningSessionParty;
  seller: SigningSessionParty;
} => ({
  jobId: "isc-session-1",
  outcome: "completed" as BundleOutcome,
  listingRef: { listingId: "lst-isc-1", version: 1, contentHash: "a".repeat(64) },
  agreementRef: {
    anchor: {
      kind: "storage-program",
      locator: "dacs3:commit:isc-session-1",
    },
    contentHash: "b".repeat(64),
  },
  phaseSummary: [
    { index: 0, kind: "vet-credentials", outcome: "ok" },
    { index: 1, kind: "commit-agreement", outcome: "ok" },
    { index: 2, kind: "pay-x402", outcome: "ok" },
  ],
  vetRecords: [],
  settlementEvidence: [
    {
      anchor: {
        kind: "storage-program",
        locator: "dacs4:payment:isc-session-1",
      },
      contentHash: "c".repeat(64),
    },
  ],
  recipeRegistryVersion: 1,
  railRegistryVersion: 1,
  finalisedAt: 1767225600000,
  buyer: { primaryClaim: buyerClaim, bundleHash: "d".repeat(64), signer: buyerSeed },
  seller: { primaryClaim: sellerClaim, bundleHash: "e".repeat(64), signer: sellerSeed },
});

/** Both copies of a happy-path session; asserts the seller copy exists so tests can narrow. */
async function bothCopies() {
  const { buyerCopy, sellerCopy } = await buildTwoSidedBundle(session());
  expect(buyerCopy).toBeDefined();
  expect(sellerCopy).toBeDefined();
  return {
    buyerCopy: buyerCopy as FaultAttestationBundle,
    sellerCopy: sellerCopy as FaultAttestationBundle,
  };
}

const asRecord = (b: AnyAttestationBundle) => b as unknown as Record<string, unknown>;

describe("DACS-5 two-sided co-signed bundle producer", () => {
  test("ISC-1: emits a buyer-anchored and a seller-anchored copy", async () => {
    const { buyerCopy, sellerCopy } = await bothCopies();
    expect(buyerCopy).toBeDefined();
    expect(sellerCopy).toBeDefined();
  });

  test("ISC-2: both copies carry BOTH parties", async () => {
    const { buyerCopy, sellerCopy } = await bothCopies();
    for (const copy of [buyerCopy, sellerCopy]) {
      expect(copy.parties.map((p) => p.role).sort()).toEqual(["buyer", "seller"]);
    }
  });

  test("ISC-3: both copies carry BOTH signatures, bound to the party claims", async () => {
    const { buyerCopy, sellerCopy } = await bothCopies();
    for (const copy of [buyerCopy, sellerCopy]) {
      expect(copy.signatures).toHaveLength(2);
      expect(copy.signatures!.map((s) => s.party).sort()).toEqual(
        [buyerClaim, sellerClaim].sort(),
      );
    }
  });

  test("ISC-4: the two copies are canonically EQUAL", async () => {
    const { buyerCopy, sellerCopy } = await bothCopies();
    expect(attestationBundleHash(buyerCopy)).toBe(attestationBundleHash(sellerCopy));
  });

  test("ISC-5: the copies differ in exactly ONE field — anchoredByRole", async () => {
    const { buyerCopy, sellerCopy } = await bothCopies();
    const b = asRecord(buyerCopy);
    const s = asRecord(sellerCopy);
    const keys = [...new Set([...Object.keys(b), ...Object.keys(s)])];
    const differing = keys.filter((k) => JSON.stringify(b[k]) !== JSON.stringify(s[k]));
    expect(differing).toEqual(["anchoredByRole"]);
  });

  test("ISC-6: anchoredByRole matches the anchoring party's role (§10.4.2)", async () => {
    const { buyerCopy, sellerCopy } = await bothCopies();
    expect(buyerCopy.anchoredByRole).toBe("buyer");
    expect(sellerCopy.anchoredByRole).toBe("seller");
  });

  test("ISC-7: each signature verifies over the fault-bundle domain", async () => {
    const { buyerCopy } = await bothCopies();
    const payload = Buffer.concat([
      Buffer.from("dacs-fault-bundle:v1:", "utf8"),
      Buffer.from(attestationBundleHash(buyerCopy), "ascii"),
    ]);
    for (const sig of buyerCopy.signatures!) {
      const spki = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(sig.party.replace(/^demos:0x/, ""), "hex"),
      ]);
      const key = createPublicKey({ key: spki, format: "der", type: "spki" });
      expect(edVerify(null, payload, key, Buffer.from(sig.value, "base64url"))).toBe(true);
    }
  });

  test("ISC-8 GOLDEN: our hash of the foreign producer's bundle matches the reported value", () => {
    expect(attestationBundleHash(golden("buyer"))).toBe(GOLDEN_HASH);
    expect(attestationBundleHash(golden("seller"))).toBe(GOLDEN_HASH);
  });

  test("ISC-8 ANTI: bundle hashes bind dangerous unknown own keys", () => {
    const base = golden("buyer") as unknown as Record<string, unknown>;
    const withUnknownKeys = JSON.parse(JSON.stringify(base)) as Record<
      string,
      unknown
    >;
    Object.defineProperty(withUnknownKeys, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { policy: "proto-bound" },
      writable: true,
    });
    withUnknownKeys["constructor"] = { policy: "constructor-bound" };
    withUnknownKeys["prototype"] = { policy: "prototype-bound" };
    const boundHash = attestationBundleHash(
      withUnknownKeys as unknown as AnyAttestationBundle,
    );

    for (const key of ["__proto__", "constructor", "prototype"] as const) {
      const tampered = JSON.parse(JSON.stringify(withUnknownKeys)) as Record<
        string,
        unknown
      >;
      (tampered[key] as { policy: string }).policy = "tampered";
      expect(
        attestationBundleHash(tampered as unknown as AnyAttestationBundle),
      ).not.toBe(boundHash);
    }

    const envelopeChanged = {
      ...withUnknownKeys,
      signatures: [],
      anchoredByRole: "seller",
    } as unknown as AnyAttestationBundle;
    expect(attestationBundleHash(envelopeChanged)).toBe(boundHash);
  });

  test("ISC-8 ANTI: v0.3 production refuses legacy MVP shared-field shapes", async () => {
    const g = golden("buyer");
    const stub = () => new Uint8Array(64);
    const partyOf = (role: "buyer" | "seller") => {
      const p = g.parties.find((x) => x.role === role)!;
      return { primaryClaim: p.primaryClaim, bundleHash: p.bundleHash, signer: stub };
    };

    expect(g.bundleVersion).toBe("1");
    await expect(
      buildTwoSidedBundle({
        jobId: g.jobId,
        outcome: g.outcome as BundleOutcome,
        listingRef: g.listingRef,
        agreementRef: g.agreementRef,
        phaseSummary: g.phaseSummary,
        vetRecords: g.vetRecords,
        settlementEvidence: g.settlementEvidence,
        recipeRegistryVersion: g.recipeRegistryVersion,
        railRegistryVersion: g.railRegistryVersion,
        finalisedAt: g.finalisedAt,
        buyer: partyOf("buyer"),
        seller: partyOf("seller"),
      }),
    ).rejects.toThrow(/do not form a valid FaultAttestationBundle/i);
  });

  // Transcribed from the SPEC, not from the implementation's constant. The previous version of
  // this test iterated the producer's own guard set, so the code and the test shared a blind spot
  // and the suite was structurally incapable of finding the `failed-perm` hole that was in it.
  // spec/DACS-5-VERIFY.md:266 @origin/next=d289af1 — "Bundles whose outcome is `completed`,
  // `failed-perm`, `failed-counterparty`, or `failed-substrate` and that are missing any required
  // signature MUST be rejected by consumers."
  const SPEC_CO_SIGNATURE_REQUIRED: BundleOutcome[] = [
    "completed",
    "failed-perm",
    "failed-counterparty",
    "failed-substrate",
  ];
  // spec:267 — "A bundle whose outcome is `aborted-by-self` or `aborted-by-other` MAY carry a
  // single signature".
  const SPEC_SINGLE_SIGNATURE_PERMITTED: BundleOutcome[] = ["aborted-by-self", "aborted-by-other"];

  test.each(SPEC_CO_SIGNATURE_REQUIRED)(
    "ISC-11 ANTI: refuses a single-signed %s (spec:266)",
    async (outcome) => {
      // The exact defect class found on all 10 live DACS Directory roster deals.
      const { signer: _signer, ...sellerWithoutSigner } = session().seller;
      const s = {
        ...session(),
        outcome,
        ...(outcome === "failed-perm" || outcome === "failed-counterparty"
          ? { faultedParty: "seller" as const }
          : {}),
        seller: sellerWithoutSigner,
      };
      await expect(buildTwoSidedBundle(s)).rejects.toThrow(/requires the seller's signature/i);
    },
  );

  test("ISC-11.0 ANTI: refuses an abort bundle that omits the seller party identity", async () => {
    const s = {
      ...session(),
      outcome: "aborted-by-other" as BundleOutcome,
      faultedParty: "seller" as const,
      seller: undefined,
    };
    await expect(buildTwoSidedBundle(s as never)).rejects.toThrow(/requires the seller party/i);
  });

  test("ISC-11.1 ANTI: fails CLOSED on an outcome the spec does not name", async () => {
    // A denylist would fail OPEN here — a future minor version's outcome, or a typo, would
    // silently produce the single-signed bundle consumers must drop.
    const s = { ...session(), outcome: "outcome-from-a-future-minor-version", seller: undefined };
    await expect(buildTwoSidedBundle(s as never)).rejects.toThrow(/not a DACS-5 bundle outcome/i);
  });

  test("ISC-11.1a: permits a pre-commit terminal bundle without agreementRef", async () => {
    const { agreementRef: _agreementRef, ...s } = session();
    const { buyerCopy, sellerCopy } = await buildTwoSidedBundle({
      ...s,
      outcome: "aborted-by-other",
      faultedParty: "seller",
      phaseSummary: [{ index: 0, kind: "vet-credentials", outcome: "ok" }],
      settlementEvidence: [],
    });
    expect(buyerCopy).not.toHaveProperty("agreementRef");
    expect(sellerCopy).not.toHaveProperty("agreementRef");
  });

  test("ISC-11.1a ANTI: refuses to omit agreementRef after commitment", async () => {
    const { agreementRef: _agreementRef, ...s } = session();
    await expect(buildTwoSidedBundle(s as never)).rejects.toThrow(/agreementRef is required once/i);
    await expect(
      buildTwoSidedBundle({
        ...s,
        outcome: "failed-perm",
        faultedParty: "buyer",
        settlementEvidence: [],
        phaseSummary: [{ index: 0, kind: "commit-agreement", outcome: "ok" }],
      }),
    ).rejects.toThrow(/agreementRef is required once/i);
    await expect(
      buildTwoSidedBundle({
        ...s,
        outcome: "failed-perm",
        faultedParty: "buyer",
        settlementEvidence: [],
        phaseSummary: [{ index: 0, kind: "negotiate-fixed-price", outcome: "fail" }],
        amendments: [
          {
            anchor: { kind: "storage-program", locator: "refund-1" },
            contentHash: "f".repeat(64),
          },
        ],
      }),
    ).rejects.toThrow(/agreementRef is required once/i);
  });

  test("ISC-11.1b ANTI: refuses a declared faultBundleVersion outside the v1 signing domain", async () => {
    const s = { ...session(), faultBundleVersion: "2" };
    await expect(buildTwoSidedBundle(s as never)).rejects.toThrow(/faultBundleVersion "2" is not supported/i);
  });

  test("ISC-11.1c ANTI: invariant outcomes refuse a caller-supplied fault", async () => {
    await expect(
      buildTwoSidedBundle({ ...session(), faultedParty: "seller" }),
    ).rejects.toThrow(/must not declare faultedParty/i);
  });

  test("ISC-11.1d ANTI: fault outcomes reject runtime none or null attribution", async () => {
    for (const faultedParty of ["none", null]) {
      await expect(
        buildTwoSidedBundle({
          ...session(),
          outcome: "failed-counterparty",
          faultedParty,
        } as never),
      ).rejects.toThrow(/requires absolute faultedParty buyer, seller, or orchestrator/i);
    }
  });

  // The gap the missing-seller guard CANNOT close: nothing is missing. Both parties sign, every
  // signature verifies, and the artifact still is not a DACS-5 bundle because `outcome` is not in
  // the spec's closed set (:177). Fixing only the single-signed path left this wide open — the
  // invented `failed-buyer` still shipped, fully co-signed.
  test.each(["failed-buyer", "failed-seller", "outcome-from-a-future-minor-version", ""])(
    "ISC-11.3 ANTI: refuses a FULLY-SIGNED bundle whose outcome is not in the spec's set: %s",
    async (outcome) => {
      const s = { ...session(), outcome }; // seller PRESENT — two signatures, still invalid
      await expect(buildTwoSidedBundle(s as never)).rejects.toThrow(/not a DACS-5 bundle outcome/i);
    },
  );

  test.each([...SPEC_CO_SIGNATURE_REQUIRED, ...SPEC_SINGLE_SIGNATURE_PERMITTED])(
    "ISC-11.4: accepts every spec outcome when required signers are present: %s",
    async (o) => {
    const s = {
      ...session(),
      outcome: o,
      ...(o === "failed-perm" || o === "failed-counterparty" || o === "aborted-by-self" || o === "aborted-by-other"
        ? { faultedParty: "seller" as const }
        : {}),
    };
    await expect(buildTwoSidedBundle(s)).resolves.toBeDefined();
    },
  );

  test("ISC-11.4a: co-signed failed-substrate copies remain canonically identical", async () => {
    const { buyerCopy, sellerCopy } = await buildTwoSidedBundle({
      ...session(),
      outcome: "failed-substrate",
    });
    expect(buyerCopy?.outcome).toBe("failed-substrate");
    expect(sellerCopy?.outcome).toBe("failed-substrate");
    expect(attestationBundleHash(buyerCopy!)).toBe(
      attestationBundleHash(sellerCopy!),
    );
  });

  test.each([
    ["failed-counterparty", "failed-counterparty", "failed-perm"],
    ["failed-perm", "failed-counterparty", "failed-perm"],
    ["aborted-by-other", "aborted-by-other", "aborted-by-self"],
    ["aborted-by-self", "aborted-by-other", "aborted-by-self"],
  ] as const)(
    "ISC-11.4b: co-signed %s emits perspective copies with one absolute fault",
    async (outcome, buyerOutcome, sellerOutcome) => {
      const { buyerCopy, sellerCopy } = await buildTwoSidedBundle({
        ...session(),
        outcome,
        faultedParty: "seller",
      });
      expect(buyerCopy?.outcome).toBe(buyerOutcome);
      expect(sellerCopy?.outcome).toBe(sellerOutcome);
      expect(buyerCopy?.faultedParty).toBe("seller");
      expect(sellerCopy?.faultedParty).toBe("seller");
      expect(buyerCopy?.signatures).toHaveLength(2);
      expect(sellerCopy?.signatures).toHaveLength(2);
      expect(bundlesDiverge(buyerCopy!, sellerCopy!)).toBe(false);
    },
  );

  test("ISC-11.4c: perspective copies preserve the same phase facts", async () => {
    const { buyerCopy, sellerCopy } = await buildTwoSidedBundle({
      ...session(),
      outcome: "failed-counterparty",
      faultedParty: "seller",
      phaseSummary: [
        {
          index: 0,
          kind: "pay-x402",
          outcome: "fail",
          errorClass: "counterparty",
        },
      ],
    });
    expect(buyerCopy?.phaseSummary[0]).toMatchObject({ errorClass: "counterparty" });
    expect(sellerCopy?.phaseSummary[0]).toMatchObject({ errorClass: "counterparty" });
  });

  test("ISC-11.4d ANTI: producer rejects duplicate phase indices before signing", async () => {
    await expect(
      buildTwoSidedBundle({
        ...session(),
        phaseSummary: [
          { index: 0, kind: "vet-credentials", outcome: "ok" },
          { index: 0, kind: "commit-agreement", outcome: "ok" },
        ],
      }),
    ).rejects.toThrow(/do not form a valid FaultAttestationBundle/i);
  });

  test("ISC-11.4e ANTI: producer rejects phase values outside the closed enums", async () => {
    for (const phase of [
      { index: 0, kind: "settle", outcome: "garbage" },
      { index: 0, kind: "settle", outcome: "fail", errorClass: "garbage" },
      { index: 0, kind: "settle", outcome: "ok", txRefs: [{ rail: "pay-x402" }] },
    ]) {
      await expect(
        buildTwoSidedBundle({ ...session(), phaseSummary: [phase] } as never),
      ).rejects.toThrow(/do not form a valid FaultAttestationBundle/i);
    }
  });

  test("ISC-10: buyer-signed aborted-by-other emits signer-perspective copy", async () => {
    const { signer: _signer, ...sellerWithoutSigner } = session().seller;
    const s = {
      ...session(),
      outcome: "aborted-by-other" as BundleOutcome,
      faultedParty: "seller" as const,
      seller: sellerWithoutSigner,
    };
    const { buyerCopy, sellerCopy } = await buildTwoSidedBundle(s);
    expect(buyerCopy?.signatures).toHaveLength(1);
    expect(buyerCopy?.parties.map((p) => p.role).sort()).toEqual(["buyer", "seller"]);
    expect(buyerCopy?.anchoredByRole).toBe("buyer");
    expect(buyerCopy?.outcome).toBe("aborted-by-other");
    expect(sellerCopy).toBeUndefined();
  });

  test("ISC-10 ANTI: buyer-signed aborted-by-self is rejected, not rewritten", async () => {
    const { signer: _signer, ...sellerWithoutSigner } = session().seller;
    await expect(
      buildTwoSidedBundle({
        ...session(),
        outcome: "aborted-by-self",
        faultedParty: "buyer",
        seller: sellerWithoutSigner,
      }),
    ).rejects.toThrow(/single-signed abort must name a non-signer/i);
  });

  test("ISC-10.1: seller-signed aborted-by-other emits a seller-anchored signer copy", async () => {
    const { signer: _signer, ...buyerWithoutSigner } = session().buyer;
    const s = {
      ...session(),
      outcome: "aborted-by-other" as BundleOutcome,
      faultedParty: "buyer" as const,
      buyer: buyerWithoutSigner,
    };
    const { buyerCopy, sellerCopy } = await buildTwoSidedBundle(s);
    expect(buyerCopy).toBeUndefined();
    expect(sellerCopy?.signatures).toHaveLength(1);
    expect(sellerCopy?.parties.map((p) => p.role).sort()).toEqual(["buyer", "seller"]);
    expect(sellerCopy?.anchoredByRole).toBe("seller");
    expect(sellerCopy?.outcome).toBe("aborted-by-other");
  });

  test("ISC-10.1 ANTI: a partial multi-party abort signature set fails closed", async () => {
    const { signer: _signer, ...sellerWithoutSigner } = session().seller;
    const orchSeed = seed(3);
    const orchClaim = `demos:0x${Buffer.from(publicKeyRaw(orchSeed)).toString("hex")}`;
    await expect(
      buildTwoSidedBundle({
        ...session(),
        outcome: "aborted-by-other",
        faultedParty: "seller",
        seller: sellerWithoutSigner,
        orchestrator: { primaryClaim: orchClaim, bundleHash: "f".repeat(64), signer: orchSeed },
      }),
    ).rejects.toThrow(/incomplete signer set/i);
  });

  test("ISC-10.1a: a sole buyer can publish its own three-party suppression copy", async () => {
    const { signer: _sellerSigner, ...sellerWithoutSigner } = session().seller;
    const orchSeed = seed(3);
    const orchClaim = `demos:0x${Buffer.from(publicKeyRaw(orchSeed)).toString("hex")}`;
    const { buyerCopy, sellerCopy, orchestratorCopy } = await buildTwoSidedBundle({
      ...session(),
      outcome: "aborted-by-other",
      faultedParty: "seller",
      seller: sellerWithoutSigner,
      orchestrator: { primaryClaim: orchClaim, bundleHash: "f".repeat(64) },
    });
    expect(buyerCopy?.anchoredByRole).toBe("buyer");
    expect(buyerCopy?.signatures?.map(({ party }) => party)).toEqual([buyerClaim]);
    expect(buyerCopy?.parties.map(({ role }) => role).sort()).toEqual([
      "buyer",
      "orchestrator",
      "seller",
    ]);
    expect(sellerCopy).toBeUndefined();
    expect(orchestratorCopy).toBeUndefined();
  });

  test("ISC-10.1b: a sole orchestrator can publish only its own suppression copy", async () => {
    const { signer: _buyerSigner, ...buyerWithoutSigner } = session().buyer;
    const { signer: _sellerSigner, ...sellerWithoutSigner } = session().seller;
    const orchSeed = seed(3);
    const orchClaim = `demos:0x${Buffer.from(publicKeyRaw(orchSeed)).toString("hex")}`;
    const { buyerCopy, sellerCopy, orchestratorCopy } = await buildTwoSidedBundle({
      ...session(),
      outcome: "aborted-by-other",
      faultedParty: "seller",
      buyer: buyerWithoutSigner,
      seller: sellerWithoutSigner,
      orchestrator: {
        primaryClaim: orchClaim,
        bundleHash: "f".repeat(64),
        signer: orchSeed,
      },
    });
    expect(buyerCopy).toBeUndefined();
    expect(sellerCopy).toBeUndefined();
    expect(orchestratorCopy?.anchoredByRole).toBe("orchestrator");
    expect(orchestratorCopy?.signatures?.map(({ party }) => party)).toEqual([
      orchClaim,
    ]);
    const validity = await verifyBundleCopy(
      asRecord(orchestratorCopy!),
      "orchestrator",
      {
        resolvePublicKey: async (claim) =>
          Uint8Array.from(Buffer.from(claim.replace(/^demos:0x/, ""), "hex")),
        verify: (bytes, signature, publicKey) => {
          const spki = Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(publicKey),
          ]);
          return edVerify(
            null,
            bytes,
            createPublicKey({ key: spki, format: "der", type: "spki" }),
            signature,
          );
        },
      },
    );
    expect(validity).toMatchObject({
      valid: true,
      fullySigned: false,
      abortStanding: true,
    });
  });

  test("ISC-10.2: carries current optional bundle fields in the signed scope", async () => {
    const { buyerCopy, sellerCopy } = await buildTwoSidedBundle({
      ...session(),
      amendments: [
        {
          anchor: { kind: "storage-program", locator: "refund-1" },
          contentHash: "f".repeat(64),
        },
      ],
      ratingRefs: [
        {
          anchor: { kind: "storage-program", locator: "rating-1" },
          contentHash: "1".repeat(64),
        },
      ],
    });
    expect(buyerCopy?.amendments).toHaveLength(1);
    expect(buyerCopy?.ratingRefs).toHaveLength(1);
    expect(attestationBundleHash(buyerCopy!)).toBe(
      attestationBundleHash(sellerCopy!),
    );
  });

  test("ISC-10.3: carries pre-commit cancellation markers without agreementRef", async () => {
    const { agreementRef: _agreementRef, ...s } = session();
    const { buyerCopy } = await buildTwoSidedBundle({
      ...s,
      outcome: "aborted-by-other",
      faultedParty: "seller",
      cancellation: { claimedPolicy: "pre-commit" },
      phaseSummary: [{ index: 0, kind: "negotiate-fixed-price", outcome: "fail" }],
      settlementEvidence: [],
    });
    expect(buyerCopy?.cancellation).toEqual({ claimedPolicy: "pre-commit" });
    expect(buyerCopy).not.toHaveProperty("agreementRef");
  });

  test("ISC-10.4 ANTI: fails closed on unsupported cancellation shapes", async () => {
    await expect(
      buildTwoSidedBundle({
        ...session(),
        outcome: "aborted-by-other",
        faultedParty: "seller",
        cancellation: { claimedPolicy: "with-fee" },
      }),
    ).rejects.toThrow(/only "pre-commit" is defined/i);
    await expect(
      buildTwoSidedBundle({
        ...session(),
        outcome: "completed",
        cancellation: { claimedPolicy: "pre-commit" },
      }),
    ).rejects.toThrow(/cancellation is only supported/i);
  });

  test("ISC-11.2: a distinct orchestrator is a REQUIRED signer and anchors its own copy (spec:265)", async () => {
    const orchSeed = seed(3);
    const orchClaim = `demos:0x${Buffer.from(publicKeyRaw(orchSeed)).toString("hex")}`;
    const { buyerCopy, sellerCopy, orchestratorCopy } = await buildTwoSidedBundle({
      ...session(),
      orchestrator: { primaryClaim: orchClaim, bundleHash: "f".repeat(64), signer: orchSeed },
    });
    expect(buyerCopy).toBeDefined();
    expect(sellerCopy).toBeDefined();
    expect(orchestratorCopy).toBeDefined();
    for (const copy of [
      buyerCopy!,
      sellerCopy!,
      orchestratorCopy!,
    ]) {
      expect(copy.parties.map((p) => p.role).sort()).toEqual(["buyer", "orchestrator", "seller"]);
      expect(copy.signatures).toHaveLength(3);
    }
    // All three copies stay canonically equal — anchoredByRole is outside the hashed scope.
    expect(attestationBundleHash(buyerCopy!)).toBe(
      attestationBundleHash(orchestratorCopy!),
    );
    expect(orchestratorCopy!.anchoredByRole).toBe("orchestrator");
  });

  test("ISC-11.2a: distinct-orchestrator fault is absolute across all role copies", async () => {
    const orchSeed = seed(3);
    const orchClaim = `demos:0x${Buffer.from(publicKeyRaw(orchSeed)).toString("hex")}`;
    const { buyerCopy, sellerCopy, orchestratorCopy } = await buildTwoSidedBundle({
      ...session(),
      outcome: "failed-counterparty",
      faultedParty: "orchestrator",
      orchestrator: { primaryClaim: orchClaim, bundleHash: "f".repeat(64), signer: orchSeed },
    });
    expect([buyerCopy?.faultedParty, sellerCopy?.faultedParty, orchestratorCopy?.faultedParty]).toEqual([
      "orchestrator",
      "orchestrator",
      "orchestrator",
    ]);
    expect([buyerCopy?.outcome, sellerCopy?.outcome, orchestratorCopy?.outcome]).toEqual([
      "failed-counterparty",
      "failed-counterparty",
      "failed-perm",
    ]);
    expect(bundlesDiverge(buyerCopy!, orchestratorCopy!)).toBe(false);
  });

  // §10.4.1 requires the orchestrator signature only when the orchestrator is a "distinct party
  // (not buyer or seller)". When it IS one of them it is already a party and already a signer;
  // adding it again yields a DUPLICATE signature and a phantom third role. "Distinct" is a
  // condition, and a condition that is documented but not enforced is not a condition.
  test.each([
    ["buyer", () => session().buyer],
    ["seller", () => session().seller],
  ])("ISC-11.5 ANTI: an orchestrator that IS the %s is not a distinct party (spec:265)", async (
    _label,
    partyOf,
  ) => {
    const { buyerCopy, orchestratorCopy } = await buildTwoSidedBundle({
      ...session(),
      orchestrator: partyOf(),
    });
    expect(orchestratorCopy).toBeUndefined();
    expect(buyerCopy?.parties.map((p) => p.role).sort()).toEqual(["buyer", "seller"]);
    expect(buyerCopy?.signatures).toHaveLength(2);
    // No party signs twice.
    const signers = buyerCopy!.signatures!.map((s) => s.party);
    expect(new Set(signers).size).toBe(signers.length);
  });

  test("ISC-11.6: primary claims are opaque; case-different claims remain distinct", async () => {
    const orchSeed = seed(4);
    const { buyerCopy, sellerCopy, orchestratorCopy } = await buildTwoSidedBundle({
      ...session(),
      orchestrator: {
        primaryClaim: buyerClaim.toUpperCase(),
        bundleHash: "f".repeat(64),
        signer: orchSeed,
      },
    });
    expect(buyerCopy).toBeDefined();
    expect(sellerCopy).toBeDefined();
    expect(orchestratorCopy).toBeDefined();
    for (const copy of [
      buyerCopy!,
      sellerCopy!,
      orchestratorCopy!,
    ]) {
      expect(copy.parties.map((p) => p.role).sort()).toEqual(["buyer", "orchestrator", "seller"]);
      expect(copy.signatures).toHaveLength(3);
    }
  });

  test("BUNDLE_SIGNED_SCOPE_OMIT is the single source for the omission set", () => {
    expect([...BUNDLE_SIGNED_SCOPE_OMIT].sort()).toEqual(["anchoredByRole", "signatures"]);
  });
});
