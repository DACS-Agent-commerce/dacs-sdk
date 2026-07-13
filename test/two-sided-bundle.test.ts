/**
 * DACS-5 §10.4.1/§10.4.2 two-sided co-signed AttestationBundle producer.
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
import type { AttestationBundle } from "../src/artifacts/types.js";

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

const session = () => ({
  jobId: "isc-session-1",
  outcome: "completed",
  listingRef: { listingId: "lst-isc-1", version: 1, contentHash: "a".repeat(64) },
  agreementRef: {
    id: "dacs3:commit:isc-session-1",
    kind: "dacs-3-agreement",
    contentHash: "b".repeat(64),
  },
  phaseSummary: [
    { index: 0, kind: "vet-credentials", outcome: "ok" },
    { index: 1, kind: "commit", outcome: "ok" },
    { index: 2, kind: "settle", outcome: "ok" },
  ],
  vetRecords: [],
  settlementEvidence: [
    { id: "dacs4:payment:isc-session-1", kind: "dacs-4-evidence", contentHash: "c".repeat(64) },
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
  expect(sellerCopy).toBeDefined();
  return { buyerCopy, sellerCopy: sellerCopy as AttestationBundle };
}

const asRecord = (b: AttestationBundle) => b as unknown as Record<string, unknown>;

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

  test("ISC-7: each signature verifies over 'dacs-bundle:v1:' || attestation_bundle_hash", async () => {
    const { buyerCopy } = await bothCopies();
    const payload = Buffer.concat([
      Buffer.from("dacs-bundle:v1:", "utf8"),
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

  test("ISC-8 GOLDEN: the producer REGENERATES the golden bundle from its own field values", async () => {
    // The real proof: feed practice-dacs-0001's fields back through buildTwoSidedBundle and
    // require the emitted copies to reproduce the foreign producer's canonical form and hash.
    // Signatures sit outside the hashed scope, so stub signers are fine — the canonical body
    // assembly is what is under test.
    const g = golden("buyer");
    const stub = () => new Uint8Array(64);
    const partyOf = (role: "buyer" | "seller") => {
      const p = g.parties.find((x) => x.role === role)!;
      return { primaryClaim: p.primaryClaim, bundleHash: p.bundleHash, signer: stub };
    };

    const { buyerCopy, sellerCopy } = await buildTwoSidedBundle({
      jobId: g.jobId,
      outcome: g.outcome,
      listingRef: g.listingRef,
      agreementRef: g.agreementRef,
      phaseSummary: g.phaseSummary,
      vetRecords: g.vetRecords,
      settlementEvidence: g.settlementEvidence,
      recipeRegistryVersion: g.recipeRegistryVersion,
      railRegistryVersion: g.railRegistryVersion,
      finalisedAt: g.finalisedAt,
      bundleVersion: g.bundleVersion,
      buyer: partyOf("buyer"),
      seller: partyOf("seller"),
    });

    expect(sellerCopy).toBeDefined();
    expect(attestationBundleHash(buyerCopy)).toBe(GOLDEN_HASH);
    expect(attestationBundleHash(sellerCopy as AttestationBundle)).toBe(GOLDEN_HASH);
    // The canonical bytes themselves, not merely their digest.
    expect(bundleSignedScope(buyerCopy)).toEqual(bundleSignedScope(golden("buyer")));
    expect(bundleSignedScope(sellerCopy as AttestationBundle)).toEqual(
      bundleSignedScope(golden("seller")),
    );
  });

  test("ISC-10: an abort outcome MAY be single-signed (§10.11 suppression)", async () => {
    const s = { ...session(), outcome: "aborted-by-other", seller: undefined };
    const { buyerCopy, sellerCopy } = await buildTwoSidedBundle(s);
    expect(buyerCopy.signatures).toHaveLength(1);
    expect(buyerCopy.outcome).toBe("aborted-by-other");
    expect(sellerCopy).toBeUndefined();
  });

  test("ISC-11 ANTI: never emits a single-signed non-abort bundle", async () => {
    // The exact defect class found on all 10 live DACS Directory roster deals.
    for (const outcome of ["completed", "failed-counterparty", "failed-substrate"]) {
      const s = { ...session(), outcome, seller: undefined };
      await expect(buildTwoSidedBundle(s)).rejects.toThrow(/two signatures/i);
    }
  });

  test("BUNDLE_SIGNED_SCOPE_OMIT is the single source for the omission set", () => {
    expect([...BUNDLE_SIGNED_SCOPE_OMIT].sort()).toEqual(["anchoredByRole", "signatures"]);
  });
});
