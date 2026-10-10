import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import { createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import {
  admitChannelMessage,
  canonicalize,
  canonicalChannelMessageSignedBytes,
  legacyChannelMessageSignedBytes,
  ed25519Verify,
  publicKeyFromRaw,
  prepareChannelMessageSigningInput,
  sha256Hex,
  CANONICAL_CHANNEL_MESSAGE_DOMAIN,
  type ChannelAdmissionContext,
  type ChannelMessageSignatureVerifier,
  type ChannelMessageSignatureV1,
  type ChannelProfileAdmission,
  type VerificationDecision,
} from "../../src/index.js";

const CHANNEL = "chan-session-7";
const SENDER =
  "cci:acdcc8494d458f44a7aaac1d6a84ec624daee88436db2ae26e67ba645a106228";
const FIRST_SIGNATURE =
  "23efcd16e7c72ba7596e9e7920cf54003379bdc044fbdfbd05a17b575da2ed39b149a7b99604cc41476ab14d881a782e0496ed6f64a98a8e229c80760cb14204";
const SECOND_SIGNATURE =
  "142614b9b424b7ba3a4981f62aab93a8c08ed8b467b2c6828b56763d7befd8276572657cf96146c98e69ea679abab3d24f1c8d5330f6aba38af9318d2adc0401";
const FIFTH_SIGNATURE =
  "86f535758d79d885e740e8019871c8cc9778d517c942568353f469387ff77b3091ccde061ea2e473cdce97c693b239f3093f8890f8fa8d10b3e86f5c79ccea09";
const OLD_CHANNEL_SIGNATURE =
  "ecd5a03258f042f604eaa80b4ceb196451b15856d372c6ac9543ef871904c8ecf6d5b3da13f3f25056c700fde4f93009742ba89f76876b4aeb6974b141237a0c";
const UNRESOLVABLE_SIGNATURE =
  "dbde1dd6bc3913a0e79f88aebb5e3ae3fbb8e163a05513908435f5859919f24cc94605a3cfa8df412b6cdf97e632c5ce5abddb30153be6378eb49b7e34554b0d";

/** Every pre-existing case in this file is the frozen historical Demos wire. */
const LEGACY = { operation: "legacy-import" } as const;

const CHANNEL_VECTORS = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/standard-next/channel-message-replay-v0.1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  count: number;
  vectors: Array<{
    name: string;
    expected: VerificationDecision;
    message: unknown;
    ctx: unknown;
  }>;
};

const context = (
  lastSequence = 0,
  sessionChannelId = CHANNEL,
  priorChannelIds: unknown[] = ["chan-session-1", "chan-session-2"],
): ChannelAdmissionContext =>
  ({
    sessionChannelId,
    lastSequence,
    priorChannelIds,
  }) as ChannelAdmissionContext;

const message = (
  sequence = 1,
  signature = FIRST_SIGNATURE,
  channelId = CHANNEL,
  sender = SENDER,
  body: unknown = { price: "10" },
) => ({
  channelId,
  sequence,
  sender,
  sentAt: 1_750_000_000_000,
  type: "offer" as const,
  body,
  signature,
});

/**
 * Compatibility verifier for the adopted v0.1 vector corpus. DACS-Standard#349
 * tracks that these vectors use a raw digest and hex signature rather than the
 * current §8.5.1/SIG-6 representation. The SDK core deliberately does not bake
 * this historical framing into its public channel contract.
 */
const verifyStandardVectorSignature: ChannelMessageSignatureVerifier = ({
  message: candidate,
  envelopeHash,
}): VerificationDecision => {
  if (!candidate.sender.startsWith("cci:")) return "indeterminate";
  const rawKey = candidate.sender.slice("cci:".length);
  if (!/^[0-9a-f]{64}$/.test(rawKey)) return "indeterminate";
  if (
    typeof candidate.signature !== "string" ||
    !/^[0-9a-f]{128}$/.test(candidate.signature)
  )
    return "fail";
  try {
    const bytes = Buffer.concat([
      Buffer.from("dacs-channelmsg:v1:", "utf8"),
      Buffer.from(envelopeHash, "hex"),
    ]);
    return ed25519Verify(
      bytes,
      Buffer.from(candidate.signature, "hex"),
      publicKeyFromRaw(Buffer.from(rawKey, "hex")),
    )
      ? "pass"
      : "fail";
  } catch {
    return "error";
  }
};

describe("DACS-3 channel admission", () => {
  test("replays the exact adopted-next channel corpus without collapsing decisions", async () => {
    expect(CHANNEL_VECTORS.vectors).toHaveLength(CHANNEL_VECTORS.count);
    for (const vector of CHANNEL_VECTORS.vectors) {
      const result = await admitChannelMessage(vector.message, vector.ctx, verifyStandardVectorSignature, LEGACY);
      expect(result.decision, vector.name).toBe(vector.expected);
    }
  });

  test.each([
    {
      name: "valid-first-message",
      candidate: message(),
      ctx: context(),
      expected: "pass",
    },
    {
      name: "valid-next-message",
      candidate: message(2, SECOND_SIGNATURE),
      ctx: context(1),
      expected: "pass",
    },
    {
      name: "valid-sequence-gap",
      candidate: message(5, FIFTH_SIGNATURE),
      ctx: context(2),
      expected: "pass",
    },
    {
      name: "replay-duplicate-sequence",
      candidate: message(
        3,
        "c3c811ea1821ebc5e9ea12905381810abb45b2d87348377aa64d6fe67fcf868c3b9c61631d504c432490056c617c949a2ea051fa6008a0decffa9ec5ddd5830e",
      ),
      ctx: context(3),
      expected: "fail",
    },
    {
      name: "replay-decreasing-sequence",
      candidate: message(2, SECOND_SIGNATURE),
      ctx: context(5),
      expected: "fail",
    },
    {
      name: "foreign-channel-message",
      candidate: message(1, OLD_CHANNEL_SIGNATURE, "chan-session-1"),
      ctx: context(),
      expected: "fail",
    },
    {
      name: "rechannelled-message-sig-breaks",
      candidate: message(1, OLD_CHANNEL_SIGNATURE),
      ctx: context(),
      expected: "fail",
    },
    {
      name: "ch6-channelId-reused",
      candidate: message(),
      ctx: context(0, "chan-session-1"),
      expected: "fail",
    },
    {
      name: "tampered-signature",
      candidate: message(1, "a".repeat(128)),
      ctx: context(),
      expected: "fail",
    },
    {
      name: "tampered-body-after-signing",
      candidate: message(1, FIRST_SIGNATURE, CHANNEL, SENDER, { price: "999" }),
      ctx: context(),
      expected: "fail",
    },
    {
      name: "sender-not-cci",
      candidate: message(
        1,
        UNRESOLVABLE_SIGNATURE,
        CHANNEL,
        "did:demos:placeholder",
      ),
      ctx: context(),
      expected: "indeterminate",
    },
    {
      name: "malformed-missing-channelId",
      candidate: {
        sequence: 1,
        sender: SENDER,
        sentAt: 1,
        type: "offer",
        body: {},
        signature: "x",
      },
      ctx: context(),
      expected: "error",
    },
    {
      name: "sequence-below-one",
      candidate: message(
        0,
        "a255aae7a0f58c5a8caf49cabdb2beca6c999cf686e0626eca80f69491f2b29d5916a59e2437f4fe0bb2843736f866256079e62fa35722c51b5116ebb5d2cc0c",
      ),
      ctx: context(),
      expected: "error",
    },
    {
      name: "ctx-fractional-lastSequence",
      candidate: message(2, SECOND_SIGNATURE),
      ctx: context(1.5),
      expected: "error",
    },
    {
      name: "ctx-priorChannelIds-bad-element",
      candidate: message(),
      ctx: context(0, CHANNEL, [123]),
      expected: "error",
    },
  ])(
    "replays Standard vector $name as $expected",
    async ({ candidate, ctx, expected }) => {
      const result = await admitChannelMessage(candidate, ctx, verifyStandardVectorSignature, LEGACY);
      expect(result.decision).toBe(expected);
    },
  );

  test("exposes the exact unsigned envelope hash and immutable owned callback data", async () => {
    const candidate = message(1, FIRST_SIGNATURE, CHANNEL, SENDER, {
      nested: { signature: "this-is-body-data" },
    });
    const verifier = vi.fn<ChannelMessageSignatureVerifier>((input) => {
      expect(input.envelopeHash).toBe(
        "053b5126d2f75ae0869d36df5672371c7b3f3feb45ec36c3c7f63cf2c3c94441",
      );
      expect(input.unsignedEnvelope).not.toHaveProperty("signature");
      expect(input.unsignedEnvelope.body).toEqual({
        nested: { signature: "this-is-body-data" },
      });
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.message)).toBe(true);
      expect(Object.isFrozen(input.message.body)).toBe(true);
      return "pass";
    });

    const result = await admitChannelMessage(candidate, context(), verifier, LEGACY);
    candidate.body = { changed: true };

    expect(result.decision).toBe("pass");
    if (result.decision === "pass") {
      expect(result.message.body).toEqual({
        nested: { signature: "this-is-body-data" },
      });
    }
    expect(verifier).toHaveBeenCalledOnce();
  });

  test("prepares the same immutable digest for a producer, current wire only", () => {
    const candidate = {
      canonicalChannelMessageVersion: "1",
      channelId: CHANNEL,
      sequence: 1,
      sender: `key:${"ab".repeat(32)}`,
      sentAt: 1_750_000_000_000,
      type: "offer",
      body: { nested: { signature: "ordinary-body-data" } },
    };
    const prepared = prepareChannelMessageSigningInput(candidate);
    candidate.body = { nested: { signature: "changed-after-capture" } };

    expect(prepared.envelopeHash).toBe(
      "656b0c8de65efedbd633d60a6f6eecdc0142fb72278c1c7d78b8bf48ad628be3",
    );
    expect(prepared.operation).toBe("current-read");
    expect(prepared.unsignedEnvelope.body).toEqual({
      nested: { signature: "ordinary-body-data" },
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.unsignedEnvelope.body)).toBe(true);
    expect(() => prepareChannelMessageSigningInput({
      ...candidate,
      signature: "must-not-be-present-yet",
    })).toThrow(/omit signature/);
    // The frozen historical envelope (no discriminator) is not a producer
    // input: CH-10 says new producers MUST NOT emit it, so there is no
    // option that returns its bytes.
    const { canonicalChannelMessageVersion: _v, ...historical } = candidate;
    expect(() => prepareChannelMessageSigningInput(historical)).toThrow(/malformed/);
    // SIG-5: an unknown top-level member is retained inside the signed scope.
    const extended = prepareChannelMessageSigningInput({
      ...candidate,
      transportRouting: "inside-the-signed-envelope",
    });
    expect(extended.unsignedEnvelope).toHaveProperty("transportRouting");
    expect(extended.envelopeHash).not.toBe(prepared.envelopeHash);
  });

  test.each([
    ["verifier fail", async () => "fail" as const, "fail"],
    [
      "verifier indeterminate",
      async () => "indeterminate" as const,
      "indeterminate",
    ],
    ["verifier error", async () => "error" as const, "error"],
    ["malformed verifier result", async () => "yes", "error"],
    [
      "throwing verifier",
      async () => {
        throw new Error("offline");
      },
      "error",
    ],
  ])(
    "preserves %s without collapsing it",
    async (_name, verifier, expected) => {
      const result = await admitChannelMessage(
        message(),
        context(),
        verifier as ChannelMessageSignatureVerifier,
        LEGACY,
      );
      expect(result.decision).toBe(expected);
    },
  );

  test("rejects malformed live JavaScript graphs before the verifier boundary", async () => {
    const verifier = vi.fn<ChannelMessageSignatureVerifier>(() => "pass");
    const accessor = message() as Record<string, unknown>;
    Object.defineProperty(accessor, "body", {
      enumerable: true,
      get: () => ({ price: "10" }),
    });
    const sparse = message();
    sparse.body = new Array(2);

    await expect(
      admitChannelMessage(accessor, context(), verifier, LEGACY),
    ).resolves.toMatchObject({ decision: "error" });
    await expect(
      admitChannelMessage(new Proxy(message(), {}), context(), verifier, LEGACY),
    ).resolves.toMatchObject({ decision: "error" });
    await expect(
      admitChannelMessage(sparse, context(), verifier, LEGACY),
    ).resolves.toMatchObject({ decision: "error" });
    expect(verifier).not.toHaveBeenCalled();
  });

  test("does not invoke signature verification for replay failures", async () => {
    const verifier = vi.fn<ChannelMessageSignatureVerifier>(() => "pass");
    const result = await admitChannelMessage(message(), context(1), verifier, LEGACY);
    expect(result.decision).toBe("fail");
    expect(verifier).not.toHaveBeenCalled();
  });
});


/* -------------------------------------------------------------------------- */
/* DACS-3 v0.6 CanonicalChannelMessage (DACS-Standard PR #367, SDK #330)       */
/* -------------------------------------------------------------------------- */

const CANONICAL_CORPUS = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/standard-next/canonical-channel-message-v0.6.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  set: string;
  count: number;
  authenticatedKeyFixtures: Array<{ claim: string; algorithm: string; publicKey: string }>;
  correctiveProfileFixture: { releasePin: string; moduleVersions: Record<string, string> };
  vectors: Array<{
    name: string;
    expected: VerificationDecision;
    operation: "current-read" | "legacy-import";
    note?: string;
    message: unknown;
    ctx: unknown;
    profileAdmission?: unknown;
  }>;
};

/** The fixture's verifier-owned CH-1 roster (participantIdentities of every valid vector). */
const CORPUS_ROSTER = [
  "did:example:dacs-349-ecdsa",
  "did:example:dacs-349-sr1-root",
  "did:example:unresolved",
  "key:e70a5bcf97758337d7191df8e32ddd310933ce077937e36723b8b3be4dd69f57",
  "key:ea0c2afe8504c5500e1c28d05d4a2f214c076c8fc2c0db3225d13d1c1513d693",
];
const LEGACY_ROSTER = [
  "cci:e70a5bcf97758337d7191df8e32ddd310933ce077937e36723b8b3be4dd69f57",
  "cci:acdcc8494d458f44a7aaac1d6a84ec624daee88436db2ae26e67ba645a106228",
];
/** Vectors whose only unimplemented step is SR-1 aggregate verification. */
const SR1_VECTORS = new Set([
  "canonical-sr1-aggregate-valid",
  "canonical-sr1-aggregate-tampered-body",
  "canonical-sr1-aggregate-cross-domain",
  "canonical-sr1-aggregate-raw-digest-framing",
]);

const SECP256K1_P = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F");
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}
function secp256k1Key(compressed: Uint8Array): KeyObject | null {
  if (compressed.length !== 33) return null;
  const x = BigInt(`0x${Buffer.from(compressed.subarray(1)).toString("hex")}`);
  const rhs = (modPow(x, 3n, SECP256K1_P) + 7n) % SECP256K1_P;
  let y = modPow(rhs, (SECP256K1_P + 1n) / 4n, SECP256K1_P);
  if ((y * y) % SECP256K1_P !== rhs) return null;
  if ((y & 1n) !== BigInt(compressed[0]! & 1)) y = SECP256K1_P - y;
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(x.toString(16).padStart(64, "0"), "hex"),
    Buffer.from(y.toString(16).padStart(64, "0"), "hex"),
  ]);
  const prefix = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");
  return createPublicKey({ key: Buffer.concat([prefix, point]), format: "der", type: "spki" });
}
function lowSDer(der: Buffer): boolean {
  if (der[0] !== 0x30 || der[1] !== der.length - 2 || der[2] !== 0x02) return false;
  const rLen = der[3]!;
  const sStart = 4 + rLen;
  if (der[sStart] !== 0x02) return false;
  const sLen = der[sStart + 1]!;
  const s = der.subarray(sStart + 2, sStart + 2 + sLen);
  if (sStart + 2 + sLen !== der.length || (s[0]! & 0x80) !== 0) return false;
  const sv = BigInt(`0x${s.toString("hex")}`);
  return sv > 0n && sv <= SECP256K1_N / 2n;
}
function identityOf(claim: string): string {
  const q = claim.indexOf("?");
  return q === -1 ? claim : claim.slice(0, q);
}

/**
 * Adapter-side verifier for the corpus: membership against the fixed roster,
 * key resolution from the sender claim or the fixture table, then algorithm
 * dispatch over the SDK-supplied `signedBytes`. The SDK owns structural
 * selection, replay gates and framing; the adapter owns keys.
 */
function corpusVerifier(roster: readonly string[]): ChannelMessageSignatureVerifier {
  return ({ message: candidate, signedBytes, operation }) => {
    const sender = identityOf(candidate.sender);
    if (roster.filter((member) => identityOf(member) === sender).length !== 1) return "fail";
    if (operation === "legacy-import") {
      const raw = /^cci:([0-9a-f]{64})$/.exec(sender);
      if (raw === null) return "indeterminate";
      try {
        return ed25519Verify(signedBytes, Buffer.from(candidate.signature as string, "hex"), publicKeyFromRaw(Buffer.from(raw[1]!, "hex")))
          ? "pass" : "fail";
      } catch { return "error"; }
    }
    const signature = candidate.signature as ChannelMessageSignatureV1;
    const fixture = CANONICAL_CORPUS.authenticatedKeyFixtures.find((f) => f.claim === sender);
    const keyClaim = /^key:([0-9a-f]{64})$/.exec(sender);
    const algorithm = fixture?.algorithm ?? (keyClaim ? "ed25519" : null);
    if (algorithm === null) return "indeterminate";
    if (algorithm !== signature.algorithm) return "fail";
    const value = Buffer.from(signature.value, "base64url");
    try {
      if (algorithm === "ed25519") {
        if (value.length !== 64) return "fail";
        return ed25519Verify(signedBytes, value, publicKeyFromRaw(Buffer.from(keyClaim![1]!, "hex"))) ? "pass" : "fail";
      }
      if (algorithm === "ecdsa-secp256k1") {
        const key = secp256k1Key(Buffer.from(fixture!.publicKey, "hex"));
        if (key === null) return "indeterminate";
        if (!lowSDer(value)) return "fail";
        return nodeVerify("sha256", signedBytes, { key, dsaEncoding: "der" }, value) ? "pass" : "fail";
      }
      return "indeterminate"; // sr1-aggregate: no verifier available here
    } catch {
      return "fail";
    }
  };
}

/**
 * The deployment's exact CORE §11.1.2 corrective profile: the fixture's
 * release pin and complete module tuple.
 */
const CORRECTIVE_PROFILE = {
  releasePin: CANONICAL_CORPUS.correctiveProfileFixture.releasePin,
  moduleVersions: CANONICAL_CORPUS.correctiveProfileFixture.moduleVersions,
};

/** Verifier-owned profile admission whose authority binds `participants` on `sessionId`. */
function admittedProfile(participants: readonly string[], sessionId = CHANNEL): ChannelProfileAdmission {
  return {
    profile: CORRECTIVE_PROFILE,
    participantIdentities: participants,
    authority: { authenticated: true, sessionId, participantIdentities: participants, ...CORRECTIVE_PROFILE },
  };
}

describe("CH-7 membership before cryptography", () => {
  const memberKeys = generateKeyPairSync("ed25519");
  const outsiderKeys = generateKeyPairSync("ed25519");
  const claimOf = (keys: { publicKey: KeyObject }) =>
    `key:${(keys.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex")}`;
  const MEMBER = claimOf(memberKeys);
  const OUTSIDER = claimOf(outsiderKeys);
  const registry = new Map([[MEMBER, memberKeys.publicKey], [OUTSIDER, outsiderKeys.publicKey]]);
  /** Signature-only: resolves any registered key and does no membership lookup of its own. */
  const signatureOnly: ChannelMessageSignatureVerifier = ({ message: m, signedBytes }) => {
    const key = registry.get(identityOf(m.sender));
    const signature = m.signature as ChannelMessageSignatureV1;
    return key !== undefined && ed25519Verify(signedBytes, Buffer.from(signature.value, "base64url"), key)
      ? "pass" : "fail";
  };
  function signedBy(keys: { privateKey: KeyObject }, sender: string) {
    const input = prepareChannelMessageSigningInput({
      canonicalChannelMessageVersion: "1",
      channelId: CHANNEL,
      sequence: 1,
      sender,
      sentAt: 1_750_000_000_000,
      type: "offer",
      body: { price: "10" },
    });
    const value = nodeSign(null, Buffer.from(input.signedBytes), keys.privateKey).toString("base64url");
    return {
      ...structuredClone(input.unsignedEnvelope),
      signature: { signatureVersion: "1", signer: sender, algorithm: "ed25519", value },
    };
  }

  test("a valid signature by a non-member is fail and the verifier is never called", async () => {
    const verifier = vi.fn(signatureOnly);
    const message = signedBy(outsiderKeys, OUTSIDER);
    expect(await admitChannelMessage(message, context(), verifier, { profileAdmission: admittedProfile([MEMBER]) }))
      .toEqual({ decision: "fail", reason: "sender is not a member of the channel (CH-7)" });
    // A member set that names the sender twice, or no member set at all, is a
    // profile-admission refusal, also before any cryptography.
    expect((await admitChannelMessage(message, context(), verifier, {
      profileAdmission: admittedProfile([OUTSIDER, `${OUTSIDER}?role=buyer`]),
    })).decision).toBe("error");
    expect((await admitChannelMessage(message, context(), verifier)).decision).toBe("indeterminate");
    expect(verifier).not.toHaveBeenCalled();
    // The signature itself is valid: inside the set the same message passes.
    expect((await admitChannelMessage(message, context(), verifier, {
      profileAdmission: admittedProfile([MEMBER, OUTSIDER]),
    })).decision).toBe("pass");
  });

  test("a parameter-only variant of a member is admitted as that member", async () => {
    const verifier = vi.fn(signatureOnly);
    const result = await admitChannelMessage(signedBy(memberKeys, `${MEMBER}?role=buyer`), context(), verifier, {
      profileAdmission: admittedProfile([MEMBER, OUTSIDER]),
    });
    expect(result.decision).toBe("pass");
    expect(verifier).toHaveBeenCalledOnce();
    expect(verifier.mock.calls[0]![0].member).toBe(MEMBER);
  });

  test("optional admission members are read only as own properties", async () => {
    const message = signedBy(memberKeys, MEMBER);
    const verifier = vi.fn(signatureOnly);
    const inherited = async (key: string, value: unknown, run: () => Promise<void>) => {
      Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false });
      try {
        await run();
      } finally {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    };
    await inherited("profileAdmission", admittedProfile([MEMBER]), async () => {
      expect((await admitChannelMessage(message, context(), verifier)).decision).toBe("indeterminate");
      expect((await admitChannelMessage(message, context(), verifier, { operation: "current-read" })).decision)
        .toBe("indeterminate");
    });
    await inherited("authority", admittedProfile([MEMBER]).authority, async () => {
      expect((await admitChannelMessage(message, context(), verifier, {
        profileAdmission: { profile: CORRECTIVE_PROFILE, participantIdentities: [MEMBER] },
      })).decision).toBe("indeterminate");
    });
    expect(verifier).not.toHaveBeenCalled();
    // An inherited operation or source changes nothing about an own capability.
    await inherited("operation", "legacy-import", async () => {
      expect((await admitChannelMessage(message, context(), verifier, {
        profileAdmission: admittedProfile([MEMBER]),
      })).decision).toBe("pass");
    });
    await inherited("source", 1, async () => {
      expect((await admitChannelMessage(message, context(), verifier, {
        profileAdmission: admittedProfile([MEMBER]),
      })).decision).toBe("pass");
    });
  });
});

describe("DACS-3 v0.6 CanonicalChannelMessage admission", () => {
  const keys = generateKeyPairSync("ed25519");
  const rawKey = (keys.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const claim = `key:${rawKey.toString("hex")}`;
  const CURRENT = { profileAdmission: admittedProfile([claim]) };
  const unsigned = {
    canonicalChannelMessageVersion: "1" as const,
    channelId: CHANNEL,
    sequence: 1,
    sender: claim,
    sentAt: 1_750_000_000_000,
    type: "offer" as const,
    body: { price: "10" },
    experimentalHint: { future: true },
  };
  const verifier: ChannelMessageSignatureVerifier = ({ message: m, signedBytes, operation }) => {
    const signature = m.signature as ChannelMessageSignatureV1;
    return operation === "current-read" && signature.signer === m.sender &&
      ed25519Verify(signedBytes, Buffer.from(signature.value, "base64url"), keys.publicKey)
      ? "pass" : "fail";
  };
  async function produce(envelope: Record<string, unknown> = unsigned) {
    const input = prepareChannelMessageSigningInput(envelope);
    const value = nodeSign(null, Buffer.from(input.signedBytes), keys.privateKey).toString("base64url");
    // The signing input is deeply frozen; hand the reader an owned copy.
    return { ...structuredClone(input.unsignedEnvelope), signature: { signatureVersion: "1", signer: claim, algorithm: "ed25519", value } };
  }

  test("producer signs CH-8 bytes and a current-read admits the exact message, retaining unknown members", async () => {
    const input = prepareChannelMessageSigningInput(unsigned);
    expect(input.operation).toBe("current-read");
    expect(Buffer.from(input.signedBytes).toString("utf8")).toBe(`${CANONICAL_CHANNEL_MESSAGE_DOMAIN}${input.envelopeHash}`);
    expect(input.unsignedEnvelope).toHaveProperty("experimentalHint");
    const signed = await produce();
    const admitted = await admitChannelMessage(signed, context(), verifier, CURRENT);
    expect(admitted.decision).toBe("pass");
    if (admitted.decision === "pass") {
      expect(admitted.envelopeHash).toBe(input.envelopeHash);
      expect(admitted.unsignedEnvelope).toHaveProperty("experimentalHint");
      expect(admitted.operation).toBe("current-read");
    }
    // Stripping the unknown member changes the signed scope.
    const { experimentalHint: _hint, ...stripped } = signed as Record<string, unknown>;
    expect((await admitChannelMessage(stripped, context(), verifier, CURRENT)).decision).toBe("fail");
  });

  test("never falls back between arms", async () => {
    const signed = await produce();
    expect((await admitChannelMessage(signed, context(), verifier, LEGACY)).decision).toBe("error");
    expect((await admitChannelMessage(message(), context(), verifyStandardVectorSignature, CURRENT)).decision).toBe("error");
    const { canonicalChannelMessageVersion: _v, ...undiscriminated } = signed;
    expect((await admitChannelMessage(undiscriminated, context(), verifier, CURRENT)).decision).toBe("error");
    expect((await admitChannelMessage({ ...signed, signature: FIRST_SIGNATURE }, context(), verifier, CURRENT)).decision).toBe("error");
    // Producer side is current-only (F-332-1): the signing input never carries
    // the frozen wire's `dacs-channelmsg:v1:` || raw-digest bytes.
    const prepared = prepareChannelMessageSigningInput(unsigned);
    expect(prepared.operation).toBe("current-read");
    expect(Buffer.from(prepared.signedBytes).equals(
      Buffer.concat([Buffer.from("dacs-channelmsg:v1:", "utf8"), Buffer.from(prepared.envelopeHash, "hex")]),
    )).toBe(false);
  });

  test("refuses a signer that does not identify the sender and an unregistered sender scheme", async () => {
    const signed = await produce();
    const other = { ...signed, signature: { ...signed.signature, signer: `key:${"0".repeat(64)}` } };
    expect((await admitChannelMessage(other, context(), verifier, CURRENT)).decision).toBe("fail");
    expect((await admitChannelMessage({ ...signed, sender: `cci:${rawKey.toString("hex")}`, signature: { ...signed.signature, signer: `cci:${rawKey.toString("hex")}` } }, context(), verifier, CURRENT)).decision).toBe("error");
    expect((await admitChannelMessage({ ...signed, signature: { ...signed.signature, value: `${signed.signature.value}=` } }, context(), verifier, CURRENT)).decision).toBe("error");
  });

  test("refuses the demosdk 4.0.11–4.0.18 wire and its demos:0x sender on both operations (DACS-Standard#414)", async () => {
    const senderHex = rawKey.toString("hex");
    const unsignedDemos = { channelId: CHANNEL, sequence: 1, sender: `demos:0x${senderHex}`, sentAt: 1_750_000_000_000, type: "offer" as const, body: { price: "10" } };
    const digestHex = sha256Hex(canonicalize(unsignedDemos));
    // demosdk: UTF8("dacs-channelmsg:v1:" + hex-ASCII digest), signature { sigVersion, "0x" + hex }
    const demosdkSignature = `0x${nodeSign(null, Buffer.from(`dacs-channelmsg:v1:${digestHex}`, "utf8"), keys.privateKey).toString("hex")}`;
    const demosdkMessage = { ...unsignedDemos, signature: { sigVersion: "1", signature: demosdkSignature } };
    expect((await admitChannelMessage(demosdkMessage, context(), () => "pass", CURRENT)).decision).toBe("error");
    expect((await admitChannelMessage(demosdkMessage, context(), () => "pass", LEGACY)).decision).toBe("error");
    // Frozen-arm bytes but the unregistered demos:0x sender: outside the historical registry.
    const frozenBytes = Buffer.concat([Buffer.from("dacs-channelmsg:v1:", "utf8"), Buffer.from(digestHex, "hex")]);
    const frozenShape = { ...unsignedDemos, signature: nodeSign(null, frozenBytes, keys.privateKey).toString("hex") };
    expect((await admitChannelMessage(frozenShape, context(), () => "pass", LEGACY)).decision).toBe("error");
    expect((await admitChannelMessage(frozenShape, context(), () => "pass", CURRENT)).decision).toBe("error");
    // The same frozen-arm bytes under the historical cci: scheme are importable.
    const cci = { ...unsignedDemos, sender: `cci:${senderHex}` };
    const cciBytes = Buffer.concat([Buffer.from("dacs-channelmsg:v1:", "utf8"), Buffer.from(sha256Hex(canonicalize(cci)), "hex")]);
    const cciShape = { ...cci, signature: nodeSign(null, cciBytes, keys.privateKey).toString("hex") };
    expect((await admitChannelMessage(cciShape, context(), () => "pass", LEGACY)).decision).toBe("pass");
  });

  test("a signer that does not parse is malformed input, not an attributable failure (F-332-2)", async () => {
    const signed = await produce();
    for (const signer of ["not a claim", " ", `cci:${rawKey.toString("hex")}`, "key:not-hex", "demos:0x" + rawKey.toString("hex")]) {
      expect((await admitChannelMessage({ ...signed, signature: { ...signed.signature, signer } }, context(), verifier, CURRENT)).decision, signer).toBe("error");
    }
    // Only a well-formed signer that names another party is the CH-7 `fail`.
    const other = { ...signed, signature: { ...signed.signature, signer: `key:${"0".repeat(64)}` } };
    expect((await admitChannelMessage(other, context(), verifier, CURRENT)).decision).toBe("fail");
  });

  test("legacy-import admits exactly the frozen historical sender grammar (F-332-3)", async () => {
    const senderHex = rawKey.toString("hex");
    const legacyShape = (sender: string) => {
      const envelope = { channelId: CHANNEL, sequence: 1, sender, sentAt: 1_750_000_000_000, type: "offer" as const, body: { price: "10" } };
      const bytes = Buffer.concat([Buffer.from("dacs-channelmsg:v1:", "utf8"), Buffer.from(sha256Hex(canonicalize(envelope)), "hex")]);
      return { ...envelope, signature: nodeSign(null, bytes, keys.privateKey).toString("hex") };
    };
    const reached: string[] = [];
    const recorder: ChannelMessageSignatureVerifier = ({ message: m }) => { reached.push(m.sender); return "pass"; };
    // The reference reader's parse_historical_claim_ref: cci:<64 lowercase hex> or did:<method>:<id>.
    const admitted = [`cci:${senderHex}`, "did:example:member"];
    const refused = [
      `key:${senderHex}`, `cci-xm:evm:mainnet:0x${senderHex}`, "lei:5493001kjtiigc8y1r12", "cci:not-hex",
      `cci:${senderHex.slice(0, 62)}`, `demos:0x${senderHex}`, "did:example", `cci:${senderHex}?v=1`, `CCI:${senderHex}`,
    ];
    for (const sender of admitted) {
      const result = await admitChannelMessage(legacyShape(sender), context(), recorder, LEGACY);
      expect(result.decision, sender).toBe("pass");
      if (result.decision === "pass") expect(result.operation).toBe("legacy-import");
    }
    for (const sender of refused) {
      expect((await admitChannelMessage(legacyShape(sender), context(), recorder, LEGACY)).decision, sender).toBe("error");
    }
    expect(reached).toEqual(admitted);
  });

  test("replays the canonical-channel-message-v0.6 corpus", async () => {
    expect(CANONICAL_CORPUS.set).toBe("canonical-channel-message-v0.6");
    expect(CANONICAL_CORPUS.vectors).toHaveLength(55);
    const current = corpusVerifier(CORPUS_ROSTER);
    const legacy = corpusVerifier(LEGACY_ROSTER);
    let matched = 0;
    for (const vector of CANONICAL_CORPUS.vectors) {
      // Every vector is decided by admitChannelMessage. A current-read gets the
      // verifier-owned capability: the deployment profile, the CH-1 roster and
      // the vector's authority (absent for current-profile-missing-authority).
      const options = vector.operation === "legacy-import"
        ? { operation: vector.operation }
        : {
            operation: vector.operation,
            profileAdmission: {
              profile: CORRECTIVE_PROFILE,
              participantIdentities: CORPUS_ROSTER,
              ...(vector.profileAdmission === undefined ? {} : { authority: vector.profileAdmission }),
            } as ChannelProfileAdmission,
          };
      const result = await admitChannelMessage(vector.message, vector.ctx, vector.operation === "legacy-import" ? legacy : current, options);
      if (SR1_VECTORS.has(vector.name)) {
        expect(result.decision, vector.name).toBe("indeterminate");
        continue;
      }
      expect(result.decision, `${vector.name}: ${vector.note ?? ""}`).toBe(vector.expected);
      matched += 1;
    }
    expect(matched).toBe(55 - SR1_VECTORS.size);
  });

  test("current-read without verifier-owned profile admission refuses the session (CORE §11.1.2(3))", async () => {
    const signed = await produce();
    const reached = vi.fn(verifier);
    // No capability, a capability without authority, and every current-profile-*
    // vector on its own: none may reach the verifier or pass.
    expect(await admitChannelMessage(signed, context(), reached)).toMatchObject({ decision: "indeterminate" });
    expect(await admitChannelMessage(signed, context(), reached, { operation: "current-read" })).toMatchObject({ decision: "indeterminate" });
    expect(await admitChannelMessage(signed, context(), reached, {
      profileAdmission: { profile: CORRECTIVE_PROFILE, participantIdentities: [claim] },
    })).toMatchObject({ decision: "indeterminate" });
    const profileVectors = CANONICAL_CORPUS.vectors.filter((vector) => vector.name.startsWith("current-profile-"));
    expect(profileVectors).toHaveLength(7);
    for (const vector of profileVectors) {
      expect((await admitChannelMessage(vector.message, vector.ctx, () => "pass")).decision, vector.name).toBe("indeterminate");
    }
    expect(reached).not.toHaveBeenCalled();
    // The legacy-import archival path does not consult profile admission.
    const legacyVector = CANONICAL_CORPUS.vectors.find((vector) => vector.name === "legacy-byte-preserving-read-only-import")!;
    expect((await admitChannelMessage(legacyVector.message, legacyVector.ctx, corpusVerifier(LEGACY_ROSTER), LEGACY)).decision).toBe("pass");
  });

  test("profile admission compares the complete module tuple and the capability shape", async () => {
    const signed = await produce();
    const withAuthority = (patch: Record<string, unknown>) => ({
      profileAdmission: { ...admittedProfile([claim]), authority: { ...admittedProfile([claim]).authority!, ...patch } },
    });
    expect((await admitChannelMessage(signed, context(), verifier, CURRENT)).decision).toBe("pass");
    // A complete tuple with a different module version is another profile.
    expect((await admitChannelMessage(signed, context(), verifier, withAuthority({
      moduleVersions: { ...CORRECTIVE_PROFILE.moduleVersions, dacs3: "0.5" },
    }))).decision).toBe("fail");
    // A partial or extended tuple is malformed.
    const { dacs5: _dacs5, ...partial } = CORRECTIVE_PROFILE.moduleVersions;
    expect((await admitChannelMessage(signed, context(), verifier, withAuthority({ moduleVersions: partial }))).decision).toBe("error");
    expect((await admitChannelMessage(signed, context(), verifier, withAuthority({
      moduleVersions: { ...CORRECTIVE_PROFILE.moduleVersions, dacs6: "0.1" },
    }))).decision).toBe("error");
    expect((await admitChannelMessage(signed, context(), verifier, withAuthority({
      moduleVersions: { ...partial, dacs6: "0.7" },
    }))).decision).toBe("error");
    // Participants compare by CF-3 identity; another party is a binding failure.
    expect((await admitChannelMessage(signed, context(), verifier, withAuthority({
      participantIdentities: [`${claim}?role=buyer`],
    }))).decision).toBe("pass");
    expect((await admitChannelMessage(signed, context(), verifier, withAuthority({
      participantIdentities: [`key:${"1".repeat(64)}`],
    }))).decision).toBe("fail");
    // A malformed capability is malformed input, never a pass.
    for (const profileAdmission of [
      null,
      { participantIdentities: [claim] },
      { ...admittedProfile([claim]), profile: { releasePin: CORRECTIVE_PROFILE.releasePin } },
      { ...admittedProfile([claim]), participantIdentities: [] },
      { ...admittedProfile([claim]), extra: true },
    ]) {
      expect((await admitChannelMessage(signed, context(), verifier, { profileAdmission } as never)).decision, JSON.stringify(profileAdmission)).toBe("error");
    }
  });

  test("signed-byte helpers require a 64-character lowercase hex hash", () => {
    const hash = "ab".repeat(32);
    expect(Buffer.from(canonicalChannelMessageSignedBytes(hash)).toString("utf8")).toBe(`${CANONICAL_CHANNEL_MESSAGE_DOMAIN}${hash}`);
    expect(legacyChannelMessageSignedBytes(hash)).toHaveLength("dacs-channelmsg:v1:".length + 32);
    for (const bad of [hash.toUpperCase(), hash.slice(0, 63), `${hash}0`, `${hash.slice(0, 62)}zz`, `0x${hash.slice(2)}`, ""]) {
      expect(() => canonicalChannelMessageSignedBytes(bad), bad).toThrow(/64 lowercase hex/);
      expect(() => legacyChannelMessageSignedBytes(bad), bad).toThrow(/64 lowercase hex/);
    }
  });

  test("signedBytes owns its entire buffer", async () => {
    const owns = (bytes: Uint8Array) =>
      bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength;
    expect(owns(prepareChannelMessageSigningInput(unsigned).signedBytes)).toBe(true);
    expect(owns(canonicalChannelMessageSignedBytes("ab".repeat(32)))).toBe(true);
    expect(owns(legacyChannelMessageSignedBytes("ab".repeat(32)))).toBe(true);
    let seen: Uint8Array | undefined;
    await admitChannelMessage(await produce(), context(), (input) => {
      seen = input.signedBytes;
      return verifier(input);
    }, CURRENT);
    expect(seen !== undefined && owns(seen)).toBe(true);
  });
});
