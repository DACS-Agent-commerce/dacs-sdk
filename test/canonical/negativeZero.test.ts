import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  admitRawJson,
  canonicalize,
  canonicalSignedScope,
  contentHash,
  sha256Hex,
  stripSignature,
} from "../../src/canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../../src/canonical/snapshot.js";
import {
  publicKeyFromSeed,
  rawPublicKey,
  signArtifact,
  verifyArtifact,
} from "../../src/crypto/index.js";

interface RawVector {
  name: string;
  rawUtf8Text?: string;
  expected: "accept" | "reject";
  canonicalUtf8Hex?: string;
}
interface CanonicalVector {
  name: string;
  input: unknown;
  expected: "pass" | "fail";
  canonicalUtf8Hex?: string;
}

// Byte-exact upstream corpora; provenance in test/fixtures/standard-next/README.md.
const rawCorpus = JSON.parse(readFileSync(new URL(
  "../fixtures/standard-next/raw-json-profile-v0.1.json", import.meta.url,
), "utf8")) as { vectors: RawVector[] };
const canonicalCorpus = JSON.parse(readFileSync(new URL(
  "../fixtures/standard-next/canonical-json-v0.1.json", import.meta.url,
), "utf8")) as { vectors: CanonicalVector[] };

const seed = Uint8Array.from(Buffer.alloc(32, 7));
const publicKey = rawPublicKey(publicKeyFromSeed(seed));

const admit = (text: string) =>
  admitRawJson(Buffer.from(text, "utf8")) as Record<string, unknown>;

/** True when every number in a JSON graph is +0-safe (no negative zero). */
function hasNegativeZero(value: unknown): boolean {
  if (typeof value === "number") return Object.is(value, -0);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(hasNegativeZero);
}

// CORE §B.2: negative zero is an in-profile JSON number that "serialises as 0";
// CF-5 item 4 lets it "proceed to ordinary JCS serialisation". Admission and
// the signed-scope hash must therefore agree on every admitted value.
describe("negative zero across admission, hashing and verification", () => {
  it("admits, canonicalizes, hashes and verifies the Standard negative-zero vector", () => {
    const vector = rawCorpus.vectors.find((v) => v.name === "negative-zero")!;
    expect(vector).toMatchObject({
      rawUtf8Text: '{"n":-0.0}',
      expected: "accept",
      canonicalUtf8Hex: "7b226e223a307d",
    });

    const admitted = admit(vector.rawUtf8Text!);
    expect(Object.is(admitted["n"], -0)).toBe(true);
    const canonicalBytes = Buffer.from(canonicalize(admitted), "utf8");
    expect(canonicalBytes.toString("hex")).toBe(vector.canonicalUtf8Hex);

    expect(canonicalSignedScope(admitted)).toBe('{"n":0}');
    expect(contentHash(admitted)).toBe(sha256Hex(canonicalBytes));
    expect(contentHash(admitted)).toBe(contentHash({ n: 0 }));

    const overZero = signArtifact("dacs-listing:v1:", { n: 0 }, seed);
    expect(verifyArtifact("dacs-listing:v1:", admitted, overZero, publicKey))
      .toBe(true);
    const overAdmitted = signArtifact("dacs-listing:v1:", admitted, seed);
    expect(verifyArtifact("dacs-listing:v1:", { n: 0 }, overAdmitted, publicKey))
      .toBe(true);
    expect(verifyArtifact("dacs-listing:v1:", { n: 1 }, overAdmitted, publicKey))
      .toBe(false);
  });

  it("hashes every accepted object vector to the sha256 of its canonical bytes", () => {
    const accepted = rawCorpus.vectors.filter((v) =>
      v.expected === "accept" && v.rawUtf8Text?.trimStart().startsWith("{")
    );
    // Includes the -0.0 and -0e... / -0.0e-... zero spellings.
    expect(accepted.map((v) => v.name)).toEqual(expect.arrayContaining([
      "negative-zero",
      "zero-extreme-exponent-1",
      "zero-extreme-exponent-3",
    ]));
    for (const vector of accepted) {
      const admitted = admit(vector.rawUtf8Text!);
      expect(contentHash(admitted), vector.name)
        .toBe(sha256Hex(Buffer.from(vector.canonicalUtf8Hex!, "hex")));
    }
  });

  it("hashes the canonical-json binary64 negative-zero vector as zero", () => {
    const vector = canonicalCorpus.vectors.find((v) => v.name === "negative-zero")!;
    expect(vector).toMatchObject({
      input: { $dacsType: "binary64", hex: "8000000000000000" },
      expected: "pass",
      canonicalUtf8Hex: "30",
    });
    const negativeZero = Buffer.from("8000000000000000", "hex").readDoubleBE(0);
    expect(Object.is(negativeZero, -0)).toBe(true);

    expect(Buffer.from(canonicalize(negativeZero)).toString("hex"))
      .toBe(vector.canonicalUtf8Hex);
    expect(contentHash({ n: negativeZero })).toBe(contentHash({ n: 0 }));
  });

  it("normalizes nested negative zero in objects and arrays to zero", () => {
    const admitted = admit(
      '{"a":{"b":-0.0,"c":[-0,0,{"d":-0e5}]},"e":[[-0.0]],"signature":"00"}',
    );
    expect(hasNegativeZero(admitted)).toBe(true);

    const scope = stripSignature(admitted);
    expect(scope).toEqual({ a: { b: 0, c: [0, 0, { d: 0 }] }, e: [[0]] });
    expect(hasNegativeZero(scope)).toBe(false);
    expect(canonicalSignedScope(admitted))
      .toBe('{"a":{"b":0,"c":[0,0,{"d":0}]},"e":[[0]]}');
    expect(contentHash(admitted)).toBe(
      contentHash({ a: { b: 0, c: [0, 0, { d: 0 }] }, e: [[0]] }),
    );

    const owned = snapshotCanonicalJsonRead(admitted, "received artifact");
    expect(hasNegativeZero(owned)).toBe(false);
    expect(canonicalize(owned)).toBe(canonicalize(admitted));
  });

  it("leaves positive zero and other numbers unchanged", () => {
    const zero = admit('{"n":0,"m":[0,-1,0.5]}');
    expect(Object.is(zero["n"], 0)).toBe(true);
    const scope = stripSignature(zero);
    expect(Object.is(scope["n"], 0)).toBe(true);
    expect(scope).toEqual({ n: 0, m: [0, -1, 0.5] });
    expect(canonicalSignedScope(zero)).toBe('{"m":[0,-1,0.5],"n":0}');
    expect(contentHash(zero)).toBe(sha256Hex('{"m":[0,-1,0.5],"n":0}'));
    expect(contentHash({ n: -1 })).not.toBe(contentHash({ n: 0 }));
  });

  it("keeps the local authoring boundary strict about negative zero", () => {
    // Producers refuse non-wire in-memory aliases before signing; only the
    // received-data read boundary owns the Standard's -0 => 0 serialisation.
    expect(() => snapshotCanonicalJson({ n: -0 }, "draft"))
      .toThrow(/draft is not stable canonical JSON/);
    expect(snapshotCanonicalJson({ n: 0 }, "draft")).toEqual({ n: 0 });
  });
});
