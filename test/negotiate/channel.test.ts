import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import {
  admitChannelMessage,
  ed25519Verify,
  publicKeyFromRaw,
  prepareChannelMessageSigningInput,
  type ChannelAdmissionContext,
  type ChannelMessageSignatureVerifier,
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
      const result = await admitChannelMessage(
        vector.message,
        vector.ctx,
        verifyStandardVectorSignature,
      );
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
      const result = await admitChannelMessage(
        candidate,
        ctx,
        verifyStandardVectorSignature,
      );
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

    const result = await admitChannelMessage(candidate, context(), verifier);
    candidate.body = { changed: true };

    expect(result.decision).toBe("pass");
    if (result.decision === "pass") {
      expect(result.message.body).toEqual({
        nested: { signature: "this-is-body-data" },
      });
    }
    expect(verifier).toHaveBeenCalledOnce();
  });

  test("prepares the same immutable digest for a producer without choosing signature framing", () => {
    const candidate = {
      channelId: CHANNEL,
      sequence: 1,
      sender: SENDER,
      sentAt: 1_750_000_000_000,
      type: "offer",
      body: { nested: { signature: "ordinary-body-data" } },
    };
    const prepared = prepareChannelMessageSigningInput(candidate);
    candidate.body = { nested: { signature: "changed-after-capture" } };

    expect(prepared.envelopeHash).toBe(
      "a000b81119271adcdca85ce626df36862fa2bb6b8c3aba2a477837b77023aa22",
    );
    expect(prepared.unsignedEnvelope.body).toEqual({
      nested: { signature: "ordinary-body-data" },
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.unsignedEnvelope.body)).toBe(true);
    expect(() => prepareChannelMessageSigningInput({
      ...candidate,
      signature: "must-not-be-present-yet",
    })).toThrow(/omit signature/);
    expect(() => prepareChannelMessageSigningInput({
      ...candidate,
      transportRouting: "outside-the-signed-envelope",
    })).toThrow(/malformed/);
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
      admitChannelMessage(accessor, context(), verifier),
    ).resolves.toMatchObject({ decision: "error" });
    await expect(
      admitChannelMessage(new Proxy(message(), {}), context(), verifier),
    ).resolves.toMatchObject({ decision: "error" });
    await expect(
      admitChannelMessage(sparse, context(), verifier),
    ).resolves.toMatchObject({ decision: "error" });
    expect(verifier).not.toHaveBeenCalled();
  });

  test("does not invoke signature verification for replay failures", async () => {
    const verifier = vi.fn<ChannelMessageSignatureVerifier>(() => "pass");
    const result = await admitChannelMessage(message(), context(1), verifier);
    expect(result.decision).toBe("fail");
    expect(verifier).not.toHaveBeenCalled();
  });
});
