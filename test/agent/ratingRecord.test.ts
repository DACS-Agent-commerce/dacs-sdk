import { describe, expect, it, vi } from "vitest";

import {
  RATING_SEPARATOR,
  isRatingRecord,
  verifyComponentSignature,
} from "../../src/artifacts/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  createBuyerRatingRecord,
  createSellerRatingRecord,
  type CreateRatingRecordInput,
} from "../../src/agent/ratingRecord.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 31));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 32));
const BUYER_PRIVATE = privateKeyFromSeed(BUYER_SEED);
const SELLER_PRIVATE = privateKeyFromSeed(SELLER_SEED);
const BUYER_PUBLIC = rawPublicKey(publicKeyFromSeed(BUYER_SEED));
const SELLER_PUBLIC = rawPublicKey(publicKeyFromSeed(SELLER_SEED));
const BUYER = `did:demos:agent:${Buffer.from(BUYER_PUBLIC).toString("hex")}`;
const SELLER = `did:demos:agent:${Buffer.from(SELLER_PUBLIC).toString("hex")}`;

function input(overrides: Partial<CreateRatingRecordInput> = {}): CreateRatingRecordInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    value: 5,
    freeText: "Fast and accurate.",
    dimensions: { timeliness: 5, communication: 4.5 },
    ratedAt: 1_780_358_520_000,
    ...overrides,
  };
}

const buyerSigner = {
  algorithm: "ed25519" as const,
  sign: (bytes: Uint8Array) => ed25519Sign(bytes, BUYER_PRIVATE),
};
const sellerSigner = {
  algorithm: "ed25519" as const,
  sign: (bytes: Uint8Array) => ed25519Sign(bytes, SELLER_PRIVATE),
};

async function signatureStatus(
  record: Awaited<ReturnType<typeof createBuyerRatingRecord>>,
) {
  const expectedPublicKey = record.rater === BUYER ? BUYER_PUBLIC : SELLER_PUBLIC;
  return verifyComponentSignature(
    record as unknown as Record<string, unknown>,
    RATING_SEPARATOR,
    {
      isSignerAuthorized: (artifact, signature) =>
        signature.signer === artifact.rater,
      resolvePublicKey: (signature) =>
        signature.signer === record.rater ? expectedPublicKey : null,
      verify: ({ signedBytes, signature, publicKey }) =>
        ed25519Verify(
          signedBytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(publicKey),
        ),
    },
  );
}

describe("DACS-5 RatingRecord production", () => {
  it("produces and verifies the buyer-to-seller direction", async () => {
    const record = await createBuyerRatingRecord(input(), buyerSigner);

    expect(record).toMatchObject({
      ratingVersion: "1",
      jobId: JOB_ID,
      rater: BUYER,
      target: SELLER,
      targetRole: "seller",
      value: 5,
      ratedAt: 1_780_358_520_000,
      signature: { algorithm: "ed25519", signer: BUYER },
    });
    expect(isRatingRecord(record)).toBe(true);
    await expect(signatureStatus(record)).resolves.toMatchObject({ status: "valid" });
  });

  it("produces and verifies the seller-to-buyer direction", async () => {
    const record = await createSellerRatingRecord(input({ value: 4 }), sellerSigner);

    expect(record).toMatchObject({
      rater: SELLER,
      target: BUYER,
      targetRole: "buyer",
      value: 4,
      signature: { signer: SELLER },
    });
    expect(isRatingRecord(record)).toBe(true);
    await expect(signatureStatus(record)).resolves.toMatchObject({ status: "valid" });
  });

  it.each([0, 6, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects RT-1 value %s before invoking the signer",
    async (value) => {
      const sign = vi.fn(buyerSigner.sign);
      await expect(
        createBuyerRatingRecord(input({ value }), {
          algorithm: "ed25519",
          sign,
        }),
      ).rejects.toThrow(/value|stable canonical JSON/);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it("rejects oversized text and non-finite dimensions before signing", async () => {
    const sign = vi.fn(buyerSigner.sign);
    await expect(
      createBuyerRatingRecord(input({ freeText: "x".repeat(1_001) }), {
        algorithm: "ed25519",
        sign,
      }),
    ).rejects.toThrow(/freeText/);
    await expect(
      createBuyerRatingRecord(input({ dimensions: { quality: Infinity } }), {
        algorithm: "ed25519",
        sign,
      }),
    ).rejects.toThrow(/stable canonical JSON|dimensions/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("rejects self-rating and non-canonical role claims before signing", async () => {
    const sign = vi.fn(buyerSigner.sign);
    await expect(
      createBuyerRatingRecord(input({ seller: BUYER }), {
        algorithm: "ed25519",
        sign,
      }),
    ).rejects.toThrow(/same session party/);
    await expect(
      createBuyerRatingRecord(input({ buyer: BUYER.toUpperCase() }), {
        algorithm: "ed25519",
        sign,
      }),
    ).rejects.toThrow(/canonical ClaimReference/);
    expect(sign).not.toHaveBeenCalled();
  });

  it.each(["rating-job", JOB_ID.toLowerCase(), ` ${JOB_ID}`])(
    "rejects non-canonical RatingRecord jobId %s before signing",
    async (jobId) => {
      const sign = vi.fn(buyerSigner.sign);
      await expect(
        createBuyerRatingRecord(input({ jobId }), {
          algorithm: "ed25519",
          sign,
        }),
      ).rejects.toThrow(/canonical uppercase ULID/);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it("rejects caller-added authority fields before signing", async () => {
    const sign = vi.fn(buyerSigner.sign);
    await expect(
      createBuyerRatingRecord(
        { ...input(), rater: SELLER } as CreateRatingRecordInput,
        { algorithm: "ed25519", sign },
      ),
    ).rejects.toThrow(/unexpected fields/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("owns the exact input before an asynchronous wallet can observe mutation", async () => {
    const value = input();
    let release!: (signature: Uint8Array) => void;
    const sign = vi.fn((bytes: Uint8Array) =>
      new Promise<Uint8Array>((resolve) => {
        release = resolve;
        queueMicrotask(() => release(ed25519Sign(bytes, BUYER_PRIVATE)));
      })
    );
    const pending = createBuyerRatingRecord(value, {
      algorithm: "ed25519",
      sign,
    });
    value.value = 1;
    value.freeText = "mutated";
    value.dimensions!.timeliness = 1;

    const record = await pending;
    expect(record.value).toBe(5);
    expect(record.freeText).toBe("Fast and accurate.");
    expect(record.dimensions).toEqual({ timeliness: 5, communication: 4.5 });
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("uses one strict validator for signer, role, shape, and RT-1 failures", async () => {
    const valid = await createBuyerRatingRecord(input(), buyerSigner);
    expect(isRatingRecord({ ...valid, extra: true })).toBe(false);
    expect(isRatingRecord({
      ...valid,
      signature: { ...valid.signature, signer: SELLER },
    })).toBe(false);
    expect(isRatingRecord({ ...valid, targetRole: "orchestrator" })).toBe(false);
    // Target-role/session relabelling is structurally valid only when it names
    // buyer or seller; verifyBundleCore/finalization bind that label to parties[].
    expect(isRatingRecord({ ...valid, targetRole: "buyer" })).toBe(true);
    expect(isRatingRecord({ ...valid, target: BUYER })).toBe(false);
    expect(isRatingRecord({ ...valid, value: 3.5 })).toBe(false);
    expect(isRatingRecord({ ...valid, freeText: "x".repeat(1_001) })).toBe(false);
    expect(isRatingRecord({ ...valid, dimensions: { quality: NaN } })).toBe(false);
    expect(isRatingRecord({ ...valid, jobId: "rating-job" })).toBe(false);
  });
});
